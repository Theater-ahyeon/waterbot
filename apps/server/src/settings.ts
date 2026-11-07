import { HttpError } from './http'
import type { Pool } from './pg/connection'

export interface OwnerSettings {
  timezone: string
  theme: 'light' | 'dark' | 'system'
  density: 'comfortable' | 'compact'
  notifications: boolean
}

const DEFAULTS: OwnerSettings = {
  timezone: 'Asia/Shanghai',
  theme: 'system',
  density: 'comfortable',
  notifications: true,
}

function timezone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, '时区无效')
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format(new Date())
  } catch {
    throw new HttpError(400, '时区无效')
  }
  return value
}

function merge(current: OwnerSettings, body: Record<string, unknown>): OwnerSettings {
  const next = { ...current }
  for (const key of Object.keys(body)) {
    if (!(key in DEFAULTS)) throw new HttpError(400, `设置项无效：${key}`)
  }
  if (body.timezone !== undefined) next.timezone = timezone(body.timezone)
  if (body.theme !== undefined) {
    if (body.theme !== 'light' && body.theme !== 'dark' && body.theme !== 'system') throw new HttpError(400, '主题无效')
    next.theme = body.theme
  }
  if (body.density !== undefined) {
    if (body.density !== 'comfortable' && body.density !== 'compact') throw new HttpError(400, '密度无效')
    next.density = body.density
  }
  if (body.notifications !== undefined) {
    if (typeof body.notifications !== 'boolean') throw new HttpError(400, '通知设置无效')
    next.notifications = body.notifications
  }
  return next
}

export class Settings {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<OwnerSettings> {
    const row = (await this.pool.query<{ value: Partial<OwnerSettings> }>(
      'select value from owner_setting where id = $1', ['ui'],
    )).rows[0]
    return { ...DEFAULTS, ...(row?.value ?? {}) }
  }

  async update(body: Record<string, unknown>): Promise<OwnerSettings> {
    const current = await this.get()
    const next = merge(current, body)
    await this.pool.query(
      `insert into owner_setting(id, value) values ('ui', $1)
       on conflict (id) do update set value = excluded.value, updated_at = clock_timestamp()`,
      [JSON.stringify(next)],
    )
    return next
  }
}
