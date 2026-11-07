import { createHash, randomUUID } from 'node:crypto'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type Conversation, type ConversationId, type SubmissionId, type ToolRegistration } from '@earendil-works/pi-durable'

import { entryText } from './chat'
import { HttpError, textField } from './http'
import { withTransaction, type Pool } from './pg/connection'
import type { Profiles } from './profiles'
import type { AgentRuntime } from './runtime'

export interface BotGroup {
  id: string
  name: string
  stopped: boolean
  created_at: Date
}

export interface BotGroupMember {
  group_id: string
  profile_id: string
  name: string
  role: 'lead' | 'member'
}

export interface BotMessage {
  id: string
  group_id: string
  sender_profile_id: string | null
  sender_label: string
  target_profile_id: string | null
  content: string
  reply_to: string | null
  created_at: Date
}

export interface BotTask {
  id: string
  group_id: string
  message_id: string
  from_profile_id: string | null
  to_profile_id: string
  pi_conversation_id: string
  pi_submission_id: string | null
  status: 'queued' | 'dispatched' | 'done' | 'failed' | 'cancelled'
  last_error: string | null
  created_at: Date
}

const taskRequestId = (groupId: string, messageId: string, toProfileId: string): string =>
  createHash('sha256').update(`bot:${groupId}:${messageId}:${toProfileId}`).digest('hex')

export class BotCollaboration {
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | undefined
  private closed = false

  constructor(
    private readonly pool: Pool,
    private readonly runtime: AgentRuntime,
    private readonly profiles: Profiles,
  ) {}

  start(): void {
    this.timer = setInterval(() => { void this.pump() }, 1000)
    void this.pump()
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await this.running
  }

  async createGroup(name: string, memberIds: readonly string[]): Promise<BotGroup> {
    const title = textField(name, '群名称', 80).trim()
    if (memberIds.length < 2) throw new HttpError(400, 'Bot 群至少需要两个成员')
    const unique = [...new Set(memberIds)]
    if (unique.length !== memberIds.length) throw new HttpError(400, 'Bot 群成员不能重复')
    for (const id of unique) await this.profiles.get(id)
    return withTransaction(this.pool, async (client) => {
      const id = randomUUID()
      const group = (await client.query<BotGroup>(
        'insert into bot_group(id, name) values ($1,$2) returning *', [id, title],
      )).rows[0]!
      for (const [index, profileId] of unique.entries()) {
        await client.query(
          'insert into bot_group_member(group_id, profile_id, role) values ($1,$2,$3)',
          [id, profileId, index === 0 ? 'lead' : 'member'],
        )
      }
      return group
    })
  }

  async listGroups(): Promise<BotGroup[]> {
    return (await this.pool.query<BotGroup>('select * from bot_group order by created_at desc')).rows
  }

  async getGroup(id: string): Promise<BotGroup> {
    const group = (await this.pool.query<BotGroup>('select * from bot_group where id = $1', [id])).rows[0]
    if (!group) throw new HttpError(404, 'Bot 群不存在')
    return group
  }

  async members(groupId: string): Promise<BotGroupMember[]> {
    return (await this.pool.query<BotGroupMember>(
      `select m.group_id, m.profile_id, p.name, m.role
         from bot_group_member m join profile p on p.id = m.profile_id
        where m.group_id = $1 order by m.role, p.created_at`, [groupId],
    )).rows
  }

  async messages(groupId: string): Promise<BotMessage[]> {
    return (await this.pool.query<BotMessage>(
      'select * from bot_message where group_id = $1 order by created_at limit 200', [groupId],
    )).rows
  }

  async tasks(groupId: string): Promise<BotTask[]> {
    return (await this.pool.query<BotTask>(
      'select * from bot_task where group_id = $1 order by created_at desc limit 100', [groupId],
    )).rows
  }

  /** Owner 或工具发起的消息；target 必须是本群成员。 */
  async post(input: {
    groupId: string
    senderProfileId?: string
    senderLabel?: string
    targetProfileId: string
    content: string
    externalRef?: string
  }): Promise<{ message: BotMessage; task: BotTask | undefined }> {
    const group = await this.getGroup(input.groupId)
    if (group.stopped) throw new HttpError(409, 'Bot 群已停止')
    const content = textField(input.content, '内容', 8000)
    const target = (await this.pool.query<{ id: string; name: string }>(
      `select p.id, p.name from bot_group_member m join profile p on p.id = m.profile_id
        where m.group_id = $1 and p.id = $2`, [input.groupId, input.targetProfileId],
    )).rows[0]
    if (!target) throw new HttpError(400, '目标不是本群成员')
    if (input.senderProfileId) {
      const sender = (await this.pool.query(
        'select 1 from bot_group_member where group_id = $1 and profile_id = $2', [input.groupId, input.senderProfileId],
      )).rowCount
      if (!sender) throw new HttpError(400, '发送者不是本群成员')
    }
    const { conversation } = await this.profiles.conversation(target.id, {
      suffix: `bot_group:${input.groupId}`,
      scopeKind: 'bot_group',
      scopeRef: input.groupId,
      readableGroups: [],
    })
    const inserted = await withTransaction(this.pool, async (client) => {
      const message = (await client.query<BotMessage>(
        `insert into bot_message(id, group_id, sender_profile_id, sender_label, target_profile_id, external_ref, content)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (group_id, external_ref) do nothing returning *`,
        [randomUUID(), input.groupId, input.senderProfileId ?? null, input.senderLabel ?? 'owner', target.id, input.externalRef ?? null, content],
      )).rows[0]
      if (!message) {
        const existing = (await client.query<BotMessage>(
          'select * from bot_message where group_id = $1 and external_ref = $2', [input.groupId, input.externalRef],
        )).rows[0]!
        return { message: existing, task: undefined }
      }
      const task = (await client.query<BotTask>(
        `insert into bot_task(id, group_id, message_id, from_profile_id, to_profile_id, pi_conversation_id)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [randomUUID(), input.groupId, message.id, input.senderProfileId ?? null, target.id, String(conversation.id)],
      )).rows[0]!
      return { message, task }
    })
    if (!inserted.task) return { message: inserted.message, task: undefined }
    return this.dispatch(inserted.task, conversation, inserted.message, target.name)
  }

  private async dispatch(
    task: BotTask,
    conversation: Conversation,
    message: BotMessage,
    targetName: string,
  ): Promise<{ message: BotMessage; task: BotTask }> {
    const sender = message.sender_label || '成员'
    const prompt = `[Bot群 ${task.group_id} · 来自 ${sender} · 消息 ${message.id}] ${message.content}`
    try {
      const submission = await conversation.submit({
        type: 'input',
        content: prompt,
        requestId: taskRequestId(task.group_id, task.message_id, task.to_profile_id),
        whenBusy: 'followUp',
      }, BACKGROUND_CONTEXT) as { id: number | string }
      const updated = (await this.pool.query<BotTask>(
        `update bot_task set status = 'dispatched', pi_submission_id = $2, updated_at = clock_timestamp()
          where id = $1 returning *`, [task.id, String(submission.id)],
      )).rows[0]!
      return { message, task: updated }
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      const failed = (await this.pool.query<BotTask>(
        `update bot_task set status = 'failed', last_error = $2, updated_at = clock_timestamp()
          where id = $1 returning *`, [task.id, `${targetName}: ${detail}`],
      )).rows[0]!
      return { message, task: failed }
    }
  }

  /** 工具入口：身份和作用域来自会话绑定，参数里没有群。 */
  async sendFromTool(piConversationId: string, callId: string, to: string, content: string): Promise<string> {
    const binding = (await this.pool.query<{ profile_id: string; scope_kind: string; scope_ref: string }>(
      'select profile_id, scope_kind, scope_ref from conversation_binding where pi_conversation_id = $1', [piConversationId],
    )).rows[0]
    if (!binding || binding.scope_kind !== 'bot_group') throw new Error('当前会话不在 Bot 群')
    const target = (await this.pool.query<{ id: string; name: string }>(
      `select p.id, p.name from bot_group_member m join profile p on p.id = m.profile_id
        where m.group_id = $1 and (p.id = $2 or p.name = $2)`, [binding.scope_ref, to],
    )).rows
    if (target.length !== 1) throw new Error('目标必须是本群唯一成员')
    const sender = (await this.profiles.get(binding.profile_id)).name
    const result = await this.post({
      groupId: binding.scope_ref,
      senderProfileId: binding.profile_id,
      senderLabel: sender,
      targetProfileId: target[0]!.id,
      content,
      externalRef: `tool:${callId}`,
    })
    return `已发送给 ${target[0]!.name}（消息 ${result.message.id}）`
  }

  async stop(groupId: string): Promise<void> {
    await this.getGroup(groupId)
    await this.pool.query('update bot_group set stopped = true where id = $1', [groupId])
    const tasks = (await this.pool.query<BotTask>(
      `select * from bot_task where group_id = $1 and status in ('queued', 'dispatched')`, [groupId],
    )).rows
    for (const task of tasks) {
      if (task.pi_submission_id) {
        const submission = await this.runtime.harness.submission(Number(task.pi_submission_id) as SubmissionId, BACKGROUND_CONTEXT)
        await submission?.abort(BACKGROUND_CONTEXT).catch(() => undefined)
      }
      await this.pool.query(
        `update bot_task set status = 'cancelled', updated_at = clock_timestamp() where id = $1`, [task.id],
      )
    }
  }

  async resume(groupId: string): Promise<void> {
    await this.getGroup(groupId)
    await this.pool.query('update bot_group set stopped = false where id = $1', [groupId])
  }

  private pump(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.running) {
      this.running = this.runOnce()
        .catch((error: unknown) => { console.error('[bot-group] 对账失败:', error instanceof Error ? error.message : String(error)) })
        .finally(() => { this.running = undefined })
    }
    return this.running
  }

  async runOnce(): Promise<void> {
    if (this.closed) return
    const tasks = (await this.pool.query<BotTask>(
      `select * from bot_task where status = 'dispatched' order by created_at limit 20`,
    )).rows
    for (const task of tasks) {
      if (!task.pi_submission_id) continue
      const submission = await this.runtime.harness.submission(Number(task.pi_submission_id) as SubmissionId, BACKGROUND_CONTEXT)
      if (!submission) {
        await this.pool.query(`update bot_task set status = 'failed', last_error = '持久提交不存在' where id = $1`, [task.id])
        continue
      }
      const record = await submission.status(BACKGROUND_CONTEXT)
      if (record.status !== 'done' && record.status !== 'unanswered') continue
      const group = await this.getGroup(task.group_id)
      if (group.stopped) {
        await this.pool.query(
          `update bot_task set status = 'cancelled', updated_at = clock_timestamp() where id = $1`, [task.id],
        )
        continue
      }
      if (record.status === 'unanswered') {
        await this.pool.query(
          `update bot_task set status = 'failed', last_error = $2, updated_at = clock_timestamp() where id = $1`,
          [task.id, record.reason],
        )
        continue
      }
      const conversation = await this.runtime.harness.conversation(Number(task.pi_conversation_id) as ConversationId, BACKGROUND_CONTEXT)
      const view = await conversation?.context(BACKGROUND_CONTEXT)
      const entry = view?.entries.find((item) => item.id === record.answer)
      const text = entry ? entryText(entry) : ''
      if (text) {
        await this.pool.query(
          `insert into bot_message(id, group_id, sender_profile_id, sender_label, content, external_ref)
           values ($1,$2,$3,$4,$5,$6) on conflict (group_id, external_ref) do nothing`,
          [randomUUID(), task.group_id, task.to_profile_id, (await this.profiles.get(task.to_profile_id)).name, text, `task:${task.id}`],
        )
      }
      await this.pool.query(
        `update bot_task set status = 'done', updated_at = clock_timestamp() where id = $1`, [task.id],
      )
    }
  }

}

export function createBotMessageTool(get: () => BotCollaboration | undefined): ToolRegistration {
  return defineTool({
    name: 'send_bot_message',
    description: '给同一个 Bot 群里的另一个成员发消息并交接任务。只允许本群成员；参数里没有群号。',
    parameters: Type.Object({
      to: Type.String({ minLength: 1, maxLength: 80, description: '目标成员的名字或人格 ID' }),
      content: Type.String({ minLength: 1, maxLength: 8000 }),
    }),
    replay: 'unsafe',
    execute: async (args, api) => {
      const collaboration = get()
      if (!collaboration) throw new Error('Bot 协作未启用')
      const receipt = await collaboration.sendFromTool(String(api.conversationId), api.callId, args.to, args.content)
      return { output: [{ type: 'text', text: receipt }] }
    },
  })
}
