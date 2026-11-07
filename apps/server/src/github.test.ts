import { createServer, type Server } from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { GithubService } from './github'

describe('GitHub 只读连接器', () => {
  let server: Server
  let base = ''
  let authorization = ''
  let service: GithubService

  beforeAll(async () => {
    server = createServer((request, response) => {
      authorization = String(request.headers.authorization ?? '')
      if (request.url === '/repos/octocat/Hello-World') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          full_name: 'octocat/Hello-World',
          description: 'My first repository',
          html_url: 'https://github.com/octocat/Hello-World',
          stargazers_count: 42,
          default_branch: 'master',
          private: false,
        }))
        return
      }
      if (request.url?.startsWith('/repos/octocat/Hello-World/issues')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify([
          { number: 1, title: 'Issue one', state: 'open', html_url: 'https://github.com/octocat/Hello-World/issues/1', user: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
          { number: 2, title: 'Pull request', state: 'open', html_url: 'https://github.com/octocat/Hello-World/pull/2', user: { login: 'bob' }, created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-04T00:00:00Z', pull_request: {} },
        ]))
        return
      }
      if (request.url === '/repos/broken/repo') {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('upstream exploded')
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture 未启动')
    base = `http://127.0.0.1:${address.port}`
    service = new GithubService({ baseUrl: base, token: 'test-token' })
  })

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
  })

  it('读取仓库元数据并发送 token', async () => {
    const repo = await service.repo('octocat', 'Hello-World')
    expect(repo).toEqual({
      full_name: 'octocat/Hello-World',
      description: 'My first repository',
      html_url: 'https://github.com/octocat/Hello-World',
      stargazers_count: 42,
      default_branch: 'master',
      private: false,
    })
    expect(authorization).toBe('Bearer test-token')
    expect(service.status()).toEqual({ configured: true, authenticated: true, baseUrl: base })
  })

  it('读取 issue 列表并区分 pull request', async () => {
    const issues = await service.issues('octocat', 'Hello-World', 'all')
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({ number: 1, title: 'Issue one', user: 'alice', pull_request: false })
    expect(issues[1]).toMatchObject({ number: 2, title: 'Pull request', user: 'bob', pull_request: true })
  })

  it('拒绝非法仓库名，上游错误转成明确失败', async () => {
    await expect(service.repo('bad name', 'repo')).rejects.toThrow('仓库所有者')
    await expect(service.repo('owner', '')).rejects.toThrow('仓库名')
    await expect(service.issues('octocat', 'Hello-World', 'bad' as 'open')).rejects.toThrow('issue 状态')
    await expect(service.repo('broken', 'repo')).rejects.toThrow('GitHub 返回 500')
  })
})
