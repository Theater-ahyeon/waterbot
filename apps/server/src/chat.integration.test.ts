import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { createApp } from './app'
import { OwnerAuth } from './auth'
import { Actions } from './actions'
import { Chats, type ChatSnapshot } from './chat'
import { Profiles, type Profile } from './profiles'
import { createEchoTool, openRuntime, type AgentRuntime } from './runtime'

describe('主人登录与多人格聊天（真实 PG / Pi / HTTP / SSE）', () => {
  let db: TestDatabase
  let dir: string
  let runtime: AgentRuntime
  let chats: Chats
  let server: Server
  let actions: Actions
  let base = ''
  let cookie = ''
  let profiles: Profile[]
  let key = ''

  async function boot() {
    runtime = await openRuntime({ databasePath: join(dir, 'runtime.sqlite'), tools: [createEchoTool()], demo: true })
    const auth = await OwnerAuth.open(db.pool, join(dir, 'owner-key'))
    const service = new Profiles(db.pool, runtime)
    await service.seed()
    chats = new Chats(db.pool, runtime, service)
    chats.start()
    actions = new Actions(db.pool)
    await actions.start()
    server = createApp({ services: { auth, profiles: service, chats, actions } })
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server 未启动')
    base = `http://127.0.0.1:${address.port}`
  }

  async function shutdown() {
    if (server) await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
    await chats?.close()
    await actions?.close()
    await runtime?.close()
  }

  const request = (path: string, method = 'GET', body?: unknown, authenticated = true) => fetch(`${base}${path}`, {
    method,
    headers: { origin: base, ...(authenticated && cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  async function settled(id: string): Promise<ChatSnapshot> {
    const deadline = Date.now() + 15_000
    for (;;) {
      const response = await request(`/api/profiles/${id}/messages`)
      expect(response.status).toBe(200)
      const value = await response.json() as ChatSnapshot
      if (!value.pending && value.messages.some((message) => message.role === 'assistant')) return value
      if (Date.now() > deadline) throw new Error('聊天未完成')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-chat-'))
    await boot()
    key = (await readFile(join(dir, 'owner-key'), 'utf8')).trim()
  })

  afterAll(async () => {
    await shutdown()
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('未认证的管理与消息请求拒绝，跨站登录拒绝', async () => {
    expect((await request('/api/profiles', 'GET', undefined, false)).status).toBe(401)
    expect((await request('/api/profiles', 'POST', { name: 'x', instructions: '' }, false)).status).toBe(401)
    const response = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify({ key }),
    })
    expect(response.status).toBe(403)
    expect((await request('/api/login', 'POST', { key: 'incorrect' }, false)).status).toBe(401)
  })

  it('本机访问码登录，cookie 限制 JS 读取，会话仅存哈希', async () => {
    const response = await request('/api/login', 'POST', { key }, false)
    expect(response.status).toBe(200)
    const header = response.headers.get('set-cookie')!
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    cookie = header.split(';')[0]!
    const session = await (await request('/api/session')).json() as { authenticated: boolean }
    expect(session.authenticated).toBe(true)
    const sessions = await db.pool.query<{ token_hash: string }>('select token_hash from owner_session')
    expect(sessions.rows).toHaveLength(1)
    expect(sessions.rows[0]!.token_hash).not.toBe(cookie.split('=')[1])
    const list = await (await request('/api/profiles')).json() as { profiles: Profile[] }
    profiles = list.profiles
    expect(profiles).toHaveLength(2)
  })

  it('A / B 分别聊天，重复 requestId 不重复工作，切换不串历史', async () => {
    const a = profiles[0]!.id
    const b = profiles[1]!.id
    const input = { message: 'A 的独有内容：青苹果', clientRequestId: 'request-a-1' }
    const first = await request(`/api/profiles/${a}/messages`, 'POST', input)
    expect(first.status).toBe(202)
    const duplicate = await request(`/api/profiles/${a}/messages`, 'POST', input)
    expect(await duplicate.json()).toEqual(await first.json())
    const aView = await settled(a)
    expect(aView.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(aView.messages)).toContain('青苹果')
    const bInitial = await (await request(`/api/profiles/${b}/messages`)).json() as ChatSnapshot
    expect(bInitial.messages).toEqual([])
    await request(`/api/profiles/${b}/messages`, 'POST', { message: 'B 的独有内容：蓝莓', clientRequestId: 'request-b-1' })
    const bView = await settled(b)
    expect(JSON.stringify(bView.messages)).toContain('蓝莓')
    expect(JSON.stringify(bView.messages)).not.toContain('青苹果')
    expect(JSON.stringify((await settled(a)).messages)).not.toContain('蓝莓')
    const bindings = await db.pool.query('select pi_conversation_id from conversation_binding')
    expect(new Set(bindings.rows.map((row) => row.pi_conversation_id)).size).toBe(2)
  })

  it('人格修改有版本检查，新建与错误输入受验证', async () => {
    const a = profiles[0]!
    const update = { name: '更直接的伙伴', instructions: '简短回答。', revision: a.revision }
    expect((await request(`/api/profiles/${a.id}`, 'PATCH', update)).status).toBe(200)
    expect((await request(`/api/profiles/${a.id}`, 'PATCH', update)).status).toBe(409)
    expect((await request('/api/profiles', 'POST', { name: '', instructions: '' })).status).toBe(400)
    const created = await request('/api/profiles', 'POST', { name: '第三个人格', instructions: '善于整理。' })
    expect(created.status).toBe(201)
    const conflict = await request(`/api/profiles/${a.id}/messages`, 'POST', { message: '修改重复请求的内容', clientRequestId: 'request-a-1' })
    expect(conflict.status).toBe(409)
  })

  it('动作和规则 API 受登录保护，批准与执行结果可以查询', async () => {
    const path = `/api/profiles/${profiles[0]!.id}/actions`
    expect((await request(path, 'GET', undefined, false)).status).toBe(401)
    const response = await request(path, 'POST', { target: '本地测试对象', message: '模拟消息', triggerId: 'http-action-test' })
    expect(response.status).toBe(201)
    const action = await response.json() as { id: string; revision: number; payload_hash: string; status: string }
    expect(action.status).toBe('awaiting_approval')
    const approved = await request(`/api/actions/${action.id}/decision`, 'POST', { revision: action.revision, payloadHash: action.payload_hash, decision: 'approved' })
    expect(approved.status).toBe(200)
    const deadline = Date.now() + 5000
    for (;;) {
      const result = await (await request(path)).json() as { actions: { status: string }[] }
      if (result.actions[0]?.status === 'confirmed') break
      if (Date.now() > deadline) throw new Error('模拟动作未完成')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  })

  it('SSE 返回当前人格快照，退出登录会关闭连接并撤销会话', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/profiles/${profiles[0]!.id}/events`, { headers: { cookie }, signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    try {
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('event: snapshot')
      expect((await request('/api/logout', 'POST')).status).toBe(200)
      expect((await reader.read()).done).toBe(true)
      expect((await request('/api/profiles')).status).toBe(401)
    } finally {
      controller.abort()
      await reader.cancel().catch(() => undefined)
    }
  })

  it('关闭重启后人物与各自历史仍存在，访问码不重置', async () => {
    await shutdown()
    await boot()
    expect((await readFile(join(dir, 'owner-key'), 'utf8')).trim()).toBe(key)
    const response = await request('/api/login', 'POST', { key }, false)
    cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const a = await settled(profiles[0]!.id)
    const b = await settled(profiles[1]!.id)
    expect(a.profile.name).toBe('更直接的伙伴')
    expect(JSON.stringify(a.messages)).toContain('青苹果')
    expect(JSON.stringify(b.messages)).not.toContain('青苹果')
  })
})
