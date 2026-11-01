import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../../test/integration/database'
import {
  ingestInboundEvent,
  PayloadConflictError,
  stableRequestId,
} from './ingest'

describe('入站事件事务与 outbox', () => {
  let db: TestDatabase

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
  })

  afterAll(async () => {
    await db.dispose()
  })

  it('首次投递在同一事务里写事件与 outbox', async () => {
    const result = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'msg-1',
      payload: { message: '你好' },
      conversationKey: 'owner:default',
    })

    expect(result.created).toBe(true)
    expect(result.outbox.request_id).toBe(
      stableRequestId('qq', 'msg-1', 'owner:default'),
    )
    expect(result.outbox.status).toBe('pending')
    expect(result.outbox.attempts).toBe(0)

    const counts = await db.pool.query<{ events: string; outbox: string }>(
      `select
         (select count(*)::text from inbound_event) as events,
         (select count(*)::text from dispatch_outbox) as outbox`,
    )
    expect(counts.rows[0]).toEqual({ events: '1', outbox: '1' })
  })

  it('同一事件投给不同会话时 requestId 与 outbox 都分开', async () => {
    const other = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'msg-1',
      payload: { message: '你好' },
      conversationKey: 'owner:other',
    })

    expect(other.created).toBe(false)
    expect(other.outbox.conversation_key).toBe('owner:other')
    expect(other.outbox.request_id).toBe(
      stableRequestId('qq', 'msg-1', 'owner:other'),
    )
    expect(other.outbox.request_id).not.toBe(
      stableRequestId('qq', 'msg-1', 'owner:default'),
    )

    const outboxCount = await db.pool.query<{ count: string }>(
      'select count(*)::text as count from dispatch_outbox',
    )
    expect(outboxCount.rows[0]?.count).toBe('2')
  })

  it('相同事件重投返回原记录，不再新增', async () => {
    const before = await db.pool.query<{ events: string; outbox: string }>(
      `select
         (select count(*)::text from inbound_event) as events,
         (select count(*)::text from dispatch_outbox) as outbox`,
    )

    const again = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'msg-1',
      payload: { message: '你好' },
      conversationKey: 'owner:default',
    })

    expect(again.created).toBe(false)
    expect(again.outbox.request_id).toBe(
      stableRequestId('qq', 'msg-1', 'owner:default'),
    )

    const after = await db.pool.query<{ events: string; outbox: string }>(
      `select
         (select count(*)::text from inbound_event) as events,
         (select count(*)::text from dispatch_outbox) as outbox`,
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('同一身份不同 payload 直接冲突，不静默覆盖', async () => {
    await expect(
      ingestInboundEvent(db.pool, {
        source: 'qq',
        externalId: 'msg-1',
        payload: { message: '改过的内容' },
        conversationKey: 'owner:default',
      }),
    ).rejects.toBeInstanceOf(PayloadConflictError)

    const row = await db.pool.query<{ payload: { message: string } }>(
      "select payload from inbound_event where external_id = 'msg-1'",
    )
    expect(row.rows[0]?.payload.message).toBe('你好')
  })

  it('outbox 写入失败时整个事务回滚，事件不会残留', async () => {
    const existing = await db.pool.query<{ id: string }>(
      'select id from dispatch_outbox limit 1',
    )
    const duplicatedOutboxId = existing.rows[0]?.id
    expect(duplicatedOutboxId).toBeDefined()

    await expect(
      ingestInboundEvent(db.pool, {
        source: 'qq',
        externalId: 'msg-2',
        payload: { message: 'second' },
        conversationKey: 'owner:default',
        outboxId: duplicatedOutboxId,
      }),
    ).rejects.toThrow()

    const leaked = await db.pool.query(
      "select 1 from inbound_event where external_id = 'msg-2'",
    )
    expect(leaked.rowCount).toBe(0)
  })

  it('并发重投同一事件只产生一条记录', async () => {
    const results = await Promise.all([
      ingestInboundEvent(db.pool, {
        source: 'qq',
        externalId: 'msg-race',
        payload: { message: 'race' },
        conversationKey: 'owner:default',
      }),
      ingestInboundEvent(db.pool, {
        source: 'qq',
        externalId: 'msg-race',
        payload: { message: 'race' },
        conversationKey: 'owner:default',
      }),
    ])

    expect(results.filter((result) => result.created)).toHaveLength(1)
    const count = await db.pool.query<{ count: string }>(
      "select count(*)::text as count from inbound_event where external_id = 'msg-race'",
    )
    expect(count.rows[0]?.count).toBe('1')
  })
})
