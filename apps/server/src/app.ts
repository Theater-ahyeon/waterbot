import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { buildHealthPayload } from './health'
import { HttpError, readJson, requireLocalOrigin } from './http'
import type { OwnerAuth } from './auth'
import type { Profiles } from './profiles'
import type { Chats } from './chat'
import { PayloadConflictError } from './inbound/ingest'
import type { Actions } from './actions'
import type { Memories } from './memory'
import type { QqBridge } from './qq/bridge'

export interface AppOptions {
  /** 用于测试注入时钟；默认取真实时间。 */
  now?: () => Date
  startedAt?: Date
  services?: { auth: OwnerAuth; profiles: Profiles; chats: Chats; actions?: Actions; memories?: Memories; qq?: QqBridge }
}

const BASE_URL = 'http://127.0.0.1'

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body)

  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/**
 * origin-form（`/api/health`）与 absolute-form（`http://host/api/health`）都按路径解析。
 * `new URL` 对 `http://[` 这类畸形 URL 会抛 TypeError；请求处理器里抛异常会
 * 变成 uncaughtException 并终止进程，所以这里转成 null 由调用方回 400。
 */
function resolvePathname(rawUrl: string | undefined): string | null {
  try {
    return new URL(rawUrl ?? '/', BASE_URL).pathname
  } catch {
    return null
  }
}

export function createApp(options: AppOptions = {}): Server {
  const now = options.now ?? (() => new Date())
  const startedAt = options.startedAt ?? now()

  const streams = new Map<string, Set<ServerResponse>>()

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const pathname = resolvePathname(req.url)

    if (pathname === null) {
      sendJson(res, 400, { error: 'bad_request' })
      return
    }

    if (pathname === '/api/health') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' })
        return
      }

      sendJson(res, 200, buildHealthPayload({ startedAt, now: now() }))
      return
    }

    const services = options.services
    if (!services || !pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    requireLocalOrigin(req, !['GET', 'HEAD'].includes(method))
    if (pathname === '/api/login' && method === 'POST') {
      const body = await readJson(req)
      const cookie = await services.auth.login(body.key)
      sendJson(res, 200, { authenticated: true }, { 'set-cookie': cookie })
      return
    }
    const session = await services.auth.session(req.headers.cookie)
    if (pathname === '/api/session' && method === 'GET') {
      sendJson(res, 200, { authenticated: !!session, mode: 'demo' })
      return
    }
    if (pathname === '/api/logout' && method === 'POST') {
      const cookie = await services.auth.logout(session ?? '')
      for (const stream of streams.get(session ?? '') ?? []) stream.end()
      sendJson(res, 200, { authenticated: false }, { 'set-cookie': cookie })
      return
    }
    if (!session) throw new HttpError(401, '请先登录')
    if (pathname === '/api/qq/status') {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      sendJson(res, 200, services.qq ? await services.qq.status() : { state: 'not_configured' })
      return
    }
    if (pathname === '/api/profiles') {
      if (method === 'GET') sendJson(res, 200, { profiles: await services.profiles.list() })
      else if (method === 'POST') sendJson(res, 201, await services.profiles.create(await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const activity = /^\/api\/profiles\/([a-f0-9-]{36})\/(actions|policies)$/.exec(pathname)
    if (activity && services.actions) {
      const id = activity[1]!
      await services.profiles.get(id)
      if (activity[2] === 'actions') {
        if (method === 'GET') sendJson(res, 200, { actions: await services.actions.list(id) })
        else if (method === 'POST') sendJson(res, 201, await services.actions.propose(id, await readJson(req)))
        else throw new HttpError(405, '请求方法不支持')
      } else {
        if (method === 'GET') sendJson(res, 200, { policies: await services.actions.policies(id) })
        else if (method === 'POST') sendJson(res, 201, await services.actions.addPolicy(id, await readJson(req)))
        else throw new HttpError(405, '请求方法不支持')
      }
      return
    }
    const action = /^\/api\/actions\/([a-f0-9-]{36})(?:\/(decision))?$/.exec(pathname)
    if (action && services.actions) {
      if (action[2] === 'decision' && method === 'POST') sendJson(res, 200, await services.actions.decide(action[1]!, await readJson(req)))
      else if (!action[2] && method === 'PATCH') sendJson(res, 200, await services.actions.edit(action[1]!, await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const policy = /^\/api\/policies\/([a-f0-9-]{36})$/.exec(pathname)
    if (policy && method === 'DELETE' && services.actions) {
      await services.actions.revokePolicy(policy[1]!)
      sendJson(res, 200, { revoked: true })
      return
    }
    const memoryRoute = /^\/api\/profiles\/([a-f0-9-]{36})\/(memories|context-manifests)$/.exec(pathname)
    if (memoryRoute && services.memories) {
      const id = memoryRoute[1]!
      await services.profiles.get(id)
      if (memoryRoute[2] === 'context-manifests' && method === 'GET') sendJson(res, 200, { manifests: await services.memories.manifests(id) })
      else if (memoryRoute[2] === 'memories' && method === 'GET') sendJson(res, 200, { memories: await services.memories.list(id) })
      else if (memoryRoute[2] === 'memories' && method === 'POST') sendJson(res, 201, await services.memories.create(id, await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const memory = /^\/api\/memories\/([a-f0-9-]{36})(?:\/(revisions|forget))?$/.exec(pathname)
    if (memory && services.memories) {
      const id = memory[1]!
      if (!memory[2] && method === 'GET') sendJson(res, 200, await services.memories.detail(id))
      else if (memory[2] === 'revisions' && method === 'POST') sendJson(res, 200, await services.memories.correct(id, await readJson(req)))
      else if (memory[2] === 'forget' && method === 'POST') sendJson(res, 200, await services.memories.forget(id, await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const match = /^\/api\/profiles\/([a-f0-9-]{36})(?:\/(messages|events))?$/.exec(pathname)
    if (match) {
      const id = match[1]!
      if (!match[2]) {
        if (method === 'PATCH') sendJson(res, 200, await services.profiles.update(id, await readJson(req)))
        else if (method === 'GET') sendJson(res, 200, await services.profiles.get(id))
        else throw new HttpError(405, '请求方法不支持')
        return
      }
      if (match[2] === 'messages') {
        if (method === 'GET') sendJson(res, 200, await services.chats.snapshot(id))
        else if (method === 'POST') sendJson(res, 202, await services.chats.send(id, await readJson(req)))
        else throw new HttpError(405, '请求方法不支持')
        return
      }
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      const first = await services.chats.snapshot(id)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      let previous = JSON.stringify(first)
      res.write(`event: snapshot\ndata: ${previous}\n\n`)
      const owned = streams.get(session) ?? new Set<ServerResponse>()
      owned.add(res)
      streams.set(session, owned)
      let busy = false
      const timer = setInterval(() => {
        if (busy || res.destroyed || res.writableEnded) return
        busy = true
        void (async () => {
          if (!(await services.auth.session(req.headers.cookie))) {
            res.end()
            return
          }
          const next = JSON.stringify(await services.chats.snapshot(id))
          if (next !== previous) {
            previous = next
            res.write(`event: snapshot\ndata: ${next}\n\n`)
          } else res.write(': heartbeat\n\n')
        })().catch(() => {
          if (!res.destroyed && !res.writableEnded) {
            res.write('event: failure\ndata: {"error":"更新中断，请重新连接"}\n\n')
            res.end()
          }
        }).finally(() => { busy = false })
      }, 1000)
      res.once('close', () => {
        clearInterval(timer)
        owned.delete(res)
        if (!owned.size) streams.delete(session)
      })
      return
    }
    sendJson(res, 404, { error: 'not_found' })
  }

  return createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message })
      else if (error instanceof PayloadConflictError) sendJson(res, 409, { error: '同一请求的内容已变化，请重新发送' })
      else {
        console.error('[http] 请求处理失败')
        sendJson(res, 500, { error: '请求处理失败，请稍后重试' })
      }
    })
  })
}
