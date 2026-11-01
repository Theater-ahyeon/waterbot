import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { defineTool } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openRuntime, type AgentRuntime } from './runtime'
import { createFileNoteTool } from './tools'

const CONTEXT = BACKGROUND_CONTEXT

type Entries = Awaited<
  ReturnType<AgentRuntime['conversation']['context']>
>['entries']

type ToolResultMessage = {
  isError?: boolean
  content?: readonly { type: string; text?: string }[]
}

function readToolResult(entries: Entries) {
  const entry = entries.find((candidate) => candidate.kind === 'pi.tool-result')
  const message = entry?.model?.[0] as ToolResultMessage | undefined
  const text =
    message?.content?.flatMap((block) => (block.text ? [block.text] : [])).join('') ?? ''

  return { found: entry !== undefined, isError: message?.isError === true, text }
}

function scripted(
  toolName: string,
  args: Record<string, string>,
  answer: string,
): FauxResponseStep[] {
  return [
    fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: 'toolUse' }),
    fauxAssistantMessage(answer),
  ]
}

/** 带执行计数的 echo：测试需要知道工具真实跑了几次。 */
function countingEcho() {
  const runs: string[] = []
  const tool = defineTool({
    name: 'echo',
    description: 'Echo text and count executions.',
    parameters: Type.Object({ text: Type.String() }),
    replay: 'safe',
    execute: async (args) => {
      runs.push(args.text)
      return { output: [{ type: 'text', text: `echo:${args.text}` }] }
    },
  })

  return { tool, runs }
}

describe('runtime 会话持久化与 requestId 去重（真实 SQLite）', () => {
  let dir = ''
  let runtime: AgentRuntime | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-runtime-'))
  })

  afterEach(async () => {
    await runtime?.close()
    runtime = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('一次提交完成工具轮次，结果写入 transcript', async () => {
    const { tool, runs } = countingEcho()
    runtime = await openRuntime({
      databasePath: join(dir, 'runtime.sqlite'),
      tools: [tool],
      responses: scripted('echo', { text: 'hi' }, 'done'),
    })

    const settled = await runtime.submit({ content: 'say hi', requestId: 'req-1' })
    expect(settled.status).toBe('done')

    const view = await runtime.conversation.context(CONTEXT)
    expect(view.entries.map((entry) => entry.kind)).toEqual([
      'pi.user',
      'pi.system',
      'pi.assistant',
      'pi.tool-result',
      'pi.assistant',
    ])
    expect(readToolResult(view.entries)).toEqual({
      found: true,
      isError: false,
      text: 'echo:hi',
    })
    expect(runs).toEqual(['hi'])
  })

  it('相同 requestId 返回同一提交，不重复执行工具、不追加条目', async () => {
    const { tool, runs } = countingEcho()
    runtime = await openRuntime({
      databasePath: join(dir, 'runtime.sqlite'),
      tools: [tool],
      responses: scripted('echo', { text: 'once' }, 'done'),
    })

    const first = await runtime.submit({ content: 'go', requestId: 'dup-1' })
    const entriesAfterFirst = (await runtime.conversation.context(CONTEXT)).entries
      .length

    const second = await runtime.submit({ content: 'go', requestId: 'dup-1' })
    const entriesAfterSecond = (await runtime.conversation.context(CONTEXT)).entries
      .length

    expect(second.id).toBe(first.id)
    expect(second.status).toBe('done')
    expect(runs).toEqual(['once'])
    expect(entriesAfterSecond).toBe(entriesAfterFirst)
  })

  it('关闭后重开复用同一根会话与已有历史', async () => {
    const { tool } = countingEcho()
    const databasePath = join(dir, 'runtime.sqlite')

    runtime = await openRuntime({
      databasePath,
      tools: [tool],
      responses: scripted('echo', { text: 'first' }, 'first-answer'),
    })
    const conversationId = runtime.conversation.id
    await runtime.submit({ content: 'first', requestId: 'req-1' })
    const before = (await runtime.conversation.context(CONTEXT)).entries.length
    await runtime.close()
    runtime = undefined

    runtime = await openRuntime({
      databasePath,
      tools: [tool],
      responses: [fauxAssistantMessage('second-answer')],
    })

    expect(runtime.conversation.id).toBe(conversationId)
    const retained = await runtime.conversation.context(CONTEXT)
    expect(retained.entries.length).toBe(before)

    const settled = await runtime.submit({ content: 'second', requestId: 'req-2' })
    expect(settled.status).toBe('done')
    expect(
      (await runtime.conversation.context(CONTEXT)).entries.length,
    ).toBeGreaterThan(before)
  })

  it('关闭重开后用原 requestId 重投：同一提交，历史与副作用都不重复', async () => {
    const notes = join(dir, 'notes')
    const databasePath = join(dir, 'runtime.sqlite')
    const tool = createFileNoteTool({ directory: notes })

    runtime = await openRuntime({
      databasePath,
      tools: [tool],
      responses: scripted('note_file', { text: 'hello' }, 'noted'),
    })
    const first = await runtime.submit({ content: 'write', requestId: 'redeliver-1' })
    const entriesBefore = (await runtime.conversation.context(CONTEXT)).entries.length
    const conversationId = runtime.conversation.id
    await runtime.close()
    runtime = undefined

    // 重开且不给脚本应答：若重投被当成新请求，就会去请求模型并新增条目
    runtime = await openRuntime({ databasePath, tools: [tool], responses: [] })
    expect(runtime.conversation.id).toBe(conversationId)

    const again = await runtime.submit({ content: 'write', requestId: 'redeliver-1' })

    expect(again.id).toBe(first.id)
    expect(again.status).toBe('done')
    expect((await runtime.conversation.context(CONTEXT)).entries.length).toBe(
      entriesBefore,
    )
    expect(await readFile(join(notes, 'notes.log'), 'utf8')).toBe('hello\n')
  })

  it('未中断时 unsafe 工具只产生一次副作用', async () => {
    const notes = join(dir, 'notes')
    runtime = await openRuntime({
      databasePath: join(dir, 'runtime.sqlite'),
      tools: [createFileNoteTool({ directory: notes })],
      responses: scripted('note_file', { text: 'hello' }, 'noted'),
    })

    await runtime.submit({ content: 'write', requestId: 'note-1' })
    expect(await readFile(join(notes, 'notes.log'), 'utf8')).toBe('hello\n')

    await runtime.submit({ content: 'write', requestId: 'note-1' })
    expect(await readFile(join(notes, 'notes.log'), 'utf8')).toBe('hello\n')
  })

  it('同一 SQLite 重开不得改绑其他会话，拒绝后原会话仍可打开', async () => {
    const databasePath = join(dir, 'runtime.sqlite')
    const { tool } = countingEcho()
    runtime = await openRuntime({
      databasePath,
      tools: [tool],
      conversationKey: 'owner:a',
      responses: [fauxAssistantMessage('a-only')],
    })
    await runtime.submit({ content: 'a-private', requestId: 'binding-a' })
    const conversationId = runtime.conversation.id
    await runtime.close()
    runtime = undefined

    const other = openRuntime({ databasePath, tools: [tool], conversationKey: 'owner:b' })
    try {
      await expect(other).rejects.toThrow(/会话绑定/)
    } finally {
      await other.then((opened) => opened.close(), () => undefined)
    }

    runtime = await openRuntime({ databasePath, tools: [tool], conversationKey: 'owner:a' })
    expect(runtime.conversation.id).toBe(conversationId)
    expect((await runtime.conversation.context(CONTEXT)).entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
  })

  it('clean shutdown 释放 SQLite，WAL / SHM 不残留', async () => {
    const { tool } = countingEcho()
    const databasePath = join(dir, 'runtime.sqlite')
    runtime = await openRuntime({
      databasePath,
      tools: [tool],
      responses: scripted('echo', { text: 'x' }, 'ok'),
    })
    await runtime.submit({ content: 'x', requestId: 'shutdown-1' })

    const harness = runtime.harness
    await runtime.close()
    runtime = undefined

    await expect(harness.closed).resolves.toMatchObject({ reason: 'closed' })
    const files = (await readdir(dir)).sort()
    expect(files).toContain('runtime.sqlite')
    expect(files.filter((name) => name.endsWith('-wal') || name.endsWith('-shm'))).toEqual(
      [],
    )
  })
})
