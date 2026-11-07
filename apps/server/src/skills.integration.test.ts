import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { Skills } from './skills'

describe('技能库（真实 PostgreSQL）', () => {
  let db: TestDatabase
  let skills: Skills
  let profile: string

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    skills = new Skills(db.pool)
    profile = '44444444-4444-4444-8444-444444444444'
    await db.pool.query('insert into profile(id,name,instructions) values ($1,$2,$3)', [profile, '技能测试', '测试'])
  })

  afterAll(async () => {
    await db?.dispose()
  })

  it('创建、版本化修改、启停和注入文本', async () => {
    const skill = await skills.create(profile, {
      name: '周报',
      description: '每周五整理',
      body: '1. 收集本周记录\n2. 输出三段',
    })
    expect(skill.version).toBe(1)
    const updated = await skills.update(skill.id, { expectedVersion: 1, body: '1. 收集记录\n2. 检查数字' })
    expect(updated.version).toBe(2)
    await expect(skills.update(skill.id, { expectedVersion: 1, body: '旧版本' })).rejects.toThrow('已被修改')
    await skills.setStatus(skill.id, 'active')
    expect(await skills.render(profile)).toContain('<skill name="周报">')
    expect(await skills.render(profile)).toContain('检查数字')
    await skills.setStatus(skill.id, 'draft')
    expect(await skills.render(profile)).toBe('')
  })

  it('删除后不再列出', async () => {
    const skill = await skills.create(profile, { name: '临时', body: '一次性' })
    await skills.remove(skill.id)
    expect((await skills.list(profile)).some((item) => item.id === skill.id)).toBe(false)
    await expect(skills.get(skill.id)).rejects.toThrow('不存在')
  })
})
