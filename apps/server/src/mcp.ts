import { randomUUID } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'

import { HttpError } from './http'
import type { Pool } from './pg/connection'

export interface McpServerRow {
  id: string
  name: string
  command: string
  args: string[]
  cwd: string | null
  state: 'idle' | 'ready' | 'paused'
  last_error: string | null
  profile_ids: string[]
  created_at: Date
  updated_at: Date
}

export interface McpToolRow {
  server_id: string
  name: string
  description: string
  enabled: boolean
  schema: unknown
  updated_at: Date
}

export interface McpCallRow {
  id: string
  profile_id: string
  server_id: string
  tool_name: string
  arguments: unknown
  status: 'started' | 'ok' | 'failed'
  output: string | null
  error: string | null
  created_at: Date
  finished_at: Date | null
}

interface Connection {
  client: Client
  transport: StdioClientTransport
}

const MAX_OUTPUT = 20_000

export class McpService {
  private readonly clients = new Map<string, Connection>()

  constructor(private readonly pool: Pool) {}

  async start(): Promise<void> {
    await this.pool.query(`update mcp_server set state = 'idle', updated_at = clock_timestamp() where state = 'ready'`)
  }

  async listServers(): Promise<McpServerRow[]> {
    return (await this.pool.query<McpServerRow>(
      `select s.*, coalesce(array_agg(b.profile_id) filter (where b.profile_id is not null), '{}') as profile_ids
         from mcp_server s left join mcp_binding b on b.server_id = s.id
        group by s.id order by s.created_at`,
    )).rows
  }

  async addServer(input: { name: string; command: string; args?: string[]; cwd?: string }): Promise<McpServerRow> {
    const name = input.name.trim()
    const command = input.command.trim()
    if (!name || !command) throw new HttpError(400, 'MCP 服务名称和命令不能为空')
    if (name.length > 80 || command.length > 500) throw new HttpError(400, 'MCP 服务字段过长')
    const args = input.args ?? []
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new HttpError(400, 'MCP 参数必须是字符串数组')
    return (await this.pool.query<McpServerRow>(
      `insert into mcp_server(id, name, command, args, cwd) values ($1,$2,$3,$4,$5) returning *`,
      [randomUUID(), name, command, JSON.stringify(args), input.cwd?.trim() || null],
    )).rows[0]!
  }

  async tools(serverId: string): Promise<McpToolRow[]> {
    return (await this.pool.query<McpToolRow>(
      'select * from mcp_tool where server_id = $1 order by name', [serverId],
    )).rows
  }

  async bind(profileId: string, serverId: string): Promise<void> {
    await this.pool.query(
      `insert into mcp_binding(profile_id, server_id) values ($1,$2) on conflict do nothing`, [profileId, serverId],
    )
  }

  async unbind(profileId: string, serverId: string): Promise<void> {
    await this.pool.query('delete from mcp_binding where profile_id = $1 and server_id = $2', [profileId, serverId])
  }

  async setToolEnabled(serverId: string, name: string, enabled: boolean): Promise<void> {
    const result = await this.pool.query(
      'update mcp_tool set enabled = $3, updated_at = clock_timestamp() where server_id = $1 and name = $2',
      [serverId, name, enabled],
    )
    if (!result.rowCount) throw new HttpError(404, 'MCP 工具不存在')
  }

  async refresh(serverId: string): Promise<McpToolRow[]> {
    await this.disconnect(serverId)
    const server = (await this.pool.query<McpServerRow>('select * from mcp_server where id = $1', [serverId])).rows[0]
    if (!server) throw new HttpError(404, 'MCP 服务不存在')
    try {
      const connection = await this.connect(server)
      const listed = await connection.client.listTools()
      for (const tool of listed.tools) {
        await this.pool.query(
          `insert into mcp_tool(server_id, name, description, schema) values ($1,$2,$3,$4)
           on conflict (server_id, name) do update set description = excluded.description, schema = excluded.schema, updated_at = clock_timestamp()`,
          [serverId, tool.name, tool.description ?? '', JSON.stringify(tool.inputSchema ?? {})],
        )
      }
      await this.pool.query(
        `update mcp_server set state = 'ready', last_error = null, updated_at = clock_timestamp() where id = $1`, [serverId],
      )
      return this.tools(serverId)
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      await this.pool.query(
        `update mcp_server set state = 'paused', last_error = $2, updated_at = clock_timestamp() where id = $1`,
        [serverId, message],
      )
      throw new HttpError(502, `MCP 服务连接失败：${message}`)
    }
  }

  private async connect(server: McpServerRow): Promise<Connection> {
    const transport = new StdioClientTransport({
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      ...(server.cwd ? { cwd: server.cwd } : {}),
      env: getDefaultEnvironment(),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'waterbot', version: '0.1.0' }, { capabilities: {} })
    await client.connect(transport)
    const connection = { client, transport }
    this.clients.set(server.id, connection)
    return connection
  }

  private async connection(server: McpServerRow): Promise<Connection> {
    const existing = this.clients.get(server.id)
    if (existing) return existing
    const connection = await this.connect(server)
    await this.pool.query(`update mcp_server set state = 'ready', last_error = null, updated_at = clock_timestamp() where id = $1`, [server.id])
    return connection
  }

  /** 只允许 owner 私聊会话调用；QQ 群和 Bot 群不暴露 MCP。 */
  async callFromConversation(conversationId: string, serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const binding = (await this.pool.query<{ profile_id: string; scope_kind: string }>(
      'select profile_id, scope_kind from conversation_binding where pi_conversation_id = $1', [conversationId],
    )).rows[0]
    if (!binding || binding.scope_kind !== 'owner_private') throw new Error('MCP 只在 owner 私聊会话可用')
    return this.call(binding.profile_id, serverName, toolName, args)
  }

  async call(profileId: string, serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = (await this.pool.query<McpServerRow>('select * from mcp_server where name = $1', [serverName])).rows[0]
    if (!server) throw new HttpError(404, 'MCP 服务不存在')
    const bound = await this.pool.query(
      'select 1 from mcp_binding where profile_id = $1 and server_id = $2', [profileId, server.id],
    )
    if (!bound.rowCount) throw new HttpError(403, '该人格未启用这个 MCP 服务')
    const tool = (await this.pool.query<McpToolRow>(
      'select * from mcp_tool where server_id = $1 and name = $2 and enabled', [server.id, toolName],
    )).rows[0]
    if (!tool) throw new HttpError(403, 'MCP 工具未启用')
    const payload = JSON.stringify(args)
    if (payload.length > 20_000) throw new HttpError(400, 'MCP 参数过大')
    const callId = randomUUID()
    await this.pool.query(
      `insert into mcp_call(id, profile_id, server_id, tool_name, arguments) values ($1,$2,$3,$4,$5)`,
      [callId, profileId, server.id, toolName, payload],
    )
    try {
      const connection = await this.connection(server)
      const result = await connection.client.callTool({ name: toolName, arguments: args })
      const content: readonly { type?: unknown; text?: unknown }[] = Array.isArray(result.content) ? result.content : []
      const text = content.map((item) =>
        item.type === 'text' && typeof item.text === 'string' ? item.text : '[非文本内容]').join('\n').slice(0, MAX_OUTPUT)
      const status = result.isError ? 'failed' : 'ok'
      await this.pool.query(
        `update mcp_call set status = $2, output = $3, error = $4, finished_at = clock_timestamp() where id = $1`,
        [callId, status, text, result.isError ? '工具返回错误' : null],
      )
      if (result.isError) throw new Error(text || 'MCP 工具返回错误')
      return text
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      await this.pool.query(
        `update mcp_call set status = 'failed', error = $2, finished_at = clock_timestamp() where id = $1 and status = 'started'`,
        [callId, message],
      )
      throw error
    }
  }

  async calls(limit = 100): Promise<McpCallRow[]> {
    return (await this.pool.query<McpCallRow>(
      'select * from mcp_call order by created_at desc limit $1', [Math.min(Math.max(limit, 1), 200)],
    )).rows
  }

  private async disconnect(serverId: string): Promise<void> {
    const connection = this.clients.get(serverId)
    if (!connection) return
    this.clients.delete(serverId)
    await connection.client.close().catch(() => undefined)
  }

  async close(): Promise<void> {
    for (const id of [...this.clients.keys()]) await this.disconnect(id)
  }
}

export function createMcpTool(get: () => McpService | undefined): ToolRegistration {
  return defineTool({
    name: 'mcp_call',
    description: '调用已安装、已绑定到当前人格并启用的 MCP 工具。只在 owner 私聊可用。',
    parameters: Type.Object({
      server: Type.String({ minLength: 1, maxLength: 80 }),
      tool: Type.String({ minLength: 1, maxLength: 120 }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    replay: 'unsafe',
    execute: async (args, api) => {
      const service = get()
      if (!service) throw new Error('MCP 未启用')
      const text = await service.callFromConversation(
        String(api.conversationId), args.server, args.tool, (args.arguments ?? {}) as Record<string, unknown>,
      )
      return { output: [{ type: 'text', text }] }
    },
  })
}
