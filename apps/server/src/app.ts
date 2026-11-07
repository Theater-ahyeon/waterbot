import { createReadStream } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { buildHealthPayload } from './health'
import { HttpError, readJson, requireLocalOrigin, textField } from './http'
import type { OwnerAuth } from './auth'
import type { Profiles } from './profiles'
import type { Chats } from './chat'
import { PayloadConflictError } from './inbound/ingest'
import type { Actions } from './actions'
import type { Memories } from './memory'
import type { Usage } from './usage'
import type { Status } from './status'
import type { BotCollaboration } from './collaboration'
import type { QzoneService } from './qzone'
import type { ExecutionService } from './execution'
import type { McpService } from './mcp'
import type { Skills } from './skills'
import type { Routines } from './routines'
import type { Documents } from './documents'
import type { BrowserService } from './browser'
import type { GithubService } from './github'
import type { Connectors } from './connectors'
import { readAudioBody, type VoiceService } from './voice'
import { PAGE_CSP, renderPageHtml, type Pages } from './pages'
import type { Settings } from './settings'
import type { WorkbenchSearch } from './workbench-search'
import { PROFILE_TEMPLATES } from './templates'
import type { QqBridge } from './qq/bridge'

export interface AppOptions {
  /** 用于测试注入时钟；默认取真实时间。 */
  now?: () => Date
  startedAt?: Date
  /** 反向代理对外地址；只影响 Host / Origin 校验，不改变监听地址。 */
  publicOrigin?: string
  services?: {
    auth: OwnerAuth; profiles: Profiles; chats: Chats; actions?: Actions; memories?: Memories;
    usage?: Usage; status?: Status; collaboration?: BotCollaboration; qzone?: QzoneService;
    execution?: ExecutionService; mcp?: McpService; skills?: Skills; routines?: Routines;
    documents?: Documents; pages?: Pages; settings?: Settings; search?: WorkbenchSearch; browser?: BrowserService; github?: GithubService; connectors?: Connectors; voice?: VoiceService; qq?: QqBridge
  }
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
    // webhook 用 URL 里的随机 token 作为凭据，不依赖主人 cookie；响应不暴露任务内容。
    const hook = /^\/api\/hooks\/([a-f0-9]{32})$/.exec(pathname)
    if (hook && services.routines) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      sendJson(res, 202, await services.routines.webhook(hook[1]!, await readJson(req)))
      return
    }
    // 发布页是独立只读副本：随机 token 作为凭据，脚本在 sandbox 源里运行。
    const publicPage = /^\/api\/public\/pages\/([a-f0-9]{32})$/.exec(pathname)
    if (publicPage && services.pages) {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      const page = await services.pages.publicPage(publicPage[1]!)
      const html = renderPageHtml(page.title, page.content)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
        'content-security-policy': PAGE_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
      return
    }
    requireLocalOrigin(req, !['GET', 'HEAD'].includes(method), options.publicOrigin)
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
    if (pathname === '/api/status') {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      if (!services.status) throw new HttpError(503, '状态服务未启用')
      sendJson(res, 200, await services.status.snapshot())
      return
    }
    if (pathname === '/api/qq/status') {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      sendJson(res, 200, services.qq ? await services.qq.status() : { state: 'not_configured' })
      return
    }
    const usageRoute = /^\/api\/profiles\/([a-f0-9-]{36})\/usage$/.exec(pathname)
    if (usageRoute && services.usage) {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      const id = usageRoute[1]!
      await services.profiles.get(id)
      const rawSince = new URL(req.url ?? '/', BASE_URL).searchParams.get('since')
      const since = rawSince ? new Date(rawSince) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      if (Number.isNaN(since.getTime())) throw new HttpError(400, 'since 不是有效时间')
      sendJson(res, 200, { days: await services.usage.profile(id, since) })
      return
    }
    if (pathname === '/api/mcp/servers' && services.mcp) {
      if (method === 'GET') sendJson(res, 200, { servers: await services.mcp.listServers() })
      else if (method === 'POST') {
        const body = await readJson(req)
        sendJson(res, 201, await services.mcp.addServer({
          name: textField(body.name, '名称', 80),
          command: textField(body.command, '命令', 500),
          ...(Array.isArray(body.args) ? { args: body.args as string[] } : {}),
          ...(typeof body.cwd === 'string' ? { cwd: textField(body.cwd, '目录', 500) } : {}),
        }))
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    const mcpServer = /^\/api\/mcp\/servers\/([a-f0-9-]{36})(?:\/(refresh|tools))?$/.exec(pathname)
    if (mcpServer && services.mcp) {
      const id = mcpServer[1]!
      if (mcpServer[2] === 'refresh' && method === 'POST') {
        sendJson(res, 200, { tools: await services.mcp.refresh(id) })
        return
      }
      if (mcpServer[2] === 'tools' && method === 'GET') {
        sendJson(res, 200, { tools: await services.mcp.tools(id) })
        return
      }
      throw new HttpError(405, '请求方法不支持')
    }
    const mcpToolRoute = /^\/api\/mcp\/servers\/([a-f0-9-]{36})\/tools\/([^/]+)$/.exec(pathname)
    if (mcpToolRoute && services.mcp) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      const body = await readJson(req)
      await services.mcp.setToolEnabled(mcpToolRoute[1]!, decodeURIComponent(mcpToolRoute[2]!), body.enabled === true)
      sendJson(res, 200, { enabled: body.enabled === true })
      return
    }
    const mcpBinding = /^\/api\/mcp\/servers\/([a-f0-9-]{36})\/profiles\/([a-f0-9-]{36})$/.exec(pathname)
    if (mcpBinding && services.mcp) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      await services.profiles.get(mcpBinding[2]!)
      const body = await readJson(req)
      if (body.enabled === true) await services.mcp.bind(mcpBinding[2]!, mcpBinding[1]!)
      else await services.mcp.unbind(mcpBinding[2]!, mcpBinding[1]!)
      sendJson(res, 200, { enabled: body.enabled === true })
      return
    }
    if (pathname === '/api/mcp/calls' && services.mcp) {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      sendJson(res, 200, { calls: await services.mcp.calls() })
      return
    }
    if (pathname === '/api/mcp/call' && services.mcp) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      const body = await readJson(req)
      const profileId = textField(body.profileId, '人格 ID', 36)
      await services.profiles.get(profileId)
      const args = typeof body.arguments === 'object' && body.arguments !== null ? body.arguments as Record<string, unknown> : {}
      sendJson(res, 200, {
        output: await services.mcp.call(profileId, textField(body.server, '服务', 80), textField(body.tool, '工具', 120), args),
      })
      return
    }
    const profileSkills = /^\/api\/profiles\/([a-f0-9-]{36})\/skills$/.exec(pathname)
    if (profileSkills && services.skills) {
      const id = profileSkills[1]!
      await services.profiles.get(id)
      if (method === 'GET') sendJson(res, 200, { skills: await services.skills.list(id) })
      else if (method === 'POST') {
        const body = await readJson(req)
        sendJson(res, 201, await services.skills.create(id, {
          name: textField(body.name, '技能名称', 80),
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          body: textField(body.body, '技能内容', 4000),
        }))
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    const skillRoute = /^\/api\/skills\/([a-f0-9-]{36})(?:\/(activate|deactivate))?$/.exec(pathname)
    if (skillRoute && services.skills) {
      const id = skillRoute[1]!
      if (!skillRoute[2] && method === 'GET') sendJson(res, 200, await services.skills.get(id))
      else if (!skillRoute[2] && method === 'PATCH') {
        const body = await readJson(req)
        if (typeof body.expectedVersion !== 'number') throw new HttpError(400, '缺少版本')
        sendJson(res, 200, await services.skills.update(id, {
          expectedVersion: body.expectedVersion,
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          body: textField(body.body, '技能内容', 4000),
        }))
      } else if (!skillRoute[2] && method === 'DELETE') {
        await services.skills.remove(id)
        sendJson(res, 200, { deleted: true })
      } else if (skillRoute[2] === 'activate' && method === 'POST') {
        sendJson(res, 200, await services.skills.setStatus(id, 'active'))
      } else if (skillRoute[2] === 'deactivate' && method === 'POST') {
        sendJson(res, 200, await services.skills.setStatus(id, 'draft'))
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    if (pathname === '/api/routines' && services.routines) {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      const profileId = new URL(req.url ?? '/', BASE_URL).searchParams.get('profileId') ?? undefined
      sendJson(res, 200, { routines: await services.routines.list(profileId) })
      return
    }
    const profileRoutines = /^\/api\/profiles\/([a-f0-9-]{36})\/routines$/.exec(pathname)
    if (profileRoutines && services.routines) {
      const id = profileRoutines[1]!
      await services.profiles.get(id)
      if (method === 'GET') sendJson(res, 200, { routines: await services.routines.list(id) })
      else if (method === 'POST') sendJson(res, 201, await services.routines.create(id, await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const routineRoute = /^\/api\/routines\/([a-f0-9-]{36})(?:\/(pause|resume|run|occurrences))?$/.exec(pathname)
    if (routineRoute && services.routines) {
      const id = routineRoute[1]!
      if (!routineRoute[2]) {
        if (method === 'GET') sendJson(res, 200, await services.routines.get(id))
        else if (method === 'PATCH') sendJson(res, 200, await services.routines.update(id, await readJson(req)))
        else if (method === 'DELETE') {
          await services.routines.remove(id)
          sendJson(res, 200, { deleted: true })
        } else throw new HttpError(405, '请求方法不支持')
      } else if (routineRoute[2] === 'occurrences' && method === 'GET') {
        sendJson(res, 200, { occurrences: await services.routines.occurrences(id) })
      } else if (routineRoute[2] === 'pause' && method === 'POST') {
        sendJson(res, 200, await services.routines.pause(id))
      } else if (routineRoute[2] === 'resume' && method === 'POST') {
        sendJson(res, 200, await services.routines.resume(id))
      } else if (routineRoute[2] === 'run' && method === 'POST') {
        sendJson(res, 202, await services.routines.runNow(id, await readJson(req)))
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    const eventRoute = /^\/api\/events\/([^/]{1,200})$/.exec(pathname)
    if (eventRoute && services.routines) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      let name: string
      try {
        name = decodeURIComponent(eventRoute[1]!)
      } catch {
        throw new HttpError(400, '事件名称无效')
      }
      sendJson(res, 202, await services.routines.fireEvent(name, await readJson(req)))
      return
    }
    const profileDocuments = /^\/api\/profiles\/([a-f0-9-]{36})\/documents$/.exec(pathname)
    if (profileDocuments && services.documents) {
      const id = profileDocuments[1]!
      await services.profiles.get(id)
      if (method === 'GET') sendJson(res, 200, { documents: await services.documents.list(id) })
      else if (method === 'POST') sendJson(res, 201, await services.documents.create(id, await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const documentRoute = /^\/api\/documents\/([a-f0-9-]{36})(?:\/(revisions))?$/.exec(pathname)
    if (documentRoute && services.documents) {
      const id = documentRoute[1]!
      if (!documentRoute[2] && method === 'GET') sendJson(res, 200, await services.documents.get(id))
      else if (documentRoute[2] === 'revisions' && method === 'POST') {
        sendJson(res, 201, await services.documents.revise(id, await readJson(req)))
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    const profilePages = /^\/api\/profiles\/([a-f0-9-]{36})\/pages$/.exec(pathname)
    if (profilePages && services.pages) {
      const id = profilePages[1]!
      await services.profiles.get(id)
      if (method === 'GET') sendJson(res, 200, { pages: await services.pages.list(id) })
      else if (method === 'POST') sendJson(res, 201, await services.pages.create(id, await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const pageRoute = /^\/api\/pages\/([a-f0-9-]{36})(?:\/(revisions|publish|unpublish))?$/.exec(pathname)
    if (pageRoute && services.pages) {
      const id = pageRoute[1]!
      if (!pageRoute[2]) {
        if (method === 'GET') sendJson(res, 200, await services.pages.get(id))
        else if (method === 'PATCH') sendJson(res, 200, await services.pages.update(id, await readJson(req)))
        else if (method === 'DELETE') {
          await services.pages.remove(id)
          sendJson(res, 200, { deleted: true })
        } else throw new HttpError(405, '请求方法不支持')
      } else if (pageRoute[2] === 'revisions' && method === 'GET') {
        sendJson(res, 200, { revisions: (await services.pages.get(id)).revisions })
      } else if (pageRoute[2] === 'publish' && method === 'POST') {
        sendJson(res, 201, await services.pages.publish(id))
      } else if (pageRoute[2] === 'unpublish' && method === 'POST') {
        sendJson(res, 200, { revoked: await services.pages.unpublish(id) })
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    const browserRoute = /^\/api\/profiles\/([a-f0-9-]{36})\/browser(?:\/(open|snapshot|click|type|screenshot|close|lease))?$/.exec(pathname)
    if (browserRoute && services.browser) {
      const id = browserRoute[1]!
      await services.profiles.get(id)
      const action = browserRoute[2]
      if (!action && method === 'GET') {
        sendJson(res, 200, { surface: await services.browser.status(id) })
        return
      }
      if (action === 'snapshot' && method === 'GET') {
        sendJson(res, 200, await services.browser.snapshot(id))
        return
      }
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      if (action === 'open') {
        const body = await readJson(req)
        sendJson(res, 200, await services.browser.open(id, textField(body.url, '网址', 2000)))
      } else if (action === 'click') {
        const body = await readJson(req)
        sendJson(res, 200, await services.browser.click(id, textField(body.ref, '元素引用', 20)))
      } else if (action === 'type') {
        const body = await readJson(req)
        sendJson(res, 200, await services.browser.type(
          id, textField(body.ref, '元素引用', 20), textField(body.text, '输入内容', 4000), body.submit === true,
        ))
      } else if (action === 'screenshot') {
        sendJson(res, 201, await services.browser.screenshot(id))
      } else if (action === 'close') {
        await services.browser.closeSurface(id)
        sendJson(res, 200, { closed: true })
      } else if (action === 'lease') {
        const body = await readJson(req)
        if (body.holder !== 'agent' && body.holder !== 'human' && body.holder !== 'none') {
          throw new HttpError(400, '控制权无效')
        }
        sendJson(res, 200, await services.browser.lease(id, body.holder))
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    const voiceRoute = /^\/api\/profiles\/([a-f0-9-]{36})\/voice(?:\/(transcribe|speak|status))?$/.exec(pathname)
    if (voiceRoute && services.voice) {
      const id = voiceRoute[1]!
      await services.profiles.get(id)
      const action = voiceRoute[2]
      if ((action === 'status' || !action) && method === 'GET') {
        sendJson(res, 200, services.voice.status())
        return
      }
      if (action === 'transcribe' && method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '')
        if (!contentType.startsWith('audio/')) throw new HttpError(415, '请上传音频内容')
        const filename = String(req.headers['x-audio-filename'] ?? 'audio.bin').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)
        const data = await readAudioBody(req)
        sendJson(res, 200, { text: await services.voice.transcribe(id, data, filename || 'audio.bin', contentType.split(';')[0]!) })
        return
      }
      if (action === 'speak' && method === 'POST') {
        const body = await readJson(req)
        const artifact = await services.voice.speak(id, textField(body.text, '文本', 4000))
        sendJson(res, 201, { artifact, path: `/api/artifacts/${artifact.id}/download` })
        return
      }
      throw new HttpError(405, '请求方法不支持')
    }
    const executions = /^\/api\/profiles\/([a-f0-9-]{36})\/executions$/.exec(pathname)
    if (executions && services.execution) {
      const id = executions[1]!
      await services.profiles.get(id)
      if (method === 'GET') sendJson(res, 200, { executions: await services.execution.list(id) })
      else if (method === 'POST') {
        const body = await readJson(req)
        sendJson(res, 202, await services.execution.submit(id, textField(body.command, '命令', 4000)))
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    const execution = /^\/api\/executions\/([a-f0-9-]{36})(?:\/(cancel|artifacts))?$/.exec(pathname)
    if (execution && services.execution) {
      const id = execution[1]!
      if (!execution[2] && method === 'GET') sendJson(res, 200, await services.execution.get(id))
      else if (execution[2] === 'cancel' && method === 'POST') sendJson(res, 200, await services.execution.cancel(id))
      else if (execution[2] === 'artifacts' && method === 'GET') sendJson(res, 200, { artifacts: await services.execution.artifacts(id) })
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const artifact = /^\/api\/artifacts\/([a-f0-9-]{36})\/download$/.exec(pathname)
    if (artifact && services.execution) {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      const { path, artifact: file } = await services.execution.downloadPath(artifact[1]!)
      const fallback = file.name.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '')
      res.writeHead(200, {
        'content-type': file.mime,
        'content-length': file.size,
        'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      })
      createReadStream(path).on('error', () => res.destroy()).pipe(res)
      return
    }
    if (services.qzone && pathname.startsWith('/api/qzone/')) {
      if (pathname === '/api/qzone/status' && method === 'GET') {
        sendJson(res, 200, await services.qzone.status())
        return
      }
      if (pathname === '/api/qzone/posts' && method === 'GET') {
        const target = new URL(req.url ?? '/', BASE_URL).searchParams.get('target') ?? undefined
        sendJson(res, 200, { posts: await services.qzone.posts(target ?? undefined) })
        return
      }
      if (pathname === '/api/qzone/refresh' && method === 'POST') {
        const body = await readJson(req)
        const target = typeof body.targetUin === 'string' ? body.targetUin : undefined
        sendJson(res, 200, { posts: await services.qzone.refresh(target) })
        return
      }
      if (pathname === '/api/qzone/comments' && method === 'POST') {
        if (!services.actions) throw new HttpError(503, '动作服务未启用')
        const body = await readJson(req)
        const tid = textField(body.tid, '说说 ID', 120)
        const content = textField(body.content, '评论内容', 1000)
        const clientRequestId = textField(body.clientRequestId, '请求 ID', 128)
        if (!/^[a-zA-Z0-9_-]{8,128}$/.test(clientRequestId)) throw new HttpError(400, '请求 ID 无效')
        const profileId = typeof body.profileId === 'string'
          ? textField(body.profileId, '人格 ID', 36)
          : (await services.profiles.list())[0]?.id
        if (!profileId) throw new HttpError(400, '没有可用人格')
        const targetUin = typeof body.targetUin === 'string' && /^\d{5,12}$/.test(body.targetUin) ? body.targetUin : undefined
        const action = await services.actions.submit(profileId, {
          account: 'qzone',
          kind: 'qzone.comment',
          target: `qzone:${targetUin ?? ''}:${tid}`,
          message: content,
          trigger: `qzone:${tid}:${clientRequestId}`,
          payload: { tid, ...(targetUin ? { targetUin } : {}) },
        })
        sendJson(res, 202, action)
        return
      }
      throw new HttpError(405, '请求方法不支持')
    }
    if (pathname === '/api/bot-groups') {
      if (!services.collaboration) throw new HttpError(503, 'Bot 协作未启用')
      if (method === 'GET') sendJson(res, 200, { groups: await services.collaboration.listGroups() })
      else if (method === 'POST') {
        const body = await readJson(req)
        if (!Array.isArray(body.members) || body.members.some((item) => typeof item !== 'string')) throw new HttpError(400, 'members 必须是人格 ID 数组')
        sendJson(res, 201, await services.collaboration.createGroup(textField(body.name, '群名称', 80), body.members as string[]))
      } else throw new HttpError(405, '请求方法不支持')
      return
    }
    const botGroupRoute = /^\/api\/bot-groups\/([a-f0-9-]{36})(?:\/(messages|tasks|stop|resume))?$/.exec(pathname)
    if (botGroupRoute && services.collaboration) {
      const id = botGroupRoute[1]!
      if (!botGroupRoute[2] && method === 'GET') {
        sendJson(res, 200, {
          group: await services.collaboration.getGroup(id),
          members: await services.collaboration.members(id),
          tasks: await services.collaboration.tasks(id),
        })
        return
      }
      if (botGroupRoute[2] === 'messages') {
        if (method === 'GET') sendJson(res, 200, { messages: await services.collaboration.messages(id) })
        else if (method === 'POST') {
          const body = await readJson(req)
          const fromProfileId = typeof body.fromProfileId === 'string' ? body.fromProfileId : undefined
          sendJson(res, 202, await services.collaboration.post({
            groupId: id,
            ...(fromProfileId ? { senderProfileId: fromProfileId } : {}),
            targetProfileId: textField(body.targetProfileId, '目标人格', 36),
            content: textField(body.content, '内容', 8000),
          }))
        } else throw new HttpError(405, '请求方法不支持')
        return
      }
      if (botGroupRoute[2] === 'tasks' && method === 'GET') {
        sendJson(res, 200, { tasks: await services.collaboration.tasks(id) })
        return
      }
      if ((botGroupRoute[2] === 'stop' || botGroupRoute[2] === 'resume') && method === 'POST') {
        if (botGroupRoute[2] === 'stop') await services.collaboration.stop(id)
        else await services.collaboration.resume(id)
        sendJson(res, 200, { stopped: botGroupRoute[2] === 'stop' })
        return
      }
      throw new HttpError(405, '请求方法不支持')
    }
    if (pathname === '/api/templates' && method === 'GET') {
      sendJson(res, 200, { templates: PROFILE_TEMPLATES })
      return
    }
    if (pathname === '/api/settings' && services.settings) {
      if (method === 'GET') sendJson(res, 200, await services.settings.get())
      else if (method === 'PUT') sendJson(res, 200, await services.settings.update(await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    if (pathname === '/api/search' && services.search) {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      const params = new URL(req.url ?? '/', BASE_URL).searchParams
      const query = params.get('q') ?? ''
      const profileId = params.get('profileId') ?? undefined
      sendJson(res, 200, { groups: await services.search.search(query, profileId) })
      return
    }
    if (services.github && pathname.startsWith('/api/connectors/github')) {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      if (pathname === '/api/connectors/github/status') {
        sendJson(res, 200, services.github.status())
        return
      }
      const issuesRoute = /^\/api\/connectors\/github\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(pathname)
      if (issuesRoute) {
        const state = new URL(req.url ?? '/', BASE_URL).searchParams.get('state') ?? 'open'
        sendJson(res, 200, {
          issues: await services.github.issues(
            decodeURIComponent(issuesRoute[1]!), decodeURIComponent(issuesRoute[2]!),
            state === 'closed' || state === 'all' ? state : 'open',
          ),
        })
        return
      }
      const repoRoute = /^\/api\/connectors\/github\/repos\/([^/]+)\/([^/]+)$/.exec(pathname)
      if (repoRoute) {
        sendJson(res, 200, await services.github.repo(decodeURIComponent(repoRoute[1]!), decodeURIComponent(repoRoute[2]!)))
        return
      }
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (pathname === '/api/connectors' && services.connectors) {
      if (method !== 'GET') throw new HttpError(405, '请求方法不支持')
      sendJson(res, 200, { connectors: services.connectors.statuses() })
      return
    }
    const connectorRead = /^\/api\/connectors\/([a-z]+)\/read$/.exec(pathname)
    if (connectorRead && services.connectors) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      const body = await readJson(req)
      const params = typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
        ? body.params as Record<string, unknown>
        : {}
      sendJson(res, 200, {
        data: await services.connectors.read(
          connectorRead[1]!, textField(body.operation, '操作', 80), params,
        ),
      })
      return
    }
    const connectorAction = /^\/api\/connectors\/([a-z]+)\/actions$/.exec(pathname)
    if (connectorAction && services.connectors) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      if (!services.actions) throw new HttpError(503, '动作服务未启用')
      const body = await readJson(req)
      const profileId = textField(body.profileId, '人格 ID', 36)
      await services.profiles.get(profileId)
      const clientRequestId = textField(body.clientRequestId, '请求 ID', 128)
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(clientRequestId)) throw new HttpError(400, '请求 ID 无效')
      const params = typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
        ? body.params as Record<string, unknown>
        : {}
      const draft = services.connectors.action(
        connectorAction[1]!, textField(body.operation, '操作', 80), params,
      )
      sendJson(res, 202, await services.actions.submit(profileId, {
        account: draft.account, kind: draft.kind, target: draft.target, message: draft.message,
        trigger: `connector:${draft.account}:${clientRequestId}`, payload: draft.payload,
      }))
      return
    }
    if (pathname === '/api/profiles') {
      if (method === 'GET') {
        const includeArchived = new URL(req.url ?? '/', BASE_URL).searchParams.get('includeArchived') === '1'
        sendJson(res, 200, { profiles: await services.profiles.list(includeArchived) })
      } else if (method === 'POST') sendJson(res, 201, await services.profiles.create(await readJson(req)))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const profileAction = /^\/api\/profiles\/([a-f0-9-]{36})\/(copy|restore)$/.exec(pathname)
    if (profileAction) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持')
      const id = profileAction[1]!
      if (profileAction[2] === 'copy') sendJson(res, 201, await services.profiles.copy(id, await readJson(req)))
      else sendJson(res, 200, await services.profiles.restore(id))
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
    const memory = /^\/api\/memories\/([a-f0-9-]{36})(?:\/(revisions|forget|purge))?$/.exec(pathname)
    if (memory && services.memories) {
      const id = memory[1]!
      if (!memory[2] && method === 'GET') sendJson(res, 200, await services.memories.detail(id))
      else if (memory[2] === 'revisions' && method === 'POST') sendJson(res, 200, await services.memories.correct(id, await readJson(req)))
      else if (memory[2] === 'forget' && method === 'POST') sendJson(res, 200, await services.memories.forget(id, await readJson(req)))
      else if (memory[2] === 'purge' && method === 'POST') sendJson(res, 200, await services.memories.purge(id))
      else throw new HttpError(405, '请求方法不支持')
      return
    }
    const match = /^\/api\/profiles\/([a-f0-9-]{36})(?:\/(messages|events))?$/.exec(pathname)
    if (match) {
      const id = match[1]!
      if (!match[2]) {
        if (method === 'PATCH') sendJson(res, 200, await services.profiles.update(id, await readJson(req)))
        else if (method === 'GET') sendJson(res, 200, await services.profiles.get(id))
        else if (method === 'DELETE') sendJson(res, 200, await services.profiles.archive(id))
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
