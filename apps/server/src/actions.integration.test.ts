import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { killAllProcs, startProc, waitForFile } from '../test/helpers/proc'
import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { Actions, type Action } from './actions'

describe('动作与范围审批（真实 PostgreSQL，模拟连接器）', () => {
  let db: TestDatabase
  let profile: string
  let service: Actions
  let sent: Action[]
  const decide = (action: Action) => ({ decision: 'approved', revision: action.revision, payloadHash: action.payload_hash })
  const input = (target: string, message = 'hello') => ({ target, message, triggerId: randomUUID() })

  beforeAll(async () => { db = await createTestDatabase(inject('pgAdminUrl')) })
  beforeEach(async () => {
    profile = randomUUID()
    await db.pool.query('insert into profile(id,name,instructions) values ($1,$2,$3)', [profile, '测试人格', '测试'])
    sent = []
    service = new Actions(db.pool, async (action) => { sent.push(action); return `mock:${action.id}` })
  })
  afterEach(async () => { await service.close(); await killAllProcs() })
  afterAll(async () => { await db.dispose() })

  it('规则外保持待审；批准绑定确切内容，一次执行后不重复', async () => {
    const action = await service.propose(profile, input('friend'))
    expect(action.status).toBe('awaiting_approval')
    await service.execute(action.id)
    expect(sent).toHaveLength(0)
    await expect(service.decide(action.id, { ...decide(action), payloadHash: 'wrong' })).rejects.toThrow(/内容已变化/)
    await service.decide(action.id, decide(action))
    await service.execute(action.id)
    await service.execute(action.id)
    expect(sent).toHaveLength(1)
    expect((await service.list(profile))[0]!.status).toBe('confirmed')
  })

  it('已授权范围自动执行，其他对象待审，并发执行也不能超过额度', async () => {
    await service.addPolicy(profile, { target: 'allowed', hourlyLimit: 1 })
    const first = await service.propose(profile, input('allowed'))
    const second = await service.propose(profile, input('allowed'))
    expect(first.status).toBe('ready')
    expect(second.status).toBe('ready')
    expect((await service.propose(profile, input('another'))).status).toBe('awaiting_approval')
    await Promise.all([service.execute(first.id), service.execute(second.id)])
    expect(sent).toHaveLength(1)
    const statuses = (await service.list(profile)).map((action) => action.status)
    expect(statuses.filter((status) => status === 'confirmed')).toHaveLength(1)
    expect(statuses.filter((status) => status === 'awaiting_approval')).toHaveLength(2)
  })

  it('待审动作过期后不能批准，扫描会标记 expired', async () => {
    const stale = await service.propose(profile, input('stale'))
    await db.pool.query("update action set expires_at=clock_timestamp()-interval '1 second' where id=$1", [stale.id])
    await expect(service.decide(stale.id, decide(stale))).rejects.toThrow('动作已过期')
    expect((await service.list(profile)).find((action) => action.id === stale.id)?.status).toBe('expired')
  })

  it('修改已批准的内容后必须重新批准，旧版本的批准不能复用', async () => {
    const original = await service.propose(profile, input('edit', 'old text'))
    await service.decide(original.id, decide(original))
    const edited = await service.edit(original.id, { message: 'new text', revision: original.revision })
    expect(edited.revision).toBe(original.revision + 1)
    expect(edited.status).toBe('awaiting_approval')
    await expect(service.decide(original.id, decide(original))).rejects.toThrow(/内容已变化/)
    await service.execute(original.id)
    expect(sent).toHaveLength(0)
    await service.decide(edited.id, decide(edited))
    await service.execute(edited.id)
    expect(sent[0]!.payload.message).toBe('new text')
  })

  it('重复意图复用原动作，内容不同冲突；不同人格不能争抢同一账号意图', async () => {
    const body = input('duplicate')
    const first = await service.propose(profile, body)
    expect((await service.propose(profile, body)).id).toBe(first.id)
    await expect(service.propose(profile, { ...body, message: 'changed' })).rejects.toThrow(/同一触发事件/)
    const other = randomUUID()
    await db.pool.query('insert into profile(id,name,instructions) values ($1,$2,$3)', [other, '另一个人格', '测试'])
    await expect(service.propose(other, body)).rejects.toThrow(/同一触发事件/)
  })

  it('过期、人格变化、上下文撤权和规则撤销均在执行前阻止发送', async () => {
    const expired = await service.propose(profile, input('expired'))
    await service.decide(expired.id, decide(expired))
    await db.pool.query("update action set expires_at=clock_timestamp()-interval '1 second' where id=$1", [expired.id])
    await service.execute(expired.id)
    const changed = await service.propose(profile, input('changed'))
    await service.decide(changed.id, decide(changed))
    await db.pool.query('update profile set revision=revision+1 where id=$1', [profile])
    await service.execute(changed.id)
    const revoked = await service.propose(profile, input('epoch'))
    await service.decide(revoked.id, decide(revoked))
    await db.pool.query('update owner_context set epoch=epoch+1 where id=1')
    await service.execute(revoked.id)
    const policy = await service.addPolicy(profile, { target: 'policy', hourlyLimit: 5 })
    const automatic = await service.propose(profile, input('policy'))
    await service.revokePolicy(policy.id)
    await service.execute(automatic.id)
    expect(sent).toHaveLength(0)
    expect((await service.list(profile)).every((action) => action.status === 'expired')).toBe(true)
  })

  it('执行结果不明不重试，拒绝的动作不发送', async () => {
    let calls = 0
    const uncertain = new Actions(db.pool, async () => { calls++; throw new Error('timeout after send') })
    const action = await uncertain.propose(profile, input('unknown'))
    await uncertain.decide(action.id, decide(action))
    await uncertain.execute(action.id)
    await uncertain.execute(action.id)
    expect(calls).toBe(1)
    expect((await uncertain.list(profile))[0]!.status).toBe('unknown')
    const rejected = await service.propose(profile, input('rejected'))
    await service.decide(rejected.id, { ...decide(rejected), decision: 'rejected' })
    await service.execute(rejected.id)
    expect(sent).toHaveLength(0)
  })

  it('副作用发生但回执未保存时杀进程，重启标为 unknown 且不补发', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-action-'))
    const action = await service.propose(profile, input('crash'))
    await service.decide(action.id, decide(action))
    const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    try {
      const child = startProc({ entry: join(serverRoot, 'test/fixtures/action-child.ts'), cwd: serverRoot, env: { PA_PG_URL: db.url, PA_ACTION_DIR: dir, PA_ACTION_ID: action.id } })
      await waitForFile(join(dir, 'sent.marker'))
      await child.kill()
      expect((await db.pool.query('select status from action where id=$1', [action.id])).rows[0].status).toBe('sending')
      await service.start()
      await service.execute(action.id)
      expect((await db.pool.query('select status from action where id=$1', [action.id])).rows[0].status).toBe('unknown')
      expect(await readFile(join(dir, 'effects.log'), 'utf8')).toBe('sent\n')
      expect(sent).toHaveLength(0)
    } finally {
      await killAllProcs()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
