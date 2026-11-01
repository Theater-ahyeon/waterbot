import { createHash } from 'node:crypto'

import type { Pool } from '../pg/connection'
import { withTransaction } from '../pg/connection'

export interface InboundEventRow {
  id: string
  source: string
  external_id: string
  payload: unknown
  payload_hash: string
  received_at: Date
}

export interface OutboxRow {
  id: string
  inbound_event_id: string
  conversation_key: string
  request_id: string
  status: 'pending' | 'dispatched' | 'failed'
  attempts: number
  lease_owner: string | null
  lease_until: Date | null
  last_error: string | null
  created_at: Date
  updated_at: Date
}

export interface IngestInput {
  source: string
  externalId: string
  payload: unknown
  conversationKey: string
  /** 覆盖生成的 ID，测试用 */
  eventId?: string
  outboxId?: string
}

export interface IngestResult {
  event: InboundEventRow
  outbox: OutboxRow
  /** false 表示这次是重投，读到的是原记录 */
  created: boolean
}

/** 同一平台事件但内容不同：不能静默当作同一意图。 */
export class PayloadConflictError extends Error {
  constructor(
    readonly source: string,
    readonly externalId: string,
  ) {
    super(`事件 ${source}/${externalId} 已存在且 payload 不同，拒绝静默合并`)
    this.name = 'PayloadConflictError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function payloadHashOf(payload: unknown): string {
  return sha256(JSON.stringify(payload ?? null))
}

/**
 * 由「平台事件身份 + 目标会话」推导稳定 requestId。
 * 同一事件投给不同会话必须得到不同 requestId，否则 Pi 会把第二路投递当成重复。
 */
export function stableRequestId(
  source: string,
  externalId: string,
  conversationKey: string,
): string {
  return `req_${sha256(`${source}\u0000${externalId}\u0000${conversationKey}`).slice(0, 32)}`
}

function idFrom(prefix: string, seed: string): string {
  return `${prefix}_${sha256(seed).slice(0, 32)}`
}

/**
 * 同一事务：写入站事件 + 派发 outbox。
 *
 * - 首次投递：两条记录一起提交，不会出现“有事件没派发”；
 * - 重复投递：命中唯一约束后读取原记录，不新增 outbox；
 * - 同一身份不同 payload：抛 PayloadConflictError（调用方回 409），不静默覆盖。
 */
export async function ingestInboundEvent(
  pool: Pool,
  input: IngestInput,
): Promise<IngestResult> {
  const hash = payloadHashOf(input.payload)

  return withTransaction(pool, async (client) => {
    const eventId = input.eventId ?? idFrom('evt', `${input.source}\u0000${input.externalId}`)
    const outboxId =
      input.outboxId ?? idFrom('out', `${input.source}\u0000${input.externalId}\u0000${input.conversationKey}`)

    const inserted = await client.query<InboundEventRow>(
      `insert into inbound_event (id, source, external_id, payload, payload_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (source, external_id) do nothing
       returning *`,
      [eventId, input.source, input.externalId, JSON.stringify(input.payload ?? null), hash],
    )

    if (inserted.rowCount === 1) {
      const event = inserted.rows[0] as InboundEventRow
      const outbox = await client.query<OutboxRow>(
        `insert into dispatch_outbox (id, inbound_event_id, conversation_key, request_id)
         values ($1, $2, $3, $4)
         returning *`,
        [outboxId, event.id, input.conversationKey, stableRequestId(input.source, input.externalId, input.conversationKey)],
      )

      return { event, outbox: outbox.rows[0] as OutboxRow, created: true }
    }

    const existing = await client.query<InboundEventRow>(
      'select * from inbound_event where source = $1 and external_id = $2',
      [input.source, input.externalId],
    )
    const event = existing.rows[0]
    if (!event) {
      throw new Error('唯一约束冲突但读不到原事件')
    }

    if (event.payload_hash !== hash) {
      throw new PayloadConflictError(input.source, input.externalId)
    }

    const outboxExisting = await client.query<OutboxRow>(
      'select * from dispatch_outbox where inbound_event_id = $1 and conversation_key = $2',
      [event.id, input.conversationKey],
    )

    if (outboxExisting.rows[0]) {
      return { event, outbox: outboxExisting.rows[0], created: false }
    }

    // 同一事件投向另一个会话：新增一条 outbox，但复用同一个事件记录
    const createdOutbox = await client.query<OutboxRow>(
      `insert into dispatch_outbox (id, inbound_event_id, conversation_key, request_id)
       values ($1, $2, $3, $4)
       returning *`,
      [outboxId, event.id, input.conversationKey, stableRequestId(input.source, input.externalId, input.conversationKey)],
    )

    return { event, outbox: createdOutbox.rows[0] as OutboxRow, created: false }
  })
}
