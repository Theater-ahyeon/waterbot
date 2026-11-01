import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { defineTool, type SubmissionId } from '@earendil-works/pi-durable'

import { openRuntime } from '../../src/runtime/runtime'

/**
 * 恢复测试用的独立子进程。
 *
 * phase=first：提交一次输入，工具写入真实副作用后写 marker 并永久挂起，
 *              由父测试进程在“已执行、未回执”时 SIGKILL。
 * phase=second：打开同一个 SQLite，恢复未完成工作，落盘 transcript 摘要。
 *
 * runs.log 只是测试探针（每次 execute 记一行），effects.log 才是被建模的副作用。
 */

const mode = process.env.PA_CHILD_MODE === 'safe' ? 'safe' : 'unsafe'
const phase = process.env.PA_CHILD_PHASE === 'second' ? 'second' : 'first'
const databasePath = required('PA_CHILD_DB')
const dir = required('PA_CHILD_DIR')

const markerPath = join(dir, 'started.marker')
const effectsPath = join(dir, 'effects.log')
const runsPath = join(dir, 'runs.log')

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`)
  }
  return value
}

const noteTool = defineTool({
  name: 'note_file',
  description: 'Append one line to the effects log. Blocks on its first run.',
  parameters: Type.Object({ text: Type.String() }),
  replay: mode === 'safe' ? 'safe' : 'unsafe',
  execute: async (args) => {
    await mkdir(dir, { recursive: true })
    await appendFile(runsPath, `${mode}:${phase}\n`, 'utf8')

    if (mode === 'safe' && existsSync(markerPath)) {
      // 重放路径：副作用按调用幂等落盘，不重复追加
      await writeFile(join(dir, 'safe-note.txt'), `note:${args.text}\n`, 'utf8')
      return { output: [{ type: 'text', text: 'note-stored' }] }
    }

    // 真实副作用先发生，再挂起：父进程杀进程时处于“已执行、未回执”窗口
    await appendFile(effectsPath, `${args.text}\n`, 'utf8')

    if (!existsSync(markerPath)) {
      await writeFile(markerPath, String(process.pid), 'utf8')
      await new Promise<never>(() => undefined)
    }

    return { output: [{ type: 'text', text: 'note-stored' }] }
  },
})

if (phase === 'first') {
  const runtime = await openRuntime({
    databasePath,
    tools: [noteTool],
    responses: [
      fauxAssistantMessage([fauxToolCall('note_file', { text: 'hello' })], {
        stopReason: 'toolUse',
      }),
    ],
  })
  runtime.resume()

  const submission = await runtime.conversation.submit(
    { type: 'input', content: 'write the note', requestId: 'crash-1' },
    BACKGROUND_CONTEXT,
  )
  await writeFile(
    join(dir, 'submission.json'),
    JSON.stringify({ id: submission.id }),
    'utf8',
  )

  await submission.wait(BACKGROUND_CONTEXT)
  await runtime.close()
} else {
  const runtime = await openRuntime({
    databasePath,
    tools: [noteTool],
    responses: [fauxAssistantMessage('finished after restart')],
  })
  runtime.resume()

  const { id } = JSON.parse(
    await readFile(join(dir, 'submission.json'), 'utf8'),
  ) as { id: number }
  const submission = await runtime.harness.submission(
    id as SubmissionId,
    BACKGROUND_CONTEXT,
  )
  const settled = submission ? await submission.wait(BACKGROUND_CONTEXT) : undefined

  const view = await runtime.conversation.context(BACKGROUND_CONTEXT)
  const entries = view.entries.map((entry) => ({
    kind: entry.kind,
    diagnostics: (entry.data as { diagnostics?: unknown } | undefined)?.diagnostics ?? null,
    model: entry.model ?? null,
  }))

  await writeFile(
    join(dir, 'second.json'),
    JSON.stringify({ status: settled?.status ?? 'missing', entries }, null, 1),
    'utf8',
  )

  await runtime.close()
}
