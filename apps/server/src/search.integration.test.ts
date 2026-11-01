import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { Memories } from './memory'
import { createContextExtension } from './memory-context'
import { Profiles } from './profiles'
import { createEchoTool, openRuntime } from './runtime'
import { createTavilySearcher, createWebSearchTool } from './search'

describe('联网查证（模拟搜索服务 + 真实 PG / Pi）', () => {
  let db: TestDatabase
  let dir: string
  let server: Server
  let url = ''
  let status = 200
  let requests: { auth: string | undefined; body: { query: string; search_depth: string; max_results: number } }[] = []

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'wb-search-'))
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += String(chunk) })
      req.on('end', () => {
        requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) as never })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ results: [
          { title: '来源标题', url: 'https://example.com/a', content: '摘要'.repeat(400), score: 1 },
          { title: '坏链接', url: 'javascript:alert(1)', content: 'x' },
        ] }))
      })
    })
    await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('未启动')
    url = `http://127.0.0.1:${address.port}/search`
  })

  beforeEach(async () => {
    status = 200
    requests = []
    await db.pool.query('truncate search_call')
  })

  afterAll(async () => {
    await new Promise((done) => { server.close(done) })
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function run(limit = 30, query = '今天的新闻') {
    let toolResult = ''
    // 每次用新的运行库，旧绑定指向的 Pi 会话已不存在。
    await db.pool.query('truncate conversation_binding')
    const memories = new Memories(db.pool)
    const search = createTavilySearcher('tvly-test', url)
    const base = createContextExtension(memories, 'faux/faux-1')
    const runtime = await openRuntime({
      databasePath: join(dir, `${Math.random()}.sqlite`), tools: [createEchoTool()],
      extensions: [{ ...base, tools: [createWebSearchTool(db.pool, search, limit)] }],
      responses: [
        fauxAssistantMessage([fauxToolCall('web_search', { query })], { stopReason: 'toolUse' }),
        (context) => {
          toolResult = JSON.stringify(context.messages.at(-1))
          return fauxAssistantMessage('好的')
        },
      ],
    })
    try {
      runtime.resume()
      const profiles = new Profiles(db.pool, runtime)
      await profiles.seed()
      const { conversation } = await profiles.conversation((await profiles.list())[0]!.id)
      const submission = await conversation.submit({ type: 'input', content: '查一下', requestId: `search-${Math.random()}` }, BACKGROUND_CONTEXT)
      await submission.wait(BACKGROUND_CONTEXT)
    } finally {
      await runtime.close()
    }
    return toolResult
  }

  it('固定 basic 深度，带密钥请求头，结果保留来源、截断摘要并丢弃非 http 链接', async () => {
    const result = await run()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ auth: 'Bearer tvly-test', body: { query: '今天的新闻', search_depth: 'basic', max_results: 5 } })
    expect(result).toContain('https://example.com/a')
    expect(result).not.toContain('javascript:')
    expect(result.match(/摘要/g)!.length).toBeLessThanOrEqual(150)
    expect((await db.pool.query('select status from search_call')).rows).toEqual([{ status: 'ok' }])
  })

  it('服务失败时明确报错，不返回结果，也不暴露密钥', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    status = 432
    const result = await run()
    expect(result).toContain('联网搜索失败')
    expect(result).toContain('"isError":true')
    expect(result).not.toContain('tvly-test')
    expect((await db.pool.query('select status from search_call')).rows).toEqual([{ status: 'failed' }])
    error.mockRestore()
  })

  it('每日上限用完后不再请求搜索服务', async () => {
    await run(1)
    expect(requests).toHaveLength(1)
    const result = await run(1)
    expect(result).toContain('额度已用完')
    expect(requests).toHaveLength(1)
  })
})
