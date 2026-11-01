import { randomUUID } from 'node:crypto'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, SubmissionId } from '@earendil-works/pi-durable'

import type { Action, Actions } from '../actions'
import type { GroupArchive } from '../archive'
import { entryText } from '../chat'
import { ingestInboundEvent } from '../inbound/ingest'
import { groupMessageHeader, type Memories } from '../memory'
import type { Pool } from '../pg/connection'
import type { ConversationTarget, Profiles } from '../profiles'
import type { AgentRuntime } from '../runtime'
import { OneBotClient } from './client'
import { parseMessage, parseOwnerCommand, textMessage, type OwnerCommand, type QqMessage } from './onebot'

export const QQ_SEND = 'qq.send'
const MAX_REPLY_CHARS = 4000
const PRIVATE_HOURLY_LIMIT = 100
const FAILURE_REPLY = '这次没能回答：模型调用失败了。'

export interface QqConfig {
  url: string
  token?: string
  botId: string
  ownerId: string
  profileId?: string
  /** 真实外发需要 owner 单独打开；关闭时只接收，不发送 */
  allowSend: boolean
  callTimeoutMs?: number
  baseBackoffMs?: number
}

export interface QqStatus {
  account: string
  state: 'ready' | 'connecting'
  stopped: boolean
  allowSend: boolean
  groups: { external_group_id: string; status: string; hourly_reply_limit: number }[]
  gaps: { started_at: Date; ended_at: Date | null; reason: string }[]
}

interface QqPayload { message: string; qq: { target: string } }

/**
 * QQ 入站路由与出站投递。
 * 身份只来自 OneBot 的 user_id：群里任何文字都不是 owner 请求，
 * 群会话的作用域在绑定里固定为本群，模型选不了。
 */
export class QqBridge {
  readonly account: string
  private readonly client: OneBotClient
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | undefined
  private closed = false

  constructor(
    private readonly pool: Pool,
    private readonly runtime: AgentRuntime,
    private readonly profiles: Profiles,
    private readonly actions: Actions,
    private readonly archive: GroupArchive,
    private readonly memories: Memories,
    private readonly config: QqConfig,
  ) {
    this.account = `onebot:${config.botId}`
    this.client = new OneBotClient(config.url, config.token, {
      onEvent: (event) => { this.enqueue(() => this.handle(event)) },
      onUp: () => { this.enqueue(() => this.markUp()) },
      onDown: (reason) => { this.enqueue(() => this.markDown(reason)) },
    }, {
      ...(config.callTimeoutMs ? { callTimeoutMs: config.callTimeoutMs } : {}),
      ...(config.baseBackoffMs ? { baseBackoffMs: config.baseBackoffMs } : {}),
    })
  }

  start(): void {
    this.client.start()
    this.timer = setInterval(() => { void this.pump() }, 500)
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    this.client.close()
    await this.queue
    await this.running
  }

  /** 事件串行处理：额度计数和停止状态不会被并发穿过。 */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      console.error('[qq] 事件处理失败:', error instanceof Error ? error.message : String(error))
    })
  }

  private async markUp(): Promise<void> {
    await this.pool.query('update qq_connection_gap set ended_at = clock_timestamp() where account_id = $1 and ended_at is null', [this.account])
  }

  private async markDown(reason: string): Promise<void> {
    await this.pool.query(
      `insert into qq_connection_gap(id, account_id, reason) values ($1,$2,$3) on conflict (account_id) where ended_at is null do nothing`,
      [randomUUID(), this.account, reason],
    )
  }

  private groupRef(groupId: string): string {
    return `${this.account}:${groupId}`
  }

  private async profileId(): Promise<string> {
    if (this.config.profileId) return this.config.profileId
    const first = (await this.profiles.list())[0]
    if (!first) throw new Error('没有可用人格')
    return first.id
  }

  private async stopped(): Promise<boolean> {
    return !!(await this.pool.query('select 1 from qq_control where account_id = $1 and stopped', [this.account])).rowCount
  }

  private async handle(raw: unknown): Promise<void> {
    const message = parseMessage(raw, this.config.botId)
    if (!message) return
    if (message.kind === 'private') {
      // 只服务 owner；其他人的私聊首版不支持。
      if (message.userId === this.config.ownerId) await this.handleOwner(message)
      return
    }
    await this.handleGroup(message)
  }

  private externalId(message: QqMessage): string {
    return `${message.kind}:${message.groupId ?? message.userId}:${message.messageId}:${message.time}`
  }

  private async handleOwner(message: QqMessage): Promise<void> {
    const command = parseOwnerCommand(message.text)
    if (command) {
      const first = await this.pool.query(
        `insert into inbound_event(id, source, external_id, payload, payload_hash) values ($1,$2,$3,$4,'command')
         on conflict (source, external_id) do nothing returning id`,
        [randomUUID(), this.account, this.externalId(message), JSON.stringify({ command })],
      )
      if (!first.rowCount) return
      const reply = await this.apply(command, message)
      await this.reply(`private:${message.userId}`, reply, `command:${this.externalId(message)}`)
      return
    }
    if (await this.stopped()) return
    const profileId = await this.profileId()
    const groups = (await this.pool.query<{ id: string }>('select id from qq_group where account_id = $1', [this.account])).rows.map((row) => row.id)
    const target: ConversationTarget = { suffix: 'qq_private', scopeKind: 'owner_private', scopeRef: '', readableGroups: groups }
    const { key } = await this.profiles.conversation(profileId, target)
    await this.profiles.setReadableGroups(key, groups)
    await this.ingest(message, message.text, `private:${message.userId}`, key)
  }

  private async apply(command: OwnerCommand, message: QqMessage): Promise<string> {
    if (command.name === 'remember') {
      await this.memories.remember(await this.profileId(), { kind: 'owner_private' }, {
        clientRequestId: this.externalId(message), kind: 'fact', subject: command.text.slice(0, 40), content: command.text, actor: 'owner',
      })
      return '记住了。'
    }
    if (command.name === 'forget') {
      const count = await this.memories.forgetMatching(await this.profileId(), command.text)
      return count ? `已忘掉 ${count} 条。原始记录未物理清除。` : '没有找到匹配的记忆。'
    }
    if (command.name === 'list_memory') {
      const items = await this.memories.list(await this.profileId())
      return items.length ? items.slice(0, 20).map((item, index) => `${index + 1}. ${item.content}`).join('\n') : '现在没有记忆。'
    }
    if (command.name === 'forget_member') {
      const count = await this.archive.hideMember(this.account, command.userId)
      return `已停止使用 ${command.userId} 的 ${count} 条群记录。原文未物理清除。`
    }
    if (command.name === 'forget_group') {
      const ref = this.groupRef(command.groupId)
      const messages = await this.archive.hideGroup(ref)
      const memories = await this.memories.forgetGroup(await this.profileId(), ref)
      return `已停止使用群 ${command.groupId} 的 ${messages} 条记录和 ${memories} 条记忆。原文未物理清除。`
    }
    if (command.name === 'stop_all' || command.name === 'resume_all') {
      const stopped = command.name === 'stop_all'
      await this.pool.query(
        `insert into qq_control(account_id, stopped) values ($1,$2)
         on conflict (account_id) do update set stopped = excluded.stopped, updated_at = clock_timestamp()`, [this.account, stopped],
      )
      return stopped ? '已全部停止。已发出的消息不会撤回。' : '已恢复。'
    }
    if (command.name === 'add_group') {
      await this.pool.query(
        `insert into qq_group(id, account_id, external_group_id) values ($1,$2,$3) on conflict (id) do update set status = 'active'`,
        [this.groupRef(command.groupId), this.account, command.groupId],
      )
      return `已接入群 ${command.groupId}。`
    }
    const status = command.name === 'pause_group' ? 'paused' : 'active'
    const updated = await this.pool.query('update qq_group set status = $2 where id = $1', [this.groupRef(command.groupId), status])
    if (!updated.rowCount) return `群 ${command.groupId} 尚未接入。`
    return `${status === 'paused' ? '已暂停' : '已恢复'}群 ${command.groupId}。`
  }

  private async triggered(message: QqMessage): Promise<boolean> {
    if (message.mentionsBot) return true
    if (!message.replyTo) return false
    // 只认这个群里由 Bot 发出、平台回执过的消息。
    return !!(await this.pool.query(
      `select 1 from action where kind = $1 and account_id = $2 and target_ref = $3 and receipt = $4`,
      [QQ_SEND, this.account, `group:${message.groupId}`, message.replyTo],
    )).rowCount
  }

  private async handleGroup(message: QqMessage): Promise<void> {
    const groupId = message.groupId!
    const group = (await this.pool.query<{ status: string; hourly_reply_limit: number }>(
      'select status, hourly_reply_limit from qq_group where id = $1', [this.groupRef(groupId)],
    )).rows[0]
    if (!group) return
    const addressed = await this.triggered(message)
    // 接入的群全量存档：停止、暂停、超额都只影响回复。
    const archiveId = await this.archive.record({
      groupRef: this.groupRef(groupId), externalEventId: this.externalId(message), platformMessageId: message.messageId,
      userId: message.userId, content: message.text, hasAttachment: message.hasAttachment, addressedBot: addressed, occurredAt: new Date(message.time * 1000),
      ...(message.nickname ? { nickname: message.nickname } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    })
    if (group.status !== 'active' || !addressed || await this.stopped()) return
    const target = `group:${groupId}`
    const used = Number((await this.pool.query<{ count: string }>(
      `select count(*) from inbound_event where source = $1 and payload->'qq'->>'target' = $2 and received_at > clock_timestamp() - interval '1 hour'`,
      [this.account, target],
    )).rows[0]!.count)
    if (used >= group.hourly_reply_limit) return
    const profileId = await this.profileId()
    const { key } = await this.profiles.conversation(profileId, {
      suffix: `qq_group:${groupId}`, scopeKind: 'qq_group', scopeRef: this.groupRef(groupId), readableGroups: [],
    })
    // 只带平台 ID：昵称可被群友随意修改，不进入身份。
    await this.ingest(message, `${groupMessageHeader(message.userId, archiveId)}${message.text}`, target, key)
  }

  private async ingest(message: QqMessage, text: string, target: string, conversationKey: string): Promise<void> {
    const payload: QqPayload = { message: text || '[没有文字内容]', qq: { target } }
    await ingestInboundEvent(this.pool, { source: this.account, externalId: this.externalId(message), payload, conversationKey })
  }

  private async reply(target: string, text: string, trigger: string): Promise<void> {
    if (!this.config.allowSend) return
    const profileId = await this.profileId()
    const limit = target.startsWith('group:')
      ? (await this.pool.query<{ hourly_reply_limit: number }>('select hourly_reply_limit from qq_group where id = $1', [this.groupRef(target.slice(6))])).rows[0]?.hourly_reply_limit
      : PRIVATE_HOURLY_LIMIT
    await this.actions.ensurePolicy(profileId, target, limit ?? 1)
    await this.actions.submit(profileId, { account: this.account, kind: QQ_SEND, target, message: text.slice(0, MAX_REPLY_CHARS), trigger })
  }

  private pump(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.running ??= this.reconcile()
      .catch((error: unknown) => { console.error('[qq] 回复对账失败:', error instanceof Error ? error.message : String(error)) })
      .finally(() => { this.running = undefined })
    return this.running
  }

  /** 从 Pi 回执推进作业并生成发送动作；崩溃后重跑时 Action 的语义键保证不重复。 */
  private async reconcile(): Promise<void> {
    const jobs = (await this.pool.query<{ id: string; pi_conversation_id: string; pi_submission_id: string; dispatch_outbox_id: string; payload: QqPayload }>(
      `select j.id, j.pi_conversation_id, j.pi_submission_id, j.dispatch_outbox_id, e.payload
         from job j join dispatch_outbox o on o.id = j.dispatch_outbox_id join inbound_event e on e.id = o.inbound_event_id
        where e.source = $1 and j.status = 'dispatched' order by j.created_at limit 20`, [this.account],
    )).rows
    for (const job of jobs) {
      if (this.closed) return
      const submission = await this.runtime.harness.submission(Number(job.pi_submission_id) as SubmissionId, BACKGROUND_CONTEXT)
      if (!submission) throw new Error('持久提交不存在')
      const record = await submission.status(BACKGROUND_CONTEXT)
      if (record.status !== 'done' && record.status !== 'unanswered') continue
      if (!(await this.stopped())) {
        const text = record.status === 'done' && 'answer' in record ? await this.answerText(job.pi_conversation_id, record.answer) : FAILURE_REPLY
        if (text) await this.reply(job.payload.qq.target, text, job.dispatch_outbox_id)
      }
      await this.pool.query('update job set status = $2, pi_status = $3, updated_at = now() where id = $1',
        [job.id, record.status === 'done' ? 'completed' : 'failed', record.status])
    }
  }

  private async answerText(piConversationId: string, answer: unknown): Promise<string> {
    const conversation = await this.runtime.harness.conversation(Number(piConversationId) as ConversationId, BACKGROUND_CONTEXT)
    const view = await conversation?.context(BACKGROUND_CONTEXT)
    const entry = view?.entries.find((item) => item.id === answer)
    return entry ? entryText(entry) : ''
  }

  /** Action 执行端入口：抛错一律记为 unknown，不补发。 */
  async deliver(action: Action): Promise<string> {
    const [kind, id] = action.target_ref.split(':') as [string, string]
    const params = kind === 'group'
      ? { group_id: Number(id), message: textMessage(action.payload.message) }
      : { user_id: Number(id), message: textMessage(action.payload.message) }
    const data = await this.client.call(kind === 'group' ? 'send_group_msg' : 'send_private_msg', params) as { message_id?: unknown } | null
    return String(data?.message_id ?? '')
  }

  async status(): Promise<QqStatus> {
    const groups = (await this.pool.query<QqStatus['groups'][number]>(
      'select external_group_id, status, hourly_reply_limit from qq_group where account_id = $1 order by created_at', [this.account],
    )).rows
    const gaps = (await this.pool.query<QqStatus['gaps'][number]>(
      'select started_at, ended_at, reason from qq_connection_gap where account_id = $1 order by started_at desc limit 20', [this.account],
    )).rows
    return { account: this.account, state: this.client.connected ? 'ready' : 'connecting', stopped: await this.stopped(), allowSend: this.config.allowSend, groups, gaps }
  }
}
