import { randomUUID } from 'node:crypto'

import { HttpError, textField } from './http'
import { withTransaction, type Pool } from './pg/connection'

export interface Skill {
  id: string
  profile_id: string
  name: string
  description: string
  body: string
  version: number
  status: 'draft' | 'active'
  created_at: Date
  updated_at: Date
}

const MAX_SKILLS = 5
const MAX_SKILL_CHARS = 4000

export class Skills {
  constructor(private readonly pool: Pool) {}

  async create(profileId: string, input: { name: string; description?: string; body: string }): Promise<Skill> {
    if (!(await this.pool.query('select 1 from profile where id = $1', [profileId])).rowCount) throw new HttpError(404, '人格不存在')
    const name = textField(input.name, '技能名称', 80).trim()
    const body = textField(input.body, '技能内容', 4000)
    const description = input.description ? textField(input.description, '技能说明', 300).trim() : ''
    return withTransaction(this.pool, async (client) => {
      const id = randomUUID()
      const skill = (await client.query<Skill>(
        `insert into skill(id, profile_id, name, description, body) values ($1,$2,$3,$4,$5) returning *`,
        [id, profileId, name, description, body],
      )).rows[0]!
      await client.query('insert into skill_revision(skill_id, version, body) values ($1,1,$2)', [id, body])
      return skill
    })
  }

  async list(profileId: string): Promise<Skill[]> {
    return (await this.pool.query<Skill>(
      'select * from skill where profile_id = $1 order by updated_at desc', [profileId],
    )).rows
  }

  async get(id: string): Promise<Skill> {
    const skill = (await this.pool.query<Skill>('select * from skill where id = $1', [id])).rows[0]
    if (!skill) throw new HttpError(404, '技能不存在')
    return skill
  }

  async update(id: string, input: { expectedVersion: number; name?: string; description?: string; body: string }): Promise<Skill> {
    const body = textField(input.body, '技能内容', 4000)
    const name = input.name ? textField(input.name, '技能名称', 80).trim() : undefined
    const description = input.description !== undefined ? textField(input.description, '技能说明', 300).trim() : undefined
    return withTransaction(this.pool, async (client) => {
      const skill = (await client.query<Skill>('select * from skill where id = $1 for update', [id])).rows[0]
      if (!skill) throw new HttpError(404, '技能不存在')
      if (skill.version !== input.expectedVersion) throw new HttpError(409, '技能已被修改，请刷新后再保存')
      const next = skill.version + 1
      const updated = (await client.query<Skill>(
        `update skill set version = $2, body = $3, name = coalesce($4, name), description = coalesce($5, description),
           updated_at = clock_timestamp() where id = $1 returning *`,
        [id, next, body, name ?? null, description ?? null],
      )).rows[0]!
      await client.query('insert into skill_revision(skill_id, version, body) values ($1,$2,$3)', [id, next, body])
      return updated
    })
  }

  async setStatus(id: string, status: 'draft' | 'active'): Promise<Skill> {
    const skill = (await this.pool.query<Skill>(
      'update skill set status = $2, updated_at = clock_timestamp() where id = $1 returning *', [id, status],
    )).rows[0]
    if (!skill) throw new HttpError(404, '技能不存在')
    return skill
  }

  async remove(id: string): Promise<void> {
    const result = await this.pool.query('delete from skill where id = $1', [id])
    if (!result.rowCount) throw new HttpError(404, '技能不存在')
  }

  /** 复制技能文本到新人格；不复制运行日志或工具权限。 */
  async copy(fromProfileId: string, toProfileId: string): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const skills = (await client.query<Skill>(
        'select * from skill where profile_id = $1 order by created_at', [fromProfileId],
      )).rows
      for (const skill of skills) {
        const id = randomUUID()
        await client.query(
          `insert into skill(id, profile_id, name, description, body, version, status)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [id, toProfileId, skill.name, skill.description, skill.body, skill.version, skill.status],
        )
        await client.query(
          'insert into skill_revision(skill_id, version, body) values ($1,$2,$3)',
          [id, skill.version, skill.body],
        )
      }
      return skills.length
    })
  }

  /** 只把 active 技能注入人格说明；有数量与字符上限。 */
  async render(profileId: string): Promise<string> {
    const skills = (await this.pool.query<Skill>(
      'select * from skill where profile_id = $1 and status = $2 order by updated_at desc limit $3',
      [profileId, 'active', MAX_SKILLS],
    )).rows
    const blocks: string[] = []
    let chars = 0
    for (const skill of skills) {
      const block = `<skill name="${skill.name.replaceAll('"', '')}">\n${skill.body.slice(0, MAX_SKILL_CHARS)}\n</skill>`
      if (chars + block.length > MAX_SKILL_CHARS) break
      chars += block.length
      blocks.push(block)
    }
    return blocks.join('\n\n')
  }
}
