import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'

import { killAllProcs, startProc, waitForFile } from '../../test/helpers/proc'
import { createTestDatabase, type TestDatabase } from '../../test/integration/database'
import { ingestInboundEvent } from '../inbound/ingest'
import { createEchoTool, openRuntime, type AgentRuntime } from '../runtime'
import { dispatchOnce } from './dispatcher'

const CONTEXT = BACKGROUND_CONTEXT
const KEY = 'owner:default'
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE = join(SERVER_ROOT, 'test/fixtures/dispatch-child.ts')

async function waitForLeaseExpiry(pool: TestDatabase['pool'], outboxId: string): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const { rows } = await pool.query<{ expired: boolean }>(
      'select (lease_until is not null and lease_until < now()) as expired from dispatch_outbox where id = $1',
      [outboxId],
    )
    if (rows[0]?.expired) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error('outbox 租约未在预期时间内过期')
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

describe('两库崩溃窗口：Pi 已受理但 PG 映射未保存', () => {
  let db: TestDatabase
  let dir = ''
  let runtime: AgentRuntime | undefined

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
  })

  afterEach(async () => {
    await killAllProcs()
    await runtime?.close()
    runtime = undefined
    if (dir) {
      await rm(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  afterAll(async () => {
    await db.dispose()
  })

  it('重启后用同一 requestId 补投，拿到原 submission，不重复用户输入与工具效果', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-crash-'))
    const piDb = join(dir, 'pi.sqlite')

    const { outbox } = await ingestInboundEvent(db.pool, {
      source: 'qq',
      externalId: 'crash-1',
      payload: { message: 'hello' },
      conversationKey: 'owner:default',
    })

    const child = startProc({
      entry: FIXTURE,
      cwd: SERVER_ROOT,
      env: { PA_PG_URL: db.url, PA_PI_DB: piDb, PA_DIR: dir },
    })

    await waitForFile(join(dir, 'accepted.marker'), 60_000)
    const accepted = JSON.parse(
      await readFile(join(dir, 'accepted.json'), 'utf8'),
    ) as { submissionId: string }

    await child.kill()

    // 崩溃点：Pi 已有提交，PG 还没有 job 映射
    const midway = await db.pool.query<{ status: string; attempts: number; lease_owner: string | null }>(
      'select status, attempts, lease_owner from dispatch_outbox where id = $1',
      [outbox.id],
    )
    expect(midway.rows[0]).toEqual({
      status: 'pending',
      attempts: 1,
      lease_owner: 'child-dispatcher',
    })
    const jobsBefore = await db.pool.query('select 1 from job where dispatch_outbox_id = $1', [
      outbox.id,
    ])
    expect(jobsBefore.rowCount).toBe(0)

    // 重启：等租约过期后重新 claim，用同一个 requestId 补投
    await waitForLeaseExpiry(db.pool, outbox.id)

    runtime = await openRuntime({
      databasePath: piDb,
      tools: [createEchoTool()],
      conversationKey: KEY,
      // 故意不给任何脚本应答：若补投被当成新请求，Pi 会走模型并新增用户输入
      responses: [],
    })

    const outcome = await dispatchOnce({
      pool: db.pool,
      runtime,
      owner: 'parent-dispatcher',
      conversationKey: KEY,
      leaseMs: 5_000,
    })

    expect(outcome.kind).toBe('accepted')
    if (outcome.kind !== 'accepted') {
      throw new Error('unreachable')
    }
    // 同一个 submission：证明 Pi 端按 requestId 去重，没有第二条用户输入
    expect(outcome.submissionId).toBe(accepted.submissionId)
    expect(outcome.reused).toBe(false)

    await runtime.conversation.waitForIdle(CONTEXT)

    const finalOutbox = await db.pool.query<{ status: string; attempts: number }>(
      'select status, attempts from dispatch_outbox where id = $1',
      [outbox.id],
    )
    expect(finalOutbox.rows[0]).toEqual({ status: 'dispatched', attempts: 2 })

    const jobs = await db.pool.query<{ pi_submission_id: string; status: string }>(
      'select pi_submission_id, status from job where dispatch_outbox_id = $1',
      [outbox.id],
    )
    expect(jobs.rows).toHaveLength(1)
    expect(jobs.rows[0]?.pi_submission_id).toBe(accepted.submissionId)
    expect(jobs.rows[0]?.status).toBe('dispatched')

    const view = await runtime.conversation.context(CONTEXT)
    expect(view.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
    expect(view.entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(1)
    const userText = JSON.stringify(view.entries.find((entry) => entry.kind === 'pi.user')?.model)
    expect(userText).toContain('hello')
  }, 180_000)
})
