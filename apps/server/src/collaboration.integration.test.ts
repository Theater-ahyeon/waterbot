import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { BotCollaboration, createBotMessageTool } from './collaboration'
import { Memories } from './memory'
import { createContextExtension } from './memory-context'
import { Profiles } from './profiles'
import { createEchoTool, openRuntime, type AgentRuntime } from './runtime'

describe('多 Bot 协作（真实 PG / Pi，脚本模型）', () => {
  let db: TestDatabase
  let dir: string
  let runtime: AgentRuntime
  let profiles: Profiles
  let collaboration: BotCollaboration
  let a: string
  let b: string
  let c: string

  const waitFor = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'wb-collab-'))
    const memories = new Memories(db.pool)
    const tool = createBotMessageTool(() => collaboration)
    const context = createContextExtension(memories, 'faux/faux-1', undefined, [tool])
    runtime = await openRuntime({
      databasePath: join(dir, 'runtime.sqlite'),
      tools: [createEchoTool()],
      extensions: [context],
      responses: Array.from({ length: 40 }, () => scriptedStep()),
    })
    profiles = new Profiles(db.pool, runtime)
    collaboration = new BotCollaboration(db.pool, runtime, profiles)
    a = (await profiles.create({ name: 'Alpha', instructions: '负责研究' })).id
    b = (await profiles.create({ name: 'Beta', instructions: '负责写作' })).id
    c = (await profiles.create({ name: 'Gamma', instructions: '负责检查' })).id
  })

  afterAll(async () => {
    await collaboration?.close()
    await runtime?.close()
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('三个 Bot 依次交接，消息、任务和结果可追踪', async () => {
    const group = await collaboration.createGroup('研究小组', [a, b, c])
    const { task } = await collaboration.post({
      groupId: group.id,
      targetProfileId: a,
      content: '研究这个问题并交给 Beta',
    })
    expect(task?.status).toBe('dispatched')
    await waitFor(async () => {
      await collaboration.runOnce()
      const tasks = await collaboration.tasks(group.id)
      return tasks.length === 3 && tasks.every((item) => item.status === 'done')
    }, '三条任务完成')
    const tasks = await collaboration.tasks(group.id)
    expect(tasks.map((item) => item.status)).toEqual(['done', 'done', 'done'])
    const messages = await collaboration.messages(group.id)
    expect(messages.some((message) => message.content === '请写一段总结')).toBe(true)
    expect(messages.some((message) => message.content === '请检查这段总结')).toBe(true)
    expect(messages.some((message) => message.content.includes('Gamma 检查完成'))).toBe(true)
    expect(messages.some((message) => message.content.includes('Alpha 完成研究'))).toBe(true)
    expect(messages.some((message) => message.content.includes('Beta 完成写作'))).toBe(true)
  })

  it('同一工具调用 ID 重投不会重复创建消息或任务', async () => {
    const group = await collaboration.createGroup('幂等小组', [a, b])
    const first = await collaboration.sendFromTool(
      String((await profiles.conversation(a, { suffix: `bot_group:${group.id}`, scopeKind: 'bot_group', scopeRef: group.id, readableGroups: [] })).conversation.id),
      'call-fixed',
      'Beta',
      '只发一次',
    )
    const second = await collaboration.sendFromTool(
      String((await profiles.conversation(a, { suffix: `bot_group:${group.id}`, scopeKind: 'bot_group', scopeRef: group.id, readableGroups: [] })).conversation.id),
      'call-fixed',
      'Beta',
      '只发一次',
    )
    expect(first).toBe(second)
    expect((await collaboration.messages(group.id)).filter((message) => message.content === '只发一次')).toHaveLength(1)
    expect((await collaboration.tasks(group.id)).length).toBe(1)
  })

  it('目标不是成员或群已停止时拒绝新任务', async () => {
    const group = await collaboration.createGroup('边界小组', [a, b])
    await expect(collaboration.post({ groupId: group.id, targetProfileId: c, content: '越权' })).rejects.toThrow(/不是本群成员/)
    await collaboration.stop(group.id)
    await expect(collaboration.post({ groupId: group.id, targetProfileId: a, content: '停止后' })).rejects.toThrow(/已停止/)
    await collaboration.resume(group.id)
  })
})

/** 根据对话上下文决定下一步，避免多个会话争抢固定顺序的脚本。 */
function scriptedStep(): FauxResponseStep {
  return (context) => {
    const lastUser = [...context.messages].reverse().find((message) => message.role === 'user')
    const text = typeof lastUser?.content === 'string'
      ? lastUser.content
      : lastUser?.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('') ?? ''
    const hasHandoff = context.messages.some((message) =>
      JSON.stringify(message.content).includes('已发送给'))
    if (text.includes('来自 owner')) {
      return hasHandoff
        ? fauxAssistantMessage('Alpha 完成研究，已交接')
        : fauxAssistantMessage([fauxToolCall('send_bot_message', { to: 'Beta', content: '请写一段总结' })], { stopReason: 'toolUse' })
    }
    if (text.includes('来自 Alpha')) {
      return hasHandoff
        ? fauxAssistantMessage('Beta 完成写作，已交接')
        : fauxAssistantMessage([fauxToolCall('send_bot_message', { to: 'Gamma', content: '请检查这段总结' })], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage('Gamma 检查完成')
  }
}

