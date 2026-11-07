import { HttpError } from './http'
import type { Pool } from './pg/connection'

export interface SearchHit {
  id: string
  title: string
  detail: string
  profileId?: string
  timestamp: Date
}

export interface SearchGroup {
  kind: string
  label: string
  items: SearchHit[]
}

const LIMIT = 10

function match(query: string): string {
  return query.trim()
}

/** owner 管理视图搜索；结果只返回摘要，模型搜索仍走各自的会话范围。 */
export class WorkbenchSearch {
  constructor(private readonly pool: Pool) {}

  async search(rawQuery: string, profileId?: string): Promise<SearchGroup[]> {
    const query = match(rawQuery)
    if (query.length < 1 || query.length > 100) throw new HttpError(400, '搜索词长度必须在 1—100 字之间')
    const params = profileId ? [query, profileId] : [query]
    const scoped = profileId ? 'and profile_id = $2' : ''
    const groups: SearchGroup[] = []

    const profiles = await this.pool.query<{ id: string; name: string; instructions: string; created_at: Date }>(
      `select id, name, instructions, created_at from profile
        where strpos(lower(name || ' ' || instructions), lower($1)) > 0
          ${profileId ? 'and id = $2' : ''}
        order by created_at desc limit ${LIMIT}`, params,
    )
    groups.push({
      kind: 'profile', label: '人格',
      items: profiles.rows.map((row) => ({
        id: row.id, title: row.name, detail: row.instructions.slice(0, 160), profileId: row.id, timestamp: row.created_at,
      })),
    })

    const memories = await this.pool.query<{ id: string; subject: string; content: string; profile_id: string; updated_at: Date }>(
      `select m.id, m.subject, v.content, m.profile_id, m.updated_at
         from memory m join memory_version v on v.memory_id = m.id and v.superseded_at is null
        where strpos(lower(v.content || ' ' || m.subject), lower($1)) > 0 and m.state = 'active'
          ${scoped.replace('profile_id', 'm.profile_id')}
        order by m.updated_at desc limit ${LIMIT}`, params,
    )
    groups.push({
      kind: 'memory', label: '记忆',
      items: memories.rows.map((row) => ({
        id: row.id, title: row.subject, detail: row.content.slice(0, 200), profileId: row.profile_id, timestamp: row.updated_at,
      })),
    })

    const skills = await this.pool.query<{ id: string; name: string; body: string; profile_id: string; updated_at: Date }>(
      `select id, name, body, profile_id, updated_at from skill
        where strpos(lower(name || ' ' || body), lower($1)) > 0 ${scoped}
        order by updated_at desc limit ${LIMIT}`, params,
    )
    groups.push({
      kind: 'skill', label: '技能',
      items: skills.rows.map((row) => ({
        id: row.id, title: row.name, detail: row.body.slice(0, 160), profileId: row.profile_id, timestamp: row.updated_at,
      })),
    })

    const routines = await this.pool.query<{ id: string; name: string; instruction: string; profile_id: string; updated_at: Date }>(
      `select id, name, instruction, profile_id, updated_at from routine
        where strpos(lower(name || ' ' || instruction), lower($1)) > 0 ${scoped}
        order by updated_at desc limit ${LIMIT}`, params,
    )
    groups.push({
      kind: 'routine', label: '例行任务',
      items: routines.rows.map((row) => ({
        id: row.id, title: row.name, detail: row.instruction.slice(0, 160), profileId: row.profile_id, timestamp: row.updated_at,
      })),
    })

    const pages = await this.pool.query<{ id: string; title: string; content: unknown; profile_id: string; updated_at: Date }>(
      `select id, title, content, profile_id, updated_at from page
        where strpos(lower(title || ' ' || content::text), lower($1)) > 0 ${scoped}
        order by updated_at desc limit ${LIMIT}`, params,
    )
    groups.push({
      kind: 'page', label: '页面',
      items: pages.rows.map((row) => ({
        id: row.id, title: row.title, detail: JSON.stringify(row.content).slice(0, 160), profileId: row.profile_id, timestamp: row.updated_at,
      })),
    })

    const documents = await this.pool.query<{ id: string; title: string; kind: string; profile_id: string; updated_at: Date }>(
      `select id, title, kind, profile_id, updated_at from document
        where strpos(lower(title), lower($1)) > 0 ${scoped}
        order by updated_at desc limit ${LIMIT}`, params,
    )
    groups.push({
      kind: 'document', label: '文档',
      items: documents.rows.map((row) => ({
        id: row.id, title: row.title, detail: row.kind, profileId: row.profile_id, timestamp: row.updated_at,
      })),
    })

    const executions = await this.pool.query<{ id: string; command: string; status: string; profile_id: string; created_at: Date }>(
      `select id, command, status, profile_id, created_at from execution_task
        where strpos(lower(command || ' ' || coalesce(output, '')), lower($1)) > 0 ${scoped}
        order by created_at desc limit ${LIMIT}`, params,
    )
    groups.push({
      kind: 'execution', label: '执行任务',
      items: executions.rows.map((row) => ({
        id: row.id, title: row.command.slice(0, 120), detail: row.status, profileId: row.profile_id, timestamp: row.created_at,
      })),
    })

    if (!profileId) {
      const messages = await this.pool.query<{ id: string; content: string; external_group_id: string; occurred_at: Date }>(
        `select m.id, m.content, g.external_group_id, m.occurred_at
           from group_message m join qq_group g on g.id = m.group_id
          where m.hidden_at is null and strpos(lower(m.content), lower($1)) > 0
          order by m.occurred_at desc limit ${LIMIT}`, [query],
      )
      groups.push({
        kind: 'message', label: '群消息',
        items: messages.rows.map((row) => ({
          id: row.id, title: `群 ${row.external_group_id}`, detail: row.content.slice(0, 200), timestamp: row.occurred_at,
        })),
      })
    }

    return groups.filter((group) => group.items.length > 0)
  }
}
