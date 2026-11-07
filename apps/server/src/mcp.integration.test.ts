import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { McpService } from './mcp'

const fixture = fileURLToPath(new URL('../test/fixtures/mcp-echo-server.mjs', import.meta.url))

describe('MCP stdio 客户端（真实子进程 / PostgreSQL）', () => {
  let db: TestDatabase
  let service: McpService
  let profile: string
  let server: string

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    service = new McpService(db.pool)
    await service.start()
    profile = '33333333-3333-4333-8333-333333333333'
    await db.pool.query('insert into profile(id,name,instructions) values ($1,$2,$3)', [profile, 'MCP 测试', '测试'])
    server = (await service.addServer({ name: 'echo-test', command: process.execPath, args: [fixture] })).id
  })

  afterAll(async () => {
    await service?.close()
    await db?.dispose()
  })

  it('连接、发现工具、按人格绑定并调用', async () => {
    const tools = await service.refresh(server)
    expect(tools.map((tool) => tool.name).sort()).toEqual(['echo', 'sum'])
    await service.bind(profile, server)
    await expect(service.call(profile, 'echo-test', 'echo', { text: 'hello' })).resolves.toBe('echo:hello')
    await expect(service.call(profile, 'echo-test', 'sum', { a: 2, b: 3 })).resolves.toBe('5')
    const calls = await service.calls()
    expect(calls[0]).toMatchObject({ status: 'ok', tool_name: 'sum' })
    expect(calls[1]).toMatchObject({ status: 'ok', tool_name: 'echo' })
  })

  it('未绑定或工具被关闭时拒绝调用', async () => {
    await service.unbind(profile, server)
    await expect(service.call(profile, 'echo-test', 'echo', { text: 'x' })).rejects.toThrow('未启用')
    await service.bind(profile, server)
    await service.setToolEnabled(server, 'echo', false)
    await expect(service.call(profile, 'echo-test', 'echo', { text: 'x' })).rejects.toThrow('工具未启用')
    await service.setToolEnabled(server, 'echo', true)
  })
})
