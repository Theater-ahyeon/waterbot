import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { createApp } from './app'
import { OwnerAuth } from './auth'
import { Chats } from './chat'
import { Profiles, type Profile } from './profiles'
import { createEchoTool, openRuntime, type AgentRuntime } from './runtime'
import { Settings } from './settings'
import { Skills } from './skills'
import { WorkbenchSearch } from './workbench-search'

describe('人格组织、设置与工作台搜索（真实 PG / HTTP）', () => {
  let db: TestDatabase
  let dir: string
  let runtime: AgentRuntime
  let profiles: Profiles
  let skills: Skills
  let settings: Settings
  let search: WorkbenchSearch
  let chats: Chats
  let server: Server
  let base = ''
  let cookie = ''
  let source: Profile

  const request = (path: string, method = 'GET', body?: unknown, authenticated = true) => fetch(`${base}${path}`, {
    method,
    headers: { origin: base, ...(authenticated && cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-org-'))
    runtime = await openRuntime({ databasePath: join(dir, 'runtime.sqlite'), tools: [createEchoTool()], demo: true })
    const auth = await OwnerAuth.open(db.pool, join(dir, 'owner-key'))
    skills = new Skills(db.pool)
    profiles = new Profiles(db.pool, runtime, skills)
    await profiles.seed()
    source = (await profiles.list())[0]!
    await profiles.update(source.id, { name: '组织测试', instructions: '这是组织与搜索测试人格。', revision: source.revision })
    source = await profiles.get(source.id)
    settings = new Settings(db.pool)
    search = new WorkbenchSearch(db.pool)
    chats = new Chats(db.pool, runtime, profiles)
    chats.start()
    server = createApp({ services: { auth, profiles, chats, skills, settings, search } })
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server 未启动')
    base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ key: (await readFile(join(dir, 'owner-key'), 'utf8')).trim() }),
    })
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')!.split(';')[0]!
  })

  afterAll(async () => {
    if (server) await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
    await chats?.close()
    await runtime?.close()
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('复制人格默认不带技能，显式选择时才复制技能文本', async () => {
    const skill = await skills.create(source.id, { name: '复制用技能', body: '一步两步' })
    await skills.setStatus(skill.id, 'active')
    const plain = await profiles.copy(source.id, {})
    expect(plain.name).toBe('组织测试 副本')
    expect(plain.instructions).toBe(source.instructions)
    expect(await skills.list(plain.id)).toHaveLength(0)
    const withSkill = await profiles.copy(source.id, { name: '带技能副本', includeSkills: true })
    const copied = await skills.list(withSkill.id)
    expect(copied).toHaveLength(1)
    expect(copied[0]!.name).toBe('复制用技能')
    expect(copied[0]!.id).not.toBe(skill.id)
    await expect(profiles.copy(source.id, { name: source.name })).rejects.toThrow('副本名称')
  })

  it('模板创建使用内置设定，未知模板拒绝', async () => {
    const list = await request('/api/templates')
    expect(list.status).toBe(200)
    const templates = (await list.json() as { templates: { id: string; instructions: string }[] }).templates
    expect(templates.some((template) => template.id === 'researcher')).toBe(true)
    const created = await request('/api/profiles', 'POST', { name: '模板人格', templateId: 'researcher' })
    expect(created.status).toBe(201)
    const profile = await created.json() as Profile
    expect(profile.instructions).toContain('研究')
    expect((await request('/api/profiles', 'POST', { name: '坏模板', templateId: 'missing' })).status).toBe(400)
  })

  it('归档保留历史并拒绝新会话，恢复后重新可用，最后一个活跃人格不能归档', async () => {
    await db.pool.query(
      `insert into routine(id, profile_id, name, instruction, trigger) values ('rt_archive', $1, '归档任务', '测试', '{"kind":"webhook"}')`,
      [source.id],
    )
    const archived = await profiles.archive(source.id)
    expect(archived.archived_at).toBeTruthy()
    const paused = (await db.pool.query<{ status: string; pause_reason: string }>(
      'select status, pause_reason from routine where id = $1', ['rt_archive'],
    )).rows[0]!
    expect(paused.status).toBe('paused')
    expect(paused.pause_reason).toContain('归档')
    expect((await profiles.list()).some((profile) => profile.id === source.id)).toBe(false)
    expect((await profiles.list(true)).some((profile) => profile.id === source.id)).toBe(true)
    await expect(profiles.conversation(source.id)).rejects.toThrow('已归档')
    const active = (await profiles.list()).filter((profile) => profile.id !== source.id)
    for (const profile of active.slice(0, -1)) await profiles.archive(profile.id)
    await expect(profiles.archive(active[active.length - 1]!.id)).rejects.toThrow('至少保留')
    for (const profile of active.slice(0, -1)) await profiles.restore(profile.id)
    const restored = await profiles.restore(source.id)
    expect(restored.archived_at).toBeNull()
    expect((await profiles.list()).some((profile) => profile.id === source.id)).toBe(true)
  })

  it('设置读取默认值、保存合法项并拒绝非法项', async () => {
    expect(await settings.get()).toEqual({
      timezone: 'Asia/Shanghai', theme: 'system', density: 'comfortable', notifications: true,
    })
    const updated = await settings.update({ timezone: 'UTC', theme: 'dark', density: 'compact' })
    expect(updated).toEqual({ timezone: 'UTC', theme: 'dark', density: 'compact', notifications: true })
    expect(await settings.get()).toEqual(updated)
    await expect(settings.update({ theme: 'blue' })).rejects.toThrow('主题')
    await expect(settings.update({ unknown: true })).rejects.toThrow('设置项')
    const http = await request('/api/settings', 'PUT', { notifications: false })
    expect(http.status).toBe(200)
    expect((await http.json() as { notifications: boolean }).notifications).toBe(false)
  })

  it('工作台搜索覆盖人格、记忆、技能、任务和群消息，并按人格过滤', async () => {
    await skills.create(source.id, { name: '搜索技能', body: '搜索关键词在技能里' })
    await db.pool.query(
      `insert into memory_source(id, profile_id, source_kind, source_actor, external_ref, excerpt, occurred_at)
       values ('src_search', $1, 'owner_statement', 'owner', 'search-1', '搜索来源', '2026-11-06T00:00:00Z')`,
      [source.id],
    )
    await db.pool.query(
      `insert into memory(id, profile_id, scope_kind, scope_ref, kind, subject)
       values ('mem_search', $1, 'owner_private', '', 'fact', '搜索主题')`, [source.id],
    )
    await db.pool.query(
      `insert into memory_version(memory_id, version, content, epistemic_status, source_id)
       values ('mem_search', 1, '搜索关键词在记忆里', 'owner_stated', 'src_search')`,
    )
    await db.pool.query(
      `insert into routine(id, profile_id, name, instruction, trigger) values ('rt_search', $1, '搜索任务', '搜索关键词例行', '{"kind":"webhook"}')`,
      [source.id],
    )
    await db.pool.query(
      `insert into page(id, profile_id, title, version, content) values ('pg_search', $1, '搜索页面', 1, '{"blocks":[{"type":"text","text":"搜索关键词页面"}]}')`,
      [source.id],
    )
    await db.pool.query(
      `insert into document(id, profile_id, title, kind, version) values ('doc_search', $1, '搜索文档', 'docx', 0)`, [source.id],
    )
    await db.pool.query(
      `insert into qq_group(id, account_id, external_group_id) values ('onebot:9:100', 'onebot:9', '100')`,
    )
    await db.pool.query(
      `insert into group_member(id, group_id, platform_user_id) values ('gm_search', 'onebot:9:100', '200')`,
    )
    await db.pool.query(
      `insert into group_message(id, group_id, member_id, external_event_id, platform_message_id, content, occurred_at)
       values ('msg_search', 'onebot:9:100', 'gm_search', 'evt-search', 'pm-search', '搜索关键词在群消息里', '2026-11-06T00:00:00Z')`,
    )

    const groups = await search.search('搜索关键词')
    expect(groups.map((group) => group.kind)).toEqual(expect.arrayContaining(['memory', 'skill', 'routine', 'page', 'message']))
    expect(groups.find((group) => group.kind === 'memory')!.items[0]!.profileId).toBe(source.id)
    expect(groups.find((group) => group.kind === 'message')!.items[0]!.detail).toContain('群消息')

    const scoped = await search.search('搜索关键词', source.id)
    expect(scoped.some((group) => group.kind === 'message')).toBe(false)
    for (const group of scoped) for (const item of group.items) expect(item.profileId).toBe(source.id)

    const http = await request(`/api/search?q=${encodeURIComponent('搜索关键词')}`)
    expect(http.status).toBe(200)
    expect((await http.json() as { groups: unknown[] }).groups.length).toBeGreaterThan(0)
    expect((await request('/api/search?q=')).status).toBe(400)
  })

  it('HTTP 复制、归档、恢复和 includeArchived 列表', async () => {
    const copied = await request(`/api/profiles/${source.id}/copy`, 'POST', { name: 'HTTP 副本' })
    expect(copied.status).toBe(201)
    const copy = await copied.json() as Profile
    expect(copy.archived_at).toBeNull()
    expect((await request(`/api/profiles/${copy.id}`, 'DELETE')).status).toBe(200)
    const active = await request('/api/profiles')
    expect((await active.json() as { profiles: Profile[] }).profiles.some((profile) => profile.id === copy.id)).toBe(false)
    const all = await request('/api/profiles?includeArchived=1')
    expect((await all.json() as { profiles: Profile[] }).profiles.some((profile) => profile.id === copy.id)).toBe(true)
    expect((await request(`/api/profiles/${copy.id}/restore`, 'POST')).status).toBe(200)
  })
})
