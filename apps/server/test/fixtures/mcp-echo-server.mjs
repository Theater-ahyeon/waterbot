import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'waterbot-test-echo', version: '1.0.0' })

server.registerTool('echo', {
  description: '回显输入文本',
  inputSchema: { text: z.string() },
}, async ({ text }) => ({
  content: [{ type: 'text', text: `echo:${text}` }],
}))

server.registerTool('sum', {
  description: '两个数字相加',
  inputSchema: { a: z.number(), b: z.number() },
}, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}))

await server.connect(new StdioServerTransport())
