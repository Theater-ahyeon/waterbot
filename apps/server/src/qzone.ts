import { randomUUID } from 'node:crypto'

import type { Action } from './actions'
import { HttpError } from './http'
import type { Pool } from './pg/connection'

export interface QzonePost {
  id: string
  account_id: string
  target_uin: string
  tid: string
  content: string
  images: unknown[]
  comments: number
  is_private: boolean
  posted_at: Date
  fetched_at: Date
}

export type QzoneCaller = (action: string, params: Record<string, unknown>) => Promise<unknown>

interface RawPost {
  tid: string
  content: string
  time: number
  comment_num?: number
  is_private?: boolean
  images?: unknown[]
}

/** SnowLuma / OneBot 的 Qzone 列表结构；坏条目跳过，不把整页当失败。 */
export function normalizeQzone(raw: unknown): RawPost[] {
  if (typeof raw !== 'object' || raw === null) throw new Error('QQ 空间返回格式无效')
  const list = (raw as { msglist?: unknown }).msglist
  if (!Array.isArray(list)) throw new Error('QQ 空间返回缺少 msglist')
  return list.flatMap((item): RawPost[] => {
    if (typeof item !== 'object' || item === null) return []
    const post = item as Record<string, unknown>
    if (typeof post.tid !== 'string' || typeof post.content !== 'string' || typeof post.time !== 'number') return []
    return [{
      tid: post.tid,
      content: post.content.slice(0, 8000),
      time: post.time,
      comment_num: typeof post.comment_num === 'number' ? post.comment_num : 0,
      is_private: post.is_private === true,
      images: Array.isArray(post.images) ? post.images : [],
    }]
  })
}

export class QzoneService {
  constructor(
    private readonly pool: Pool,
    private readonly accountId: string,
    private readonly selfUin: string,
    private readonly call: QzoneCaller,
    private readonly allowWrite = false,
  ) {}

  /** 只读拉取；失败时把状态标成 paused，不循环重试。 */
  async refresh(targetUin = this.selfUin): Promise<QzonePost[]> {
    const target = /^\d{5,12}$/.test(targetUin) ? targetUin : this.selfUin
    try {
      const raw = await this.call('get_qzone_msg_list', {
        target_uin: Number(target), pos: 0, count: 20,
      })
      const posts = normalizeQzone(raw)
      for (const post of posts) {
        await this.pool.query(
          `insert into qzone_post(id, account_id, target_uin, tid, content, images, comments, is_private, posted_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9))
           on conflict (account_id, target_uin, tid) do update
             set content = excluded.content, images = excluded.images, comments = excluded.comments,
                 is_private = excluded.is_private, posted_at = excluded.posted_at, fetched_at = clock_timestamp()`,
          [randomUUID(), this.accountId, target, post.tid, post.content, JSON.stringify(post.images), post.comment_num ?? 0, post.is_private ?? false, post.time],
        )
      }
      await this.pool.query(
        `insert into qzone_status(account_id, state, last_error, last_fetch_at)
         values ($1,'ready',null,clock_timestamp())
         on conflict (account_id) do update set state='ready', last_error=null, last_fetch_at=clock_timestamp()`,
        [this.accountId],
      )
      return this.posts(target)
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      await this.pool.query(
        `insert into qzone_status(account_id, state, last_error, last_fetch_at)
         values ($1,'paused',$2,clock_timestamp())
         on conflict (account_id) do update set state='paused', last_error=$2, last_fetch_at=clock_timestamp()`,
        [this.accountId, message],
      )
      throw new HttpError(502, `QQ 空间读取失败：${message}`)
    }
  }

  async posts(targetUin = this.selfUin): Promise<QzonePost[]> {
    return (await this.pool.query<QzonePost>(
      `select * from qzone_post where account_id = $1 and target_uin = $2 order by posted_at desc limit 100`,
      [this.accountId, targetUin],
    )).rows
  }

  /** Action 执行端：只读开关关闭时直接失败，不能把未授权评论发出去。 */
  async comment(action: Action): Promise<string> {
    if (!this.allowWrite) throw new Error('QZONE_ALLOW_WRITE 未开启')
    const tid = typeof action.payload.tid === 'string' ? action.payload.tid.trim() : ''
    const content = typeof action.payload.message === 'string' ? action.payload.message.trim() : ''
    if (!tid || !content) throw new Error('评论缺少 tid 或内容')
    const targetUin = typeof action.payload.targetUin === 'string' && /^\d{5,12}$/.test(action.payload.targetUin)
      ? Number(action.payload.targetUin)
      : undefined
    const raw = await this.call('comment_qzone', {
      tid,
      content: content.slice(0, 1000),
      ...(targetUin ? { target_uin: targetUin } : {}),
    })
    const receipt = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : `qzone:${tid}`
    return receipt
  }

  async status(): Promise<{ state: string; lastError: string | null; lastFetchAt: Date | null }> {
    const row = (await this.pool.query<{ state: string; last_error: string | null; last_fetch_at: Date | null }>(
      'select state, last_error, last_fetch_at from qzone_status where account_id = $1', [this.accountId],
    )).rows[0]
    return { state: row?.state ?? 'idle', lastError: row?.last_error ?? null, lastFetchAt: row?.last_fetch_at ?? null }
  }
}
