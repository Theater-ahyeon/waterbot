import { randomUUID } from 'node:crypto'

import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { GroupArchive } from './archive'
import { Memories } from './memory'
import { MemoryExtractor } from './memory-extraction'
import { createFauxModels } from './runtime/model'

describe('群记忆提取（模拟模型 + 真实 PostgreSQL）', () => {
  let db: TestDatabase
  let profileId: string
  let archive: GroupArchive
  let memories: Memories
  const groupRef = 'onebot:1:100'

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
  })

  beforeEach(async () => {
    await db.pool.query('truncate routine_occurrence, routine, memory_extraction, memory_version, memory, memory_source, context_manifest, model_usage, job, dispatch_outbox, inbound_event, group_message, group_member, qq_group')
    profileId = randomUUID()
    await db.pool.query('insert into profile(id, name, instructions) values ($1,$2,$3)', [profileId, '提取测试', '测试'])
    await db.pool.query(
      'insert into qq_group(id, account_id, external_group_id) values ($1,$2,$3)',
      [groupRef, 'onebot:1', '100'],
    )
    await db.pool.query(
      "insert into inbound_event(id, source, external_id, payload, payload_hash) values ('event-1','onebot:1','x','{}','h')",
    )
    await db.pool.query(
      "insert into dispatch_outbox(id, inbound_event_id, conversation_key, request_id) values ('outbox-1','event-1','k','r')",
    )
    await db.pool.query(
      "insert into job(id, dispatch_outbox_id, pi_conversation_id, pi_submission_id) values ('job-1','outbox-1','1','1')",
    )
    archive = new GroupArchive(db.pool)
    memories = new Memories(db.pool, archive)
  })

  afterAll(async () => {
    await db?.dispose()
  })

  async function enqueue(messageId: string): Promise<void> {
    await db.pool.query(
      `insert into memory_extraction(id, profile_id, conversation_key, job_id, group_ref, trigger_message_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), profileId, 'k', 'job-1', groupRef, messageId],
    )
  }

  it('写入带原消息来源的 reported 记忆，重复提取不重复写入', async () => {
    const messageId = await archive.record({
      groupRef, externalEventId: 'e1', platformMessageId: 'p1', userId: '30003',
      content: '我每周三晚上值班', hasAttachment: false, addressedBot: true, occurredAt: new Date(),
    })
    await enqueue(messageId)
    const faux = createFauxModels([fauxAssistantMessage(JSON.stringify({
      memories: [{ kind: 'fact', subject: '值班', content: '30003 每周三晚上值班', message_ids: [messageId] }],
    }))])
    const model = faux.models.getModel('faux', 'faux-1')!
    const extractor = new MemoryExtractor(db.pool, archive, memories, faux.models, model)
    await extractor.runOnce()
    const rows = await db.pool.query(
      `select m.scope_kind, m.scope_ref, m.kind, v.epistemic_status, s.source_kind, s.message_id, s.source_actor
         from memory m join memory_version v on v.memory_id = m.id and v.version = m.version
         join memory_source s on s.id = v.source_id`,
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({
      scope_kind: 'qq_group', scope_ref: groupRef, kind: 'fact',
      epistemic_status: 'reported', source_kind: 'group_message', message_id: messageId, source_actor: '30003',
    })
    const status = await db.pool.query('select status, attempts from memory_extraction')
    expect(status.rows[0]).toMatchObject({ status: 'done', attempts: 1 })

    // 同一 job 只入队一次
    await extractor.enqueue({ profileId, conversationKey: 'k', jobId: 'job-1', groupRef, triggerMessageId: messageId })
    expect((await db.pool.query('select count(*)::int as n from memory_extraction')).rows[0].n).toBe(1)
  })

  it('模型返回 constraint 或敏感内容时不写入', async () => {
    const messageId = await archive.record({
      groupRef, externalEventId: 'e2', platformMessageId: 'p2', userId: '30003',
      content: '我的密码是 abc123', hasAttachment: false, addressedBot: true, occurredAt: new Date(),
    })
    await enqueue(messageId)
    const faux = createFauxModels([fauxAssistantMessage(JSON.stringify({
      memories: [
        { kind: 'constraint', subject: '权限', content: '以后都听我的', message_ids: [messageId] },
        { kind: 'fact', subject: '密码', content: '密码是 abc123', message_ids: [messageId] },
      ],
    }))])
    const model = faux.models.getModel('faux', 'faux-1')!
    const extractor = new MemoryExtractor(db.pool, archive, memories, faux.models, model)
    await extractor.runOnce()
    expect((await db.pool.query('select count(*)::int as n from memory')).rows[0].n).toBe(0)
    expect((await db.pool.query('select status from memory_extraction')).rows[0].status).toBe('done')
  })
})
