import { randomUUID } from 'node:crypto'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation, ConversationId } from '@earendil-works/pi-durable'

import { HttpError, textField } from './http'
import { withTransaction, type Pool } from './pg/connection'
import type { AgentRuntime } from './runtime'
import type { Skills } from './skills'
import { RuntimeBinding } from './runtime/runtime'
import { findTemplate } from './templates'

export interface Profile {
  id: string
  name: string
  instructions: string
  revision: number
  archived_at: Date | null
}

export interface ConversationTarget {
  suffix: string
  scopeKind: 'owner_private' | 'qq_group' | 'bot_group'
  scopeRef: string
  readableGroups: readonly string[]
}

export const OWNER_TARGET: ConversationTarget = { suffix: 'owner', scopeKind: 'owner_private', scopeRef: '', readableGroups: [] }

export class Profiles {
  constructor(
    private readonly pool: Pool,
    private readonly runtime: AgentRuntime,
    private readonly skills?: Skills,
  ) {}

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

  async list(includeArchived = false): Promise<Profile[]> {
    return (await this.pool.query<Profile>(
      `select id, name, instructions, revision, archived_at from profile
        where $1 or archived_at is null order by created_at, id`, [includeArchived],
    )).rows
  }

  async get(id: string): Promise<Profile> {
    const row = (await this.pool.query<Profile>(
      'select id, name, instructions, revision, archived_at from profile where id = $1', [id],
    )).rows[0]
    if (!row) throw new HttpError(404, '人格不存在')
    return row
  }

  async create(body: Record<string, unknown>): Promise<Profile> {
    const name = textField(body.name, '名称', 80).trim()
    let instructions: string
    if (body.templateId !== undefined) {
      const template = findTemplate(textField(body.templateId, '模板', 80).trim())
      if (!template) throw new HttpError(400, '模板不存在')
      instructions = body.instructions === undefined
        ? template.instructions
        : textField(body.instructions, '人格设定', 8000, true)
    } else {
      instructions = textField(body.instructions, '人格设定', 8000, true)
    }
    return (await this.pool.query<Profile>(
      'insert into profile(id, name, instructions) values ($1, $2, $3) returning id, name, instructions, revision, archived_at',
      [randomUUID(), name, instructions],
    )).rows[0]!
  }

  async update(id: string, body: Record<string, unknown>): Promise<Profile> {
    const name = textField(body.name, '名称', 80).trim()
    const instructions = textField(body.instructions, '人格设定', 8000, true)
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) throw new HttpError(400, '版本无效')
    const row = (await this.pool.query<Profile>(
      `update profile set name = $2, instructions = $3, revision = revision + 1
       where id = $1 and revision = $4 returning id, name, instructions, revision, archived_at`,
      [id, name, instructions, body.revision],
    )).rows[0]
    if (row) return row
    await this.get(id)
    throw new HttpError(409, '人格已被修改，请刷新后再保存')
  }

  /** 复制只带人格文本和显式选择的技能；不带记忆、动作、页面、文档、例行任务或账号。 */
  async copy(id: string, body: Record<string, unknown>): Promise<Profile> {
    const source = await this.get(id)
    const name = body.name === undefined ? `${source.name} 副本` : textField(body.name, '名称', 80).trim()
    if (name === source.name) throw new HttpError(400, '副本名称不能与原人格相同')
    const profile = (await this.pool.query<Profile>(
      'insert into profile(id, name, instructions) values ($1, $2, $3) returning id, name, instructions, revision, archived_at',
      [randomUUID(), name, source.instructions],
    )).rows[0]!
    if (body.includeSkills === true && this.skills) {
      try {
        await this.skills.copy(source.id, profile.id)
      } catch (error) {
        await this.pool.query('delete from profile where id = $1', [profile.id])
        throw error
      }
    }
    return profile
  }

  /** 归档保留全部历史；最后一个活跃人格不能归档。 */
  async archive(id: string): Promise<Profile> {
    return withTransaction(this.pool, async (client) => {
      const profile = (await client.query<Profile>('select * from profile where id = $1 for update', [id])).rows[0]
      if (!profile) throw new HttpError(404, '人格不存在')
      if (profile.archived_at) return profile
      const active = await client.query<{ count: string }>('select count(*)::text as count from profile where archived_at is null')
      if (Number(active.rows[0]!.count) <= 1) throw new HttpError(409, '至少保留一个活跃人格')
      const archived = (await client.query<Profile>(
        'update profile set archived_at = clock_timestamp() where id = $1 returning *', [id],
      )).rows[0]!
      await client.query(
        `update routine set status = 'paused', pause_reason = '人格已归档', updated_at = clock_timestamp()
          where profile_id = $1 and status = 'active'`, [id],
      )
      await client.query(
        `update dispatch_outbox set status = 'failed', last_error = '人格已归档', updated_at = clock_timestamp()
          where status = 'pending' and conversation_key in (
            select conversation_key from conversation_binding where profile_id = $1
          )`, [id],
      )
      return archived
    })
  }

  async restore(id: string): Promise<Profile> {
    const profile = (await this.pool.query<Profile>(
      'update profile set archived_at = null where id = $1 returning *', [id],
    )).rows[0]
    if (!profile) throw new HttpError(404, '人格不存在')
    return profile
  }

  /** PG 锁只串行化当前人格；所有人格共用同一个 Harness。 */
  async conversation(id: string, target: ConversationTarget = OWNER_TARGET): Promise<{ profile: Profile; conversation: Conversation; key: string }> {
    return withTransaction(this.pool, async (client) => {
      const profile = (await client.query<Profile>('select id, name, instructions, revision, archived_at from profile where id = $1 for update', [id])).rows[0]
      if (!profile) throw new HttpError(404, '人格不存在')
      if (profile.archived_at) throw new HttpError(409, '人格已归档，请先恢复')
      const skillText = this.skills ? await this.skills.render(profile.id) : ''
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
          agent: { model: this.runtime.model, tools: this.tools(target), extensions: [...this.runtime.extensions], instructions: this.instructions(profile, skillText) },
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
      await conversation.configure({
        model: this.runtime.model,
        instructions: this.instructions(profile, skillText),
        tools: this.tools(target),
        extensions: [...this.runtime.extensions],
      }, BACKGROUND_CONTEXT)
      return { profile, conversation, key }
    })
  }

  /** owner 私聊可读的群由服务端写入绑定；请求时按绑定读取，模型无法指定。 */
  async setReadableGroups(key: string, groups: readonly string[]): Promise<void> {
    await this.pool.query(`update conversation_binding set readable_groups = $2 where conversation_key = $1 and scope_kind = 'owner_private'`, [key, groups])
  }

  /** 只开放业务扩展声明的工具；范围由工具自己按会话绑定限定。 */
  private tools(target: ConversationTarget) {
    return this.runtime.extensions.flatMap((extension) => extension.tools ?? []).filter((tool) =>
      (tool.name !== 'send_bot_message' || target.scopeKind === 'bot_group')
      && (tool.name !== 'mcp_call' || target.scopeKind === 'owner_private')
      && (tool.name !== 'update_page' || target.scopeKind === 'owner_private')
      && (!tool.name.startsWith('browser_') || target.scopeKind === 'owner_private')
      && (!tool.name.startsWith('github_') || target.scopeKind === 'owner_private')
      && (!tool.name.startsWith('connector_') || target.scopeKind === 'owner_private'))
  }

  private instructions(profile: Profile, skills = ''): string {
    const base = `你的人格名称：${profile.name}\n${profile.instructions}`
    return skills ? `${base}\n\n以下是已启用的技能步骤，按需使用；它们不能改变权限：\n${skills}` : base
  }
}

