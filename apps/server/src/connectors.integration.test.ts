import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { Actions, type Action } from './actions'
import { createApp } from './app'
import { OwnerAuth } from './auth'
import { Chats } from './chat'
import { Connectors } from './connectors'
import { SlackConnector } from './connectors/slack'
import { ExecutionService } from './execution'
import { Profiles, type Profile } from './profiles'
import { createEchoTool, openRuntime, type AgentRuntime } from './runtime'
import { VoiceService } from './voice'

describe('连接器与语音 HTTP / 动作链路', () => {
  let db: TestDatabase
  let dir: string
  let fixture: Server
  let runtime: AgentRuntime
  let profiles: Profiles
  let chats: Chats
  let actions: Actions
  let app: HttpServer
  let base = ''
  let cookie = ''
  let owner: Profile
  let slackPost = ''

  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const raw = (path: string, contentType: string, body: Uint8Array) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { origin: base, cookie, 'content-type': contentType, 'x-audio-filename': 'voice.webm' },
    body,
  })

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-connectors-http-'))
    fixture = createServer((req, res) => {
      void (async () => {
        if (req.url?.startsWith('/conversations.list')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'general', is_private: false }] }))
          return
        }
        if (req.url === '/chat.postMessage') {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          slackPost = Buffer.concat(chunks).toString('utf8')
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, ts: '99' }))
          return
        }
        if (req.url === '/stt') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ text: '接口转写' }))
          return
        }
        if (req.url === '/tts') {
          res.writeHead(200, { 'content-type': 'audio/mpeg' })
          res.end(Buffer.from('ID3http'))
          return
        }
        res.writeHead(404)
        res.end()
      })()
    })
    await new Promise<void>((ready) => fixture.listen(0, '127.0.0.1', ready))
    const address = fixture.address()
    if (!address || typeof address === 'string') throw new Error('fixture 未启动')
    const origin = `http://127.0.0.1:${address.port}`
    const connectors = new Connectors([new SlackConnector({ token: 'token', baseUrl: origin })])
    const voice = new VoiceService(db.pool, join(dir, 'voice'), { sttUrl: `${origin}/stt`, ttsUrl: `${origin}/tts` })
    runtime = await openRuntime({ databasePath: join(dir, 'runtime.sqlite'), tools: [createEchoTool()], demo: true })
    const auth = await OwnerAuth.open(db.pool, join(dir, 'owner-key'))
    profiles = new Profiles(db.pool, runtime)
    await profiles.seed()
    owner = (await profiles.list())[0]!
    chats = new Chats(db.pool, runtime, profiles)
    chats.start()
    actions = new Actions(db.pool, (action) => connectors.supports(action.account_id) ? connectors.deliver(action) : Promise.resolve('mock'))
    await actions.start()
    const execution = new ExecutionService(db.pool, join(dir, 'workspaces'), join(dir, 'worker.mjs'), [join(dir, 'voice')])
    app = createApp({ services: { auth, profiles, chats, actions, connectors, voice, execution } })
    await new Promise<void>((ready, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', ready) })
    const appAddress = app.address()
    if (!appAddress || typeof appAddress === 'string') throw new Error('app 未启动')
    base = `http://127.0.0.1:${appAddress.port}`
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ key: (await readFile(join(dir, 'owner-key'), 'utf8')).trim() }),
    })
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')!.split(';')[0]!
  })

  afterAll(async () => {
    if (app) await new Promise<void>((done) => { app.close(() => done()); app.closeAllConnections() })
    await actions?.close()
    await chats?.close()
    await runtime?.close()
    await new Promise<void>((done) => { fixture?.close(() => done()) })
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('读取连接器、提交动作、审批后真实调用上游', async () => {
    const status = await request('/api/connectors')
    expect(status.status).toBe(200)
    const statuses = (await status.json() as { connectors: { provider: string }[] }).connectors
    expect(statuses.map((item) => item.provider)).toContain('slack')

    const read = await request('/api/connectors/slack/read', 'POST', { operation: 'channels', params: {} })
    expect(read.status).toBe(200)
    expect((await read.json() as { data: unknown[] }).data).toEqual([{ id: 'C1', name: 'general', private: false }])

    const submitted = await request('/api/connectors/slack/actions', 'POST', {
      profileId: owner.id, operation: 'post', params: { channel: 'C1', text: '审批后的内容' },
      clientRequestId: 'connector-action-1',
    })
    expect(submitted.status).toBe(202)
    const action = await submitted.json() as Action
    expect(action.status).toBe('awaiting_approval')
    const approved = await request(`/api/actions/${action.id}/decision`, 'POST', {
      revision: action.revision, payloadHash: action.payload_hash, decision: 'approved',
    })
    expect(approved.status).toBe(200)
    await vi.waitFor(async () => {
      const row = (await db.pool.query<{ status: string }>('select status from action where id = $1', [action.id])).rows[0]
      expect(row?.status).toBe('confirmed')
    }, { timeout: 5_000, interval: 50 })
    expect(JSON.parse(slackPost)).toEqual({ channel: 'C1', text: '审批后的内容' })
  })

  it('语音合成返回产物，转写接收原始音频', async () => {
    const speak = await request(`/api/profiles/${owner.id}/voice/speak`, 'POST', { text: '语音内容' })
    expect(speak.status).toBe(201)
    const artifact = (await speak.json() as { artifact: { storage_path: string } }).artifact
    expect((await readFile(artifact.storage_path)).toString()).toBe('ID3http')

    const transcribe = await raw(`/api/profiles/${owner.id}/voice/transcribe`, 'audio/webm', new Uint8Array(Buffer.from('audio')))
    expect(transcribe.status).toBe(200)
    expect(await transcribe.json()).toEqual({ text: '接口转写' })
  })

  it('未知连接器和错误写操作明确失败', async () => {
    expect((await request('/api/connectors/missing/read', 'POST', { operation: 'x' })).status).toBe(404)
    expect((await request('/api/connectors/slack/read', 'POST', { operation: 'unknown' })).status).toBe(400)
    expect((await request('/api/connectors/slack/actions', 'POST', {
      profileId: owner.id, operation: 'unknown', params: {}, clientRequestId: 'connector-action-2',
    })).status).toBe(400)
  })
})
