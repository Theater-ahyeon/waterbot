import { createHash } from 'node:crypto'

import { ConversationBusy } from '@earendil-works/pi-durable'

import type { OutboxRow } from '../inbound/ingest'
import type { Pool } from '../pg/connection'
import { withTransaction } from '../pg/connection'
import type { AgentRuntime } from '../runtime'

export const DEFAULT_LEASE_MS = 30_000
export const DEFAULT_MAX_ATTEMPTS = 5

export interface JobRow {
  id: string
  dispatch_outbox_id: string
  pi_conversation_id: string
  pi_submission_id: string
  pi_status: string | null
  status: 'dispatched' | 'completed' | 'failed'
  created_at: Date
  updated_at: Date
}

/**
 * 一次 claim 的完整凭据：owner 只是身份，attempts 才是 fencing token。
 * 每次 claim 都会把 attempts 加一，过期后重新领取的行 attempts 必然更大，
 * 于是旧 worker 的写回条件全部失配。
 */
export interface Claim {
  outbox: OutboxRow
  owner: string
  attempts: number
  conversationKey: string
}

export interface ClaimOptions {
  owner: string
  /** dispatcher 绑定的唯一目标会话；只领取这一条路由的记录 */
  conversationKey: string
  leaseMs?: number
}

export async function claimNext(
  pool: Pool,
  options: ClaimOptions,
): Promise<Claim | null> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS

  const { rows } = await pool.query<OutboxRow>(
    `update dispatch_outbox as o
        set lease_owner = $1,
            lease_until = now() + ($3::int * interval '1 millisecond'),
            attempts = o.attempts + 1,
            updated_at = now()
      where o.id = (
        select id
          from dispatch_outbox
         where status = 'pending'
           and conversation_key = $2
           and (lease_until is null or lease_until < now())
         order by created_at, id
         for update skip locked
         limit 1
      )
      returning *`,
    [options.owner, options.conversationKey, leaseMs],
  )

  const outbox = rows[0]
  if (!outbox) {
    return null
  }

  return {
    outbox,
    owner: options.owner,
    attempts: outbox.attempts,
    conversationKey: options.conversationKey,
  }
}

export class LeaseLostError extends Error {
  constructor(outboxId: string) {
    super(`outbox ${outboxId} 的租约已失效（过期或被重新领取）`)
    this.name = 'LeaseLostError'
  }
}

/** 只有本次 claim 仍持有有效租约时才能写回。 */
function ownedWhere(): string {
  return `id = $1
      and status = 'pending'
      and lease_owner = $2
      and attempts = $3
      and lease_until is not null
      and lease_until > now()`
}

export interface SaveMappingInput {
  claim: Claim
  piConversationId: string
  submissionId: string
  piStatus: string
}

/**
 * 写入 Pi 映射并把 outbox 标成 dispatched，条件包含本次 claim 的 attempts 与租约有效期。
 * 返回 false 表示租约已经不属于这次 claim（旧 worker 不得写回）。
 */
export async function saveMapping(
  pool: Pool,
  input: SaveMappingInput,
): Promise<boolean> {
  const { claim } = input
  const jobId = jobIdFor(claim.outbox.request_id)

  try {
    await withTransaction(pool, async (client) => {
      const owned = await client.query(
        `update dispatch_outbox
            set status = 'dispatched', lease_owner = null, lease_until = null,
                last_error = null, updated_at = now()
          where ${ownedWhere()}
          returning id`,
        [claim.outbox.id, claim.owner, claim.attempts],
      )

      if (owned.rowCount !== 1) {
        throw new LeaseLostError(claim.outbox.id)
      }

      await client.query(
        `insert into job (id, dispatch_outbox_id, pi_conversation_id, pi_submission_id, pi_status)
         values ($1, $2, $3, $4, $5)
         on conflict (dispatch_outbox_id) do update
           set pi_status = excluded.pi_status, updated_at = now()`,
        [jobId, claim.outbox.id, input.piConversationId, input.submissionId, input.piStatus],
      )
    })

    return true
  } catch (error) {
    if (error instanceof LeaseLostError) {
      return false
    }
    throw error
  }
}

/**
 * 失败释放：同样要匹配 owner + attempts + 未过期，
 * 否则旧 worker 会把新 worker 刚拿到的租约清掉。
 */
export async function releaseClaim(
  pool: Pool,
  claim: Claim,
  error: string,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<boolean> {
  const { rows } = await pool.query<{ status: OutboxRow['status'] }>(
    `update dispatch_outbox
        set lease_owner = null,
            lease_until = null,
            last_error = $4,
            updated_at = now(),
            status = case when attempts >= $5 then 'failed' else 'pending' end
      where ${ownedWhere()}
      returning status`,
    [claim.outbox.id, claim.owner, claim.attempts, error.slice(0, 500), maxAttempts],
  )

  return rows[0]?.status === 'pending'
}

export interface DispatchDeps {
  pool: Pool
  runtime: Pick<AgentRuntime, 'conversation' | 'conversationKey' | 'accept'>
  owner: string
  /** 必须与 runtime 绑定的目标会话一致，否则视为配置错误 */
  conversationKey: string
  leaseMs?: number
  maxAttempts?: number
  /** 忙碌时的显式策略；默认 reject，不把新意图偷偷塞进正在跑的回合 */
  whenBusy?: 'reject' | 'followUp' | 'steer'
  /**
   * 受控窗口：Pi 已受理、业务映射尚未写入时调用。
   * 生产为空；测试在这里杀进程，验证重启后不会重复派发。
   */
  afterSubmit?: (input: {
    outbox: OutboxRow
    submissionId: string
  }) => Promise<void> | void
}

export type DispatchOutcome =
  | { kind: 'idle' }
  | {
      kind: 'accepted'
      outboxId: string
      jobId: string
      submissionId: string
      piConversationId: string
      /** true 表示读到已有映射、没有再次受理 */
      reused: boolean
    }
  | { kind: 'failed'; outboxId: string; error: string; willRetry: boolean }

function jobIdFor(requestId: string): string {
  return `job_${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`
}

function messageOf(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'message' in payload) {
    const value = (payload as { message?: unknown }).message
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return JSON.stringify(payload ?? null)
}

export async function findJob(pool: Pool, outboxId: string): Promise<JobRow | undefined> {
  const { rows } = await pool.query<JobRow>('select * from job where dispatch_outbox_id = $1', [
    outboxId,
  ])
  return rows[0]
}

/**
 * 派发一条记录：claim → 真实 conversation.submit 受理 → 立刻保存映射。
 *
 * - 只做受理，不等模型 / 工具结算，长任务与审批不会拖住派发或拖过租约；
 * - 所有写回都带 attempts + 租约有效期条件，过期 worker 无法覆盖新结果；
 * - job 只记 Pi 提交与受理状态，完成由后续对账推进。
 */
export async function dispatchOnce(deps: DispatchDeps): Promise<DispatchOutcome> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  if (deps.conversationKey !== deps.runtime.conversationKey) {
    throw new Error(
      `dispatcher 目标 ${deps.conversationKey} 与 runtime 绑定的 ${deps.runtime.conversationKey} 不一致，拒绝派发`,
    )
  }

  const claim = await claimNext(deps.pool, {
    owner: deps.owner,
    conversationKey: deps.conversationKey,
    ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
  })

  if (!claim) {
    return { kind: 'idle' }
  }

  const piConversationId = String(deps.runtime.conversation.id)
  const existingJob = await findJob(deps.pool, claim.outbox.id)

  // 上次已写入映射（例如受理后崩溃在收尾阶段）：只补收尾，不再受理
  if (existingJob) {
    const saved = await saveMapping(deps.pool, {
      claim,
      piConversationId: existingJob.pi_conversation_id,
      submissionId: existingJob.pi_submission_id,
      piStatus: existingJob.pi_status ?? 'accepted',
    })

    if (!saved) {
      return { kind: 'failed', outboxId: claim.outbox.id, error: 'lease_lost', willRetry: false }
    }

    return {
      kind: 'accepted',
      outboxId: claim.outbox.id,
      jobId: existingJob.id,
      submissionId: existingJob.pi_submission_id,
      piConversationId: existingJob.pi_conversation_id,
      reused: true,
    }
  }

  const payloadRow = await deps.pool.query<{ payload: unknown }>(
    'select payload from inbound_event where id = $1',
    [claim.outbox.inbound_event_id],
  )

  let submissionId: string
  try {
    const submission = await deps.runtime.accept({
      content: messageOf(payloadRow.rows[0]?.payload),
      requestId: claim.outbox.request_id,
      whenBusy: deps.whenBusy ?? 'reject',
    })
    submissionId = String(submission.id)
  } catch (error) {
    const busy = error instanceof ConversationBusy
    const message = busy
      ? 'conversation_busy'
      : error instanceof Error
        ? error.message
        : String(error)
    const willRetry = await releaseClaim(deps.pool, claim, message, maxAttempts)
    return { kind: 'failed', outboxId: claim.outbox.id, error: message, willRetry }
  }

  await deps.afterSubmit?.({ outbox: claim.outbox, submissionId })

  const saved = await saveMapping(deps.pool, {
    claim,
    piConversationId,
    submissionId,
    piStatus: 'accepted',
  })

  if (!saved) {
    return { kind: 'failed', outboxId: claim.outbox.id, error: 'lease_lost', willRetry: false }
  }

  return {
    kind: 'accepted',
    outboxId: claim.outbox.id,
    jobId: jobIdFor(claim.outbox.request_id),
    submissionId,
    piConversationId,
    reused: false,
  }
}
