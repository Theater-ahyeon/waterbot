import { randomUUID } from 'node:crypto'

import type { Message } from '@earendil-works/pi-ai'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { recordUsage, totalTokens, usageForConversation, usageForProfile, Usage } from './usage'

const assistant = (input: number, output: number, costUsd: number): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text: '好的' }],
  api: 'openai-completions',
  provider: 'magpie',
  model: 'antigravity/gemini-3.8-flash',
  usage: {
    input, output, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
  },
  stopReason: 'stop',
  timestamp: 1,
}) as Message

describe('模型用量与预算（真实 PostgreSQL）', () => {
  let db: TestDatabase
  let profileId: string

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
  })

  beforeEach(async () => {
    await db.pool.query('delete from model_usage')
    await db.pool.query('delete from conversation_binding')
    await db.pool.query('delete from job')
    await db.pool.query('delete from dispatch_outbox')
    await db.pool.query('delete from inbound_event')
    profileId = randomUUID()
    await db.pool.query(
      'insert into profile(id, name, instructions) values ($1, $2, $3)',
      [profileId, '用量测试', '测试'],
    )
  })

  afterAll(async () => {
    await db?.dispose()
  })

  it('同一 entry 重复写入只记一次', async () => {
    const input = {
      profileId,
      conversationKey: 'profile:test:owner',
      entryId: 'entry-1',
      model: [assistant(10, 5, 0.001)],
      provider: 'magpie',
      modelId: 'antigravity/gemini-3.8-flash',
    }
    expect(await recordUsage(db.pool, input)).toBe(1)
    expect(await recordUsage(db.pool, input)).toBe(0)
    const rows = await db.pool.query('select * from model_usage')
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0]).toMatchObject({ input_tokens: '10', output_tokens: '5', reasoning_tokens: '3' })
  })

  it('按会话和日期汇总 token 与费用', async () => {
    await recordUsage(db.pool, {
      profileId, conversationKey: 'k', entryId: 'a', model: [assistant(10, 5, 0.001)],
      provider: 'magpie', modelId: 'm',
    })
    await recordUsage(db.pool, {
      profileId, conversationKey: 'k', entryId: 'b', model: [assistant(20, 7, 0.002)],
      provider: 'magpie', modelId: 'm',
    })
    const totals = await usageForConversation(db.pool, 'k', new Date(Date.now() - 60_000))
    expect(totals).toEqual({ input: 30, output: 12, cacheRead: 4, cacheWrite: 2, reasoning: 6, costUsd: 0.003 })
    expect(totalTokens(totals)).toBe(42)
    const days = await usageForProfile(db.pool, profileId, new Date(Date.now() - 60_000))
    expect(days).toHaveLength(1)
    expect(days[0]!.input).toBe(30)
    const service = new Usage(db.pool)
    expect((await service.conversation('k', new Date(Date.now() - 60_000))).output).toBe(12)
  })

  it('没有 assistant 用量时不写记录', async () => {
    expect(await recordUsage(db.pool, {
      profileId, conversationKey: 'k', entryId: 'empty', model: [],
      provider: 'magpie', modelId: 'm',
    })).toBe(0)
    expect((await db.pool.query('select count(*)::int as n from model_usage')).rows[0].n).toBe(0)
  })
})
