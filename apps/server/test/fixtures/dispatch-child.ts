import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'

import { dispatchOnce } from '../../src/dispatch/dispatcher'
import { createPool } from '../../src/pg/connection'
import { createEchoTool, openRuntime } from '../../src/runtime'

/**
 * 两库崩溃窗口测试的派发子进程：
 * 真实 Pi 提交成功 → 写 accepted.json + marker → 挂起，
 * 由父进程在“Pi 已受理、PG 映射未保存”时 SIGKILL。
 */

const url = required('PA_PG_URL')
const piDb = required('PA_PI_DB')
const dir = required('PA_DIR')
const conversationKey = process.env.PA_CONVERSATION_KEY ?? 'owner:default'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`)
  }
  return value
}

const runtime = await openRuntime({
  databasePath: piDb,
  tools: [createEchoTool()],
  conversationKey,
  responses: [
    fauxAssistantMessage([fauxToolCall('echo', { text: 'hi' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ],
})

const pool = createPool(url, 2)

await dispatchOnce({
  pool,
  runtime,
  owner: 'child-dispatcher',
  conversationKey,
  // 租约短一些，父进程重启后不必等太久
  leaseMs: 500,
  afterSubmit: async ({ submissionId }) => {
    await writeFile(
      join(dir, 'accepted.json'),
      JSON.stringify({ submissionId }),
      'utf8',
    )
    await writeFile(join(dir, 'accepted.marker'), '1', 'utf8')
    await new Promise<never>(() => undefined)
  },
})

await pool.end()
await runtime.close()
