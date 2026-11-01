import { randomUUID } from 'node:crypto'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation, ConversationId } from '@earendil-works/pi-durable'

import { HttpError, textField } from './http'
import { withTransaction, type Pool } from './pg/connection'
import type { AgentRuntime } from './runtime'
import { RuntimeBinding } from './runtime/runtime'

export interface Profile {
  id: string
  name: string
  instructions: string
  revision: number
}

export interface ConversationTarget {
  suffix: string
  scopeKind: 'owner_private' | 'qq_group'
  scopeRef: string
  readableGroups: readonly string[]
}

export const OWNER_TARGET: ConversationTarget = { suffix: 'owner', scopeKind: 'owner_private', scopeRef: '', readableGroups: [] }

export class Profiles {
  constructor(private readonly pool: Pool, private readonly runtime: AgentRuntime) {}

  async seed(): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query('select pg_advisory_xact_lock(4120402)')
      if ((await client.query('select 1 from profile limit 1')).rowCount) return
      await client.query(
        `insert into profile(id, name, instructions) values ($1, $2, $3), ($4, $5, $6)`,
        [randomUUID(), '日常伙伴', '温和、直接，用中文交流，尊重用户的个人边界。', randomUUID(), '研究助手', '严谨、清晰，用中文分析问题，区分事实与推测。'],
      )
    })
  }

  async list(): Promise<Profile[]> {
    return (await this.pool.query<Profile>('select id, name, instructions, revision from profile order by created_at, id')).rows
  }

  async get(id: string): Promise<Profile> {
    const row = (await this.pool.query<Profile>('select id, name, instructions, revision from profile where id = $1', [id])).rows[0]
    if (!row) throw new HttpError(404, '人格不存在')
    return row
  }

  async create(body: Record<string, unknown>): Promise<Profile> {
    const name = textField(body.name, '名称', 80).trim()
    const instructions = textField(body.instructions, '人格设定', 8000, true)
    return (await this.pool.query<Profile>(
      'insert into profile(id, name, instructions) values ($1, $2, $3) returning id, name, instructions, revision',
      [randomUUID(), name, instructions],
    )).rows[0]!
  }

  async update(id: string, body: Record<string, unknown>): Promise<Profile> {
    const name = textField(body.name, '名称', 80).trim()
    const instructions = textField(body.instructions, '人格设定', 8000, true)
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) throw new HttpError(400, '版本无效')
    const row = (await this.pool.query<Profile>(
      `update profile set name = $2, instructions = $3, revision = revision + 1
       where id = $1 and revision = $4 returning id, name, instructions, revision`,
      [id, name, instructions, body.revision],
    )).rows[0]
    if (row) return row
    await this.get(id)
    throw new HttpError(409, '人格已被修改，请刷新后再保存')
  }

  /** PG 锁只串行化当前人格；所有人格共用同一个 Harness。 */
  async conversation(id: string, target: ConversationTarget = OWNER_TARGET): Promise<{ profile: Profile; conversation: Conversation; key: string }> {
    return withTransaction(this.pool, async (client) => {
      const profile = (await client.query<Profile>('select id, name, instructions, revision from profile where id = $1 for update', [id])).rows[0]
      if (!profile) throw new HttpError(404, '人格不存在')
      const key = `profile:${id}:${target.suffix}`
      const binding = (await client.query<{ pi_conversation_id: string; conversation_key: string }>(
        'select pi_conversation_id, conversation_key from conversation_binding where conversation_key = $1', [key],
      )).rows[0]
      let conversation: Conversation | undefined
      if (binding) {
        const piId = Number(binding.pi_conversation_id)
        if (binding.conversation_key !== key || !Number.isSafeInteger(piId) || piId < 1) throw new Error('会话映射无效')
        conversation = await this.runtime.harness.conversation(piId as ConversationId, BACKGROUND_CONTEXT)
        if (!conversation) throw new Error('持久会话不存在，需要恢复运行库')
        await conversation.commit(async (tx) => {
          if ((await tx.doc(RuntimeBinding, piId as ConversationId)).conversationKey !== key) throw new Error('会话绑定不一致')
        }, BACKGROUND_CONTEXT)
      } else {
        conversation = await this.runtime.harness.createConversation({
          ownership: { kind: 'ownerless' },
          agent: { model: this.runtime.model, tools: this.tools(), extensions: [...this.runtime.extensions], instructions: this.instructions(profile) },
          init: async (tx, piId) => {
            const binding = await tx.doc(RuntimeBinding, piId)
            binding.conversationKey = key
          },
        }, BACKGROUND_CONTEXT)
        // 回滚时最多留下未运行的空 Pi 会话；映射提交前不会受理输入。
        await client.query(
          'insert into conversation_binding(profile_id, conversation_key, pi_conversation_id, scope_kind, scope_ref, readable_groups) values ($1, $2, $3, $4, $5, $6)',
          [id, key, String(conversation.id), target.scopeKind, target.scopeRef, target.readableGroups],
        )
      }
      await conversation.configure({ instructions: this.instructions(profile), tools: this.tools(), extensions: [...this.runtime.extensions] }, BACKGROUND_CONTEXT)
      return { profile, conversation, key }
    })
  }

  /** owner 私聊可读的群由服务端写入绑定；请求时按绑定读取，模型无法指定。 */
  async setReadableGroups(key: string, groups: readonly string[]): Promise<void> {
    await this.pool.query(`update conversation_binding set readable_groups = $2 where conversation_key = $1 and scope_kind = 'owner_private'`, [key, groups])
  }

  /** 只开放业务扩展声明的工具；范围由工具自己按会话绑定限定。 */
  private tools() {
    return this.runtime.extensions.flatMap((extension) => extension.tools ?? [])
  }

  private instructions(profile: Profile): string {
    return `你的人格名称：${profile.name}\n${profile.instructions}`
  }
}
