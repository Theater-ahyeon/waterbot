import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineTool } from '@earendil-works/pi-durable'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../../test/integration/database'
import { waitForFile } from '../../test/helpers/proc'
import { ingestInboundEvent } from '../inbound/ingest'
import { createEchoTool, openRuntime, type AgentRuntime } from '../runtime'
import {
  claimNext,
  dispatchOnce,
  releaseClaim,
  saveMapping,
  type Claim,
} from './dispatcher'

const CONTEXT = BACKGROUND_CONTEXT

/** 每个用例一个独立目标会话，避免共享 pending 记录互相干扰。 */
const keyFor = (name: string): string => `owner:${name}`

function scripted(): ReturnType<typeof fauxAssistantMessage>[] {
  return [
    fauxAssistantMessage([fauxToolCall('echo', { text: 'hi' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]
}

async function waitForLeaseExpiry(pool: TestDatabase['pool'], outboxId: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const { rows } = await pool.query<{ expired: boolean }>(
      'select (lease_until is not null and lease_until < now()) as expired from dispatch_outbox where id = $1',
      [outboxId],
    )
    if (rows[0]?.expired) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`outbox ${outboxId} 租约未在预期时间内过期`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

describe('dispatcher 与真实 Pi 派发', () => {
  let db: TestDatabase
  let dir = ''
  let runtime: AgentRuntime | undefined

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-dispatch-'))
  })

  afterEach(async () => {
    await runtime?.close()
    runtime = undefined
  })

  afterAll(async () => {
    await db.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('只做受理：长任务还在跑就已经保存映射', async () => {
    const key = keyFor('accept')
    let releaseTool: () => void = () => undefined
    const gate = new Promise<void>((resolveGate) => {
      releaseTool = resolveGate
    })

    const blockingTool = defineTool({
      name: 'blocker',
      description: 'Blocks until the test releases it.',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async () => {
        await gate
        return { output: [{ type: 'text', text: 'unblocked' }] }
      },
    })

    runtime = await openRuntime({
      databasePath: join(dir, 'pi-accept.sqlite'),
      tools: [blockingTool],
      conversationKey: key,
      responses: [
        fauxAssistantMessage([fauxToolCall('blocker', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ],
    })

    const { outbox } = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'accept-1',
      payload: { message: 'run it' },
      conversationKey: key,
    })

    try {
      const outcome = await dispatchOnce({
        pool: db.pool,
        runtime,
        owner: 'dispatcher-a',
        conversationKey: key,
      })

      expect(outcome.kind).toBe('accepted')
      if (outcome.kind !== 'accepted') {
        throw new Error('unreachable')
      }
      expect(outcome.reused).toBe(false)

      // 派发已经返回，但模型回合仍卡在工具里：受理与执行是分开的
      const inspection = await runtime.harness.inspect(CONTEXT)
      expect(inspection.tasks.length).toBeGreaterThan(0)

      const job = await db.pool.query<{
        pi_status: string
        status: string
        pi_submission_id: string
      }>('select * from job where dispatch_outbox_id = $1', [outbox.id])
      expect(job.rows[0]?.pi_submission_id).toBe(outcome.submissionId)
      expect(job.rows[0]?.pi_status).toBe('accepted')
      expect(job.rows[0]?.status).toBe('dispatched')

      releaseTool()
      await runtime.conversation.waitForIdle(CONTEXT)

      const view = await runtime.conversation.context(CONTEXT)
      expect(view.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)

      const again = await dispatchOnce({
        pool: db.pool,
        runtime,
        owner: 'dispatcher-a',
        conversationKey: key,
      })
      expect(again.kind).toBe('idle')
    } finally {
      releaseTool()
    }
  }, 120_000)

  it('并发 claim 只有一方拿到同一条记录', async () => {
    const key = keyFor('claim')
    const { outbox } = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'claim-1',
      payload: { message: 'race' },
      conversationKey: key,
    })

    const [first, second] = await Promise.all([
      claimNext(db.pool, { owner: 'dispatcher-a', conversationKey: key }),
      claimNext(db.pool, { owner: 'dispatcher-b', conversationKey: key }),
    ])

    const claimed = [first, second].filter((claim) => claim !== null)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.outbox.id).toBe(outbox.id)
    expect(claimed[0]?.attempts).toBe(1)
  })

  it('租约未过期不能再抢，过期后可重新领取且 attempts 递增', async () => {
    const key = keyFor('lease')
    const { outbox } = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'lease-1',
      payload: { message: 'lease' },
      conversationKey: key,
    })

    const first = await claimNext(db.pool, {
      owner: 'dispatcher-a',
      conversationKey: key,
      leaseMs: 300,
    })
    expect(first?.outbox.id).toBe(outbox.id)
    expect(first?.attempts).toBe(1)

    expect(await claimNext(db.pool, { owner: 'dispatcher-b', conversationKey: key })).toBeNull()

    await waitForLeaseExpiry(db.pool, outbox.id)

    const reclaimed = await claimNext(db.pool, {
      owner: 'dispatcher-b',
      conversationKey: key,
      leaseMs: 5000,
    })
    expect(reclaimed?.outbox.id).toBe(outbox.id)
    expect(reclaimed?.attempts).toBe(2)
    expect(reclaimed?.outbox.lease_owner).toBe('dispatcher-b')
  })

  it('过期后的旧 worker 不能写回新领取的记录', async () => {
    const key = keyFor('fence')
    const { outbox } = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'fence-1',
      payload: { message: 'fence' },
      conversationKey: key,
    })

    const stale = (await claimNext(db.pool, {
      owner: 'dispatcher-a',
      conversationKey: key,
      leaseMs: 300,
    })) as Claim
    expect(stale).not.toBeNull()

    await waitForLeaseExpiry(db.pool, outbox.id)

    const fresh = await claimNext(db.pool, {
      owner: 'dispatcher-b',
      conversationKey: key,
      leaseMs: 5000,
    })
    expect(fresh?.attempts).toBe(2)

    // 旧尝试拿着过期凭据写回：必须失败，且不产生 job
    const staleSaved = await saveMapping(db.pool, {
      claim: stale,
      piConversationId: '1',
      submissionId: '999',
      piStatus: 'accepted',
    })
    expect(staleSaved).toBe(false)

    const jobsAfterStale = await db.pool.query('select 1 from job where dispatch_outbox_id = $1', [
      outbox.id,
    ])
    expect(jobsAfterStale.rowCount).toBe(0)

    const outboxAfterStale = await db.pool.query<{ status: string; lease_owner: string | null }>(
      'select status, lease_owner from dispatch_outbox where id = $1',
      [outbox.id],
    )
    expect(outboxAfterStale.rows[0]).toEqual({ status: 'pending', lease_owner: 'dispatcher-b' })

    // 新领取的尝试可以正常写回
    const freshSaved = await saveMapping(db.pool, {
      claim: fresh as Claim,
      piConversationId: '1',
      submissionId: '1000',
      piStatus: 'accepted',
    })
    expect(freshSaved).toBe(true)

    const job = await db.pool.query<{ pi_submission_id: string }>(
      'select pi_submission_id from job where dispatch_outbox_id = $1',
      [outbox.id],
    )
    expect(job.rows[0]?.pi_submission_id).toBe('1000')
  })

  it('过期后的旧 worker 不能释放新领取的租约', async () => {
    const key = keyFor('fence-release')
    const { outbox } = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'fence-release',
      payload: { message: 'fence release' },
      conversationKey: key,
    })

    const stale = (await claimNext(db.pool, {
      owner: 'dispatcher-a',
      conversationKey: key,
      leaseMs: 300,
    })) as Claim

    await waitForLeaseExpiry(db.pool, outbox.id)
    const fresh = await claimNext(db.pool, {
      owner: 'dispatcher-b',
      conversationKey: key,
      leaseMs: 5000,
    })
    expect(fresh?.attempts).toBe(2)

    const released = await releaseClaim(db.pool, stale, 'stale worker error', 5)
    expect(released).toBe(false)

    const row = await db.pool.query<{
      status: string
      lease_owner: string | null
      last_error: string | null
    }>('select status, lease_owner, last_error from dispatch_outbox where id = $1', [outbox.id])
    expect(row.rows[0]).toEqual({
      status: 'pending',
      lease_owner: 'dispatcher-b',
      last_error: null,
    })
  })

  it('只领取本 dispatcher 绑定的会话，其他目标保持 pending', async () => {
    const key = keyFor('target-a')
    const other = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'other-target',
      payload: { message: 'other' },
      conversationKey: keyFor('target-b'),
    })

    runtime = await openRuntime({
      databasePath: join(dir, 'pi-target.sqlite'),
      tools: [createEchoTool()],
      responses: scripted(),
      conversationKey: key,
    })

    const outcome = await dispatchOnce({
      pool: db.pool,
      runtime,
      owner: 'dispatcher-a',
      conversationKey: key,
    })
    expect(outcome.kind).toBe('idle')

    const row = await db.pool.query<{ status: string; attempts: number }>(
      'select status, attempts from dispatch_outbox where id = $1',
      [other.outbox.id],
    )
    expect(row.rows[0]).toEqual({ status: 'pending', attempts: 0 })

    const jobs = await db.pool.query('select 1 from job where dispatch_outbox_id = $1', [
      other.outbox.id,
    ])
    expect(jobs.rowCount).toBe(0)
  })

  it('目标与 runtime 绑定不一致时直接拒绝派发', async () => {
    runtime = await openRuntime({
      databasePath: join(dir, 'pi-mismatch.sqlite'),
      tools: [createEchoTool()],
      responses: scripted(),
      conversationKey: keyFor('mismatch'),
    })

    await expect(
      dispatchOnce({
        pool: db.pool,
        runtime,
        owner: 'dispatcher-a',
        conversationKey: keyFor('other'),
      }),
    ).rejects.toThrow(/不一致/)
  })

  it('派发失败释放租约、记录错误，达到上限后标记 failed', async () => {
    const key = keyFor('fail')
    const { outbox } = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'fail-1',
      payload: { message: 'fail' },
      conversationKey: key,
    })

    const brokenRuntime = {
      conversation: { id: 1 },
      conversationKey: key,
      accept: async () => {
        throw new Error('pi down')
      },
    } as unknown as AgentRuntime

    const first = await dispatchOnce({
      pool: db.pool,
      runtime: brokenRuntime,
      owner: 'dispatcher-a',
      conversationKey: key,
      maxAttempts: 2,
    })
    expect(first).toMatchObject({ kind: 'failed', willRetry: true, error: 'pi down' })

    const afterFirst = await db.pool.query<{
      status: string
      lease_owner: string | null
      last_error: string | null
    }>('select status, lease_owner, last_error from dispatch_outbox where id = $1', [outbox.id])
    expect(afterFirst.rows[0]).toEqual({
      status: 'pending',
      lease_owner: null,
      last_error: 'pi down',
    })

    const second = await dispatchOnce({
      pool: db.pool,
      runtime: brokenRuntime,
      owner: 'dispatcher-b',
      conversationKey: key,
      maxAttempts: 2,
    })
    expect(second).toMatchObject({ kind: 'failed', willRetry: false })

    const afterSecond = await db.pool.query<{ status: string; attempts: number }>(
      'select status, attempts from dispatch_outbox where id = $1',
      [outbox.id],
    )
    expect(afterSecond.rows[0]).toEqual({ status: 'failed', attempts: 2 })

    const jobs = await db.pool.query('select 1 from job where dispatch_outbox_id = $1', [outbox.id])
    expect(jobs.rowCount).toBe(0)
  })

  it('会话忙时按 reject 策略拒绝，稍后可重试成功', async () => {
    const key = keyFor('busy')
    let releaseTool: () => void = () => undefined
    const gate = new Promise<void>((resolveGate) => {
      releaseTool = resolveGate
    })
    const marker = join(dir, 'busy-tool.marker')

    const blockingTool = defineTool({
      name: 'blocker',
      description: 'Blocks until released, writing a marker first.',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async () => {
        await writeFile(marker, '1', 'utf8')
        await gate
        return { output: [{ type: 'text', text: 'unblocked' }] }
      },
    })

    runtime = await openRuntime({
      databasePath: join(dir, 'pi-busy.sqlite'),
      tools: [blockingTool],
      conversationKey: key,
      responses: [
        fauxAssistantMessage([fauxToolCall('blocker', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('first done'),
        fauxAssistantMessage('second done'),
      ],
    })

    try {
      // 受理一路“占位”输入，工具真的开始跑（marker 是受控同步点），会话确定处于忙状态
      await runtime.accept({ content: 'hold the conversation', requestId: 'busy-hold' })
      await waitForFile(marker, 20_000)

      const busyEvent = await ingestInboundEvent(db.pool, {
        source: 'qq',
        externalId: 'busy-1',
        payload: { message: 'second' },
        conversationKey: key,
      })

      const rejected = await dispatchOnce({
        pool: db.pool,
        runtime,
        owner: 'dispatcher-a',
        conversationKey: key,
        whenBusy: 'reject',
      })
      expect(rejected).toMatchObject({
        kind: 'failed',
        error: 'conversation_busy',
        willRetry: true,
      })

      const busyRow = await db.pool.query<{ status: string; last_error: string }>(
        'select status, last_error from dispatch_outbox where id = $1',
        [busyEvent.outbox.id],
      )
      expect(busyRow.rows[0]).toEqual({
        status: 'pending',
        last_error: 'conversation_busy',
      })

      releaseTool()
      await runtime.conversation.waitForIdle(CONTEXT)

      const retried = await dispatchOnce({
        pool: db.pool,
        runtime,
        owner: 'dispatcher-a',
        conversationKey: key,
      })
      expect(retried.kind).toBe('accepted')
    } finally {
      releaseTool()
    }
  }, 120_000)
})
