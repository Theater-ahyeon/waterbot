import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { createApp } from './app'
import { OwnerAuth } from './auth'
import { Chats } from './chat'
import { Profiles, type Profile } from './profiles'
import { Routines, type RoutineOccurrence, type RoutineView } from './routines'
import { createEchoTool, openRuntime, type AgentRuntime } from './runtime'

describe('例行任务（真实 PG / Pi / HTTP）', () => {
  let db: TestDatabase
  let dir: string
  let runtime: AgentRuntime
  let profiles: Profiles
  let chats: Chats
  let routines: Routines
  let server: Server
  let base = ''
  let cookie = ''
  let owner: Profile
  let clock = new Date('2026-11-06T00:00:00Z')

  const request = (path: string, method = 'GET', body?: unknown, authenticated = true) => fetch(`${base}${path}`, {
    method,
    headers: { origin: base, ...(authenticated && cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  async function occurrenceRows(routineId: string): Promise<RoutineOccurrence[]> {
    return (await db.pool.query<RoutineOccurrence>(
      'select * from routine_occurrence where routine_id = $1 order by created_at, id', [routineId],
    )).rows
  }

  async function waitDone(id: string): Promise<void> {
    // Chats 的后台派发依赖真实定时器与 PG 租约；这里等待它真正完成，
    // 不用假时钟，避免把两个时钟混在一起。
    await vi.waitFor(async () => {
      await routines.tick()
      const row = (await db.pool.query<RoutineOccurrence>('select * from routine_occurrence where id = $1', [id])).rows[0]
      if (row?.status !== 'done' && row?.status !== 'failed') throw new Error(`例行任务未结束：${row?.status ?? 'missing'}`)
    }, { timeout: 20_000, interval: 50 })
  }

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-routine-'))
    runtime = await openRuntime({ databasePath: join(dir, 'runtime.sqlite'), tools: [createEchoTool()], demo: true })
    const auth = await OwnerAuth.open(db.pool, join(dir, 'owner-key'))
    profiles = new Profiles(db.pool, runtime)
    await profiles.seed()
    owner = (await profiles.list())[0]!
    chats = new Chats(db.pool, runtime, profiles)
    chats.start()
    routines = new Routines(db.pool, profiles, runtime, { now: () => clock })
    server = createApp({ services: { auth, profiles, chats, routines } })
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server 未启动')
    base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ key: (await readFile(join(dir, 'owner-key'), 'utf8')).trim() }),
    })
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')!.split(';')[0]!
  })

  afterAll(async () => {
    if (server) await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
    await routines?.close()
    await chats?.close()
    await runtime?.close()
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('到期只执行一次，写入运行历史并进入聊天记录', async () => {
    clock = new Date('2026-11-06T00:00:00Z')
    const routine = await routines.create(owner.id, {
      name: '一次提醒',
      instruction: '提醒我查看今天的计划。',
      trigger: { kind: 'once', at: '2026-11-06T00:00:05Z' },
      timezone: 'UTC',
    })
    expect(routine.next_due_at?.toISOString()).toBe('2026-11-06T00:00:05.000Z')
    clock = new Date('2026-11-06T00:00:10Z')
    await routines.tick()
    let rows = await occurrenceRows(routine.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.logical_occurrence).toBe('slot:2026-11-06T00:00:05.000Z')
    await waitDone(rows[0]!.id)
    rows = await occurrenceRows(routine.id)
    expect(rows[0]!.status).toBe('done')
    expect(rows[0]!.dispatch_outbox_id).toBeTruthy()

    await routines.tick()
    expect(await occurrenceRows(routine.id)).toHaveLength(1)
    const finished = (await db.pool.query<{ status: string; next_due_at: Date | null }>(
      'select status, next_due_at from routine where id = $1', [routine.id],
    )).rows[0]!
    expect(finished.status).toBe('completed')
    expect(finished.next_due_at).toBeNull()

    const snapshot = await chats.snapshot(owner.id)
    expect(snapshot.messages.some((message) => message.role === 'user' && message.text.includes('提醒我查看今天的计划'))).toBe(true)
    expect(snapshot.messages.some((message) => message.role === 'assistant')).toBe(true)
  })

  it('重复到期不会为同一个槽位再建 occurrence', async () => {
    clock = new Date('2026-11-06T01:00:00Z')
    const routine = await routines.create(owner.id, {
      name: '重复防护',
      instruction: '记录一次。',
      trigger: { kind: 'interval', everyMinutes: 60, startAt: '2026-11-06T01:00:00Z' },
      timezone: 'UTC',
    })
    await db.pool.query('update routine set next_due_at = $2 where id = $1', [routine.id, '2026-11-06T01:00:00Z'])
    await routines.tick()
    await routines.tick()
    const rows = await occurrenceRows(routine.id)
    expect(rows).toHaveLength(1)
    const next = (await db.pool.query<{ next_due_at: Date }>('select next_due_at from routine where id = $1', [routine.id])).rows[0]!
    expect(next.next_due_at.toISOString()).toBe('2026-11-06T02:00:00.000Z')
  })

  it('错过运行按 skip 或 coalesce 处理，不补发全部槽位', async () => {
    clock = new Date('2026-11-06T02:00:00Z')
    const skipped = await routines.create(owner.id, {
      name: '错过跳过',
      instruction: '这条不该补发。',
      trigger: { kind: 'interval', everyMinutes: 10, startAt: '2026-11-06T02:00:00Z' },
      timezone: 'UTC',
      missedPolicy: 'skip',
    })
    const coalesced = await routines.create(owner.id, {
      name: '错过合并',
      instruction: '这条合并一次。',
      trigger: { kind: 'interval', everyMinutes: 10, startAt: '2026-11-06T02:00:00Z' },
      timezone: 'UTC',
      missedPolicy: 'coalesce',
    })
    await db.pool.query('update routine set next_due_at = $2 where id = $1', [skipped.id, '2026-11-06T01:10:00Z'])
    await db.pool.query('update routine set next_due_at = $2 where id = $1', [coalesced.id, '2026-11-06T01:10:00Z'])
    await routines.tick()

    const skipRows = await occurrenceRows(skipped.id)
    expect(skipRows).toHaveLength(1)
    expect(skipRows[0]!.status).toBe('skipped')
    expect(skipRows[0]!.last_error).toContain('错过 6 次')
    expect(skipRows[0]!.dispatch_outbox_id).toBeNull()

    const mergeRows = await occurrenceRows(coalesced.id)
    expect(mergeRows).toHaveLength(1)
    expect(mergeRows[0]!.status).not.toBe('skipped')
    const payload = (await db.pool.query<{ payload: { message: string } }>(
      'select payload from inbound_event where id = (select inbound_event_id from dispatch_outbox where id = $1)',
      [mergeRows[0]!.dispatch_outbox_id],
    )).rows[0]!.payload
    expect(payload.message).toContain('错过 6 次运行，本次合并执行')

    const next = (await db.pool.query<{ next_due_at: Date }>('select next_due_at from routine where id = $1', [coalesced.id])).rows[0]!
    expect(next.next_due_at.toISOString()).toBe('2026-11-06T02:10:00.000Z')
  })

  it('24 小时预算用完后暂停，手动运行被拒绝，恢复后重新计算下次时间', async () => {
    clock = new Date('2026-11-06T03:00:00Z')
    const routine = await routines.create(owner.id, {
      name: '预算任务',
      instruction: '预算测试。',
      trigger: { kind: 'once', at: '2026-11-06T04:00:00Z' },
      timezone: 'UTC',
      budgetTokens: 100,
    })
    await db.pool.query(
      `insert into routine_occurrence(id, routine_id, revision, logical_occurrence, scheduled_for, status, input_tokens)
       values ('occ_budget_used', $1, $2, 'slot:budget-used', '2026-11-06T02:00:00Z', 'done', 200)`,
      [routine.id, routine.revision],
    )
    await expect(routines.runNow(routine.id, { clientRequestId: 'budget-run-1' })).rejects.toThrow('预算已用完')
    const paused = (await db.pool.query<{ status: string; pause_reason: string }>(
      'select status, pause_reason from routine where id = $1', [routine.id],
    )).rows[0]!
    expect(paused.status).toBe('paused')
    expect(paused.pause_reason).toContain('预算')
    expect((await occurrenceRows(routine.id)).some((row) => row.status === 'skipped' && row.last_error?.includes('预算'))).toBe(true)

    const resumed = await routines.resume(routine.id)
    expect(resumed.status).toBe('active')
    expect(resumed.describe).toContain('只执行一次')
    await routines.pause(routine.id)
    await expect(routines.runNow(routine.id, { clientRequestId: 'budget-run-2' })).rejects.toThrow('已暂停')
  })

  it('HTTP 创建、webhook 去重、具名事件、暂停和运行历史', async () => {
    const created = await request(`/api/profiles/${owner.id}/routines`, 'POST', {
      name: 'HTTP 提醒',
      instruction: '收到 webhook 后提醒。',
      trigger: { kind: 'webhook' },
      timezone: 'Asia/Shanghai',
    })
    expect(created.status).toBe(201)
    const routine = await created.json() as RoutineView
    expect(routine.describe).toBe('收到 webhook 时')
    expect(routine.webhook_token).toMatch(/^[a-f0-9]{32}$/)

    const hook = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const first = await hook(`/api/hooks/${routine.webhook_token}`, { eventId: 'delivery-1', payload: { title: '新消息' } })
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ accepted: true, duplicate: false })
    const second = await hook(`/api/hooks/${routine.webhook_token}`, { eventId: 'delivery-1', payload: { title: '新消息' } })
    expect(await second.json()).toEqual({ accepted: true, duplicate: true })
    const conflict = await hook(`/api/hooks/${routine.webhook_token}`, { eventId: 'delivery-1', payload: { title: '换过的内容' } })
    expect(conflict.status).toBe(409)
    expect(await occurrenceRows(routine.id)).toHaveLength(1)
    expect((await hook('/api/hooks/00000000000000000000000000000000', { eventId: 'x' })).status).toBe(404)

    const event = await request('/api/profiles/' + owner.id + '/routines', 'POST', {
      name: '事件提醒',
      instruction: '收到事件后处理。',
      trigger: { kind: 'event', name: '新邮件' },
    })
    expect(event.status).toBe(201)
    const eventRoutine = await event.json() as RoutineView
    const fired = await request(`/api/events/${encodeURIComponent('新邮件')}`, 'POST', { eventId: 'mail-1', payload: { subject: '周报' } })
    expect(fired.status).toBe(202)
    expect(await fired.json()).toEqual({ fired: 1, created: 1, paused: 0 })
    const duplicate = await request(`/api/events/${encodeURIComponent('新邮件')}`, 'POST', { eventId: 'mail-1', payload: { subject: '周报' } })
    expect(await duplicate.json()).toEqual({ fired: 1, created: 0, paused: 0 })
    expect(await occurrenceRows(eventRoutine.id)).toHaveLength(1)

    const history = await request(`/api/routines/${routine.id}/occurrences`)
    expect(history.status).toBe(200)
    const listed = await history.json() as { occurrences: RoutineOccurrence[] }
    expect(listed.occurrences).toHaveLength(1)

    expect((await request(`/api/routines/${routine.id}/pause`, 'POST')).status).toBe(200)
    expect((await request(`/api/routines/${routine.id}/run`, 'POST', { clientRequestId: 'manual-run-1' })).status).toBe(409)
    expect((await request(`/api/routines/${routine.id}/resume`, 'POST')).status).toBe(200)
    expect((await request(`/api/routines/${routine.id}/run`, 'POST', { clientRequestId: 'manual-run-1' })).status).toBe(202)
    expect((await request('/api/routines', 'GET')).status).toBe(200)
  })

  it('QQ 送达要求启用发送，并且群必须已接入', async () => {
    await expect(routines.create(owner.id, {
      name: '无 QQ 发送',
      instruction: '测试。',
      trigger: { kind: 'webhook' },
      delivery: { kind: 'qq_private' },
    })).rejects.toThrow('QQ 发送未开启')

    const withQq = new Routines(db.pool, profiles, runtime, {
      now: () => clock,
      qq: { account: 'onebot:123456', ownerId: '10001', allowSend: true },
    })
    await expect(withQq.create(owner.id, {
      name: '未知群',
      instruction: '测试。',
      trigger: { kind: 'webhook' },
      delivery: { kind: 'qq_group', groupId: '987654' },
    })).rejects.toThrow('群尚未接入')
    await db.pool.query(
      `insert into qq_group(id, account_id, external_group_id) values ('onebot:123456:987654', 'onebot:123456', '987654')`,
    )
    const routine = await withQq.create(owner.id, {
      name: 'QQ 群提醒',
      instruction: '在群里提醒。',
      trigger: { kind: 'once', at: '2026-11-06T06:00:00Z' },
      delivery: { kind: 'qq_group', groupId: '987654' },
    })
    expect(routine.delivery.kind).toBe('qq_group')
    if (routine.delivery.kind === 'qq_group') expect(routine.delivery.groupId).toBe('987654')
  })
})
