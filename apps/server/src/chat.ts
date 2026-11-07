import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import type { SubmissionId } from '@earendil-works/pi-durable'

import { dispatchOnce, type DispatchDeps } from './dispatch/dispatcher'
import { HttpError, textField } from './http'
import { ingestInboundEvent } from './inbound/ingest'
import type { Pool } from './pg/connection'
import { Profiles, type ConversationTarget, type Profile } from './profiles'
import type { AgentRuntime } from './runtime'
import { recordUsage } from './usage'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface ChatSnapshot {
  profile: Profile
  messages: ChatMessage[]
  pending: number
  failed: boolean
  mode: 'demo'
}

/** Pi 条目的可见文字；工作台和 QQ 回复共用。 */
export function entryText(entry: { model?: readonly Message[] }): string {
  const parts: string[] = []
  for (const message of entry.model ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (typeof message.content === 'string') parts.push(message.content)
    else for (const block of message.content) if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

export class Chats {
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | undefined
  private closed = false

  constructor(private readonly pool: Pool, private readonly runtime: AgentRuntime, private readonly profiles: Profiles) {}

  start(): void {
    this.timer = setInterval(() => { void this.pump() }, 1000)
    void this.pump()
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await this.running
  }

  async send(profileId: string, body: Record<string, unknown>): Promise<{ requestId: string }> {
    const message = textField(body.message, '消息', 8000)
    const clientId = textField(body.clientRequestId, '请求 ID', 128)
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(clientId)) throw new HttpError(400, '请求 ID 无效')
    const { key } = await this.profiles.conversation(profileId)
    const result = await ingestInboundEvent(this.pool, {
      source: 'web-owner',
      externalId: `${profileId}:${clientId}`,
      payload: { message },
      conversationKey: key,
    })
    void this.pump()
    return { requestId: result.outbox.request_id }
  }

  private pump(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.running) {
      this.running = this.dispatchPending()
        .catch(() => { console.error('[chat] 派发暂时失败，将按持久队列重试') })
        .finally(() => { this.running = undefined })
    }
    return this.running
  }

  private async dispatchPending(): Promise<void> {
    const bindings = (await this.pool.query<{ profile_id: string; conversation_key: string; scope_kind: ConversationTarget['scopeKind']; scope_ref: string; readable_groups: string[] }>(
      `select distinct b.profile_id, b.conversation_key, b.scope_kind, b.scope_ref, b.readable_groups from dispatch_outbox o
       join conversation_binding b on b.conversation_key = o.conversation_key
       join profile p on p.id = b.profile_id
       where o.status = 'pending' and (o.lease_until is null or o.lease_until < clock_timestamp())
         and p.archived_at is null`,
    )).rows
    for (const binding of bindings) {
      if (this.closed) return
      const { conversation, key } = await this.profiles.conversation(binding.profile_id, {
        suffix: binding.conversation_key.slice(`profile:${binding.profile_id}:`.length),
        scopeKind: binding.scope_kind,
        scopeRef: binding.scope_ref,
        readableGroups: binding.readable_groups,
      })
      const target: DispatchDeps['runtime'] = {
        conversation,
        conversationKey: key,
        accept: (input) => conversation.submit({ type: 'input', ...input }, BACKGROUND_CONTEXT),
      }
      for (let count = 0; count < 20 && !this.closed; count++) {
        const result = await dispatchOnce({
          pool: this.pool, runtime: target, owner: 'web-dispatcher', conversationKey: key, whenBusy: 'followUp',
        })
        if (result.kind !== 'accepted') break
      }
    }
  }

  async snapshot(profileId: string): Promise<ChatSnapshot> {
    const { profile, conversation, key } = await this.profiles.conversation(profileId)
    const jobs = (await this.pool.query<{ id: string; pi_submission_id: string }>(
      `select j.id, j.pi_submission_id from job j join dispatch_outbox o on o.id = j.dispatch_outbox_id
       where o.conversation_key = $1 and j.status = 'dispatched'`, [key],
    )).rows
    const completed: { jobId: string; answerId: string }[] = []
    for (const job of jobs) {
      const id = Number(job.pi_submission_id)
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('提交映射无效')
      const submission = await this.runtime.harness.submission(id as SubmissionId, BACKGROUND_CONTEXT)
      if (!submission) throw new Error('持久提交不存在')
      const record = await submission.status(BACKGROUND_CONTEXT)
      if (record.status === 'done' || record.status === 'unanswered') {
        await this.pool.query('update job set status = $2, pi_status = $3, updated_at = now() where id = $1',
          [job.id, record.status === 'done' ? 'completed' : 'failed', record.status])
        if (record.status === 'done') completed.push({ jobId: job.id, answerId: String(record.answer) })
      }
    }
    const view = await conversation.context(BACKGROUND_CONTEXT)
    for (const item of completed) {
      const entry = view.entries.find((candidate) => String(candidate.id) === item.answerId)
      if (!entry) continue
      try {
        await recordUsage(this.pool, {
          profileId: profile.id,
          conversationKey: key,
          jobId: item.jobId,
          entryId: item.answerId,
          model: entry.model,
          provider: this.runtime.model.provider,
          modelId: this.runtime.model.modelId,
        })
      } catch (error) {
        console.error('[chat] 用量记录失败:', error instanceof Error ? error.message : String(error))
      }
    }
    const messages: ChatMessage[] = []
    for (const entry of view.entries) {
      if (entry.kind !== 'pi.user' && entry.kind !== 'pi.assistant') continue
      const text = entryText(entry)
      if (text) messages.push({ id: String(entry.id), role: entry.kind === 'pi.user' ? 'user' : 'assistant', text })
    }
    const counts = (await this.pool.query<{ pending: string; failed: boolean }>(
      `select
         (select count(*) from dispatch_outbox where conversation_key = $1 and status = 'pending') +
         (select count(*) from job j join dispatch_outbox o on o.id = j.dispatch_outbox_id where o.conversation_key = $1 and j.status = 'dispatched') as pending,
         exists(select 1 from dispatch_outbox o left join job j on j.dispatch_outbox_id = o.id
                where o.conversation_key = $1 and (o.status = 'failed' or j.status = 'failed')) as failed`, [key],
    )).rows[0]!
    return { profile, messages, pending: Number(counts.pending), failed: counts.failed, mode: 'demo' }
  }
}
