import { createHash } from 'node:crypto'

import { HttpError } from '../http'
import { jsonRequest, stringParam } from './http'
import type { Connector, ConnectorActionDraft, ConnectorStatus, StoredAction } from './types'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const BVID = /^BV[0-9A-Za-z]{10}$/

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function mixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((index) => orig[index] ?? '').join('').slice(0, 32)
}

export function signWbi(params: Record<string, string | number>, key: string, now = Date.now()): string {
  const wts = Math.floor(now / 1000)
  const values: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(values).sort().map((name) => {
    const value = String(values[name]).replace(/[!'()*]/g, '')
    return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
  }).join('&')
  const wRid = createHash('md5').update(`${query}${key}`).digest('hex')
  return `${query}&w_rid=${wRid}`
}

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<[^>]+>/g, '').trim() : ''
}

export class BilibiliConnector implements Connector {
  readonly provider = 'bilibili'
  readonly label = 'B站'
  private readonly baseUrl: string
  private readonly cookie?: string
  private mixin?: { key: string; expires: number }

  constructor(options: { cookie?: string; baseUrl?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.bilibili.com').replace(/\/+$/, '')
    this.cookie = options.cookie
  }

  status(): ConnectorStatus {
    return {
      provider: this.provider, label: this.label, configured: true,
      detail: this.cookie ? '公开读取 + 账号 Cookie' : '公开只读；写评论需要 BILIBILI_COOKIE',
    }
  }

  async read(operation: string, params: Record<string, unknown>): Promise<unknown> {
    if (operation === 'search') {
      const keyword = stringParam(params, 'keyword', 100)
      const query = await this.sign({ search_type: 'video', keyword, page: 1 })
      const data = await this.data(`/x/web-interface/wbi/search/type?${query}`)
      const result = data.result
      if (!Array.isArray(result)) throw new HttpError(502, 'B站返回格式无效')
      return result.slice(0, 20).map((item) => {
        const video = record(item) ?? {}
        return {
          bvid: String(video.bvid ?? ''), title: plainText(video.title),
          author: String(video.author ?? ''), play: Number(video.play ?? 0),
          description: plainText(video.description).slice(0, 500),
        }
      })
    }
    if (operation === 'video' || operation === 'comments') {
      const bvid = stringParam(params, 'bvid', 20)
      if (!BVID.test(bvid)) throw new HttpError(400, 'bvid 无效')
      const video = await this.video(bvid)
      if (operation === 'video') return video
      const data = await this.data(`/x/v2/reply?type=1&oid=${video.aid}&pn=1&ps=20`)
      const replies = data.replies
      if (!Array.isArray(replies)) return []
      return replies.slice(0, 20).map((item) => {
        const reply = record(item) ?? {}
        const member = record(reply.member) ?? {}
        return {
          rpid: String(reply.rpid ?? ''), user: String(member.uname ?? ''),
          message: String(record(reply.content)?.message ?? '').slice(0, 2000),
          like: Number(reply.like ?? 0),
        }
      })
    }
    throw new HttpError(400, 'B站读取操作无效')
  }

  action(operation: string, params: Record<string, unknown>): ConnectorActionDraft {
    if (operation !== 'comment') throw new HttpError(400, 'B站写入操作无效')
    if (!this.cookie || !this.csrf()) throw new HttpError(503, 'B站写评论需要 BILIBILI_COOKIE 和 bili_jct')
    const bvid = stringParam(params, 'bvid', 20)
    if (!BVID.test(bvid)) throw new HttpError(400, 'bvid 无效')
    const text = stringParam(params, 'text', 1000)
    return {
      account: this.provider, kind: 'bilibili.comment', target: `bilibili:${bvid}`,
      message: text, payload: { bvid, text },
    }
  }

  async deliver(action: StoredAction): Promise<string> {
    const bvid = action.payload.bvid
    const text = action.payload.text
    if (typeof bvid !== 'string' || typeof text !== 'string') throw new Error('B站动作缺少内容')
    if (!this.cookie || !this.csrf()) throw new Error('B站 Cookie 或 csrf 缺失')
    const video = await this.video(bvid)
    const body = new URLSearchParams({ oid: String(video.aid), type: '1', message: text, csrf: this.csrf() })
    const value = await jsonRequest(this.label, `${this.baseUrl}/x/v2/reply/add`, {
      method: 'POST',
      headers: {
        cookie: this.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    const envelope = record(value) ?? {}
    if (envelope.code !== 0) throw new Error(`B站评论失败：${String(envelope.message ?? envelope.code)}`)
    const data = record(envelope.data)
    return String(data?.rpid ?? '')
  }

  private async video(bvid: string): Promise<{ aid: number; bvid: string; title: string; author: string; description: string; play: number }> {
    const data = await this.data(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
    const stat = record(data.stat) ?? {}
    return {
      aid: Number(data.aid ?? 0), bvid: String(data.bvid ?? bvid),
      title: String(data.title ?? ''), author: String(record(data.owner)?.name ?? ''),
      description: String(data.desc ?? '').slice(0, 1000), play: Number(stat.view ?? 0),
    }
  }

  private async data(path: string): Promise<Record<string, unknown>> {
    const value = await jsonRequest(this.label, `${this.baseUrl}${path}`, {
      headers: this.cookie ? { cookie: this.cookie } : {},
    })
    const envelope = record(value) ?? {}
    if (envelope.code !== 0) throw new HttpError(502, `B站返回失败：${String(envelope.message ?? envelope.code)}`)
    const data = record(envelope.data)
    if (!data) throw new HttpError(502, 'B站返回格式无效')
    return data
  }

  private async sign(params: Record<string, string | number>): Promise<string> {
    const key = await this.mixinKey()
    return signWbi(params, key)
  }

  private async mixinKey(): Promise<string> {
    if (this.mixin && this.mixin.expires > Date.now()) return this.mixin.key
    const value = await jsonRequest(this.label, `${this.baseUrl}/x/web-interface/nav`, {
      headers: this.cookie ? { cookie: this.cookie } : {},
    })
    const data = record(record(value)?.data) ?? {}
    const image = record(data.wbi_img)
    const imgUrl = typeof image?.img_url === 'string' ? image.img_url : ''
    const subUrl = typeof image?.sub_url === 'string' ? image.sub_url : ''
    const fileName = (url: string) => url.slice(url.lastIndexOf('/') + 1).split('.')[0] ?? ''
    const orig = `${fileName(imgUrl)}${fileName(subUrl)}`
    if (orig.length < 64) throw new HttpError(502, 'B站 WBI 密钥缺失')
    this.mixin = { key: mixinKey(orig), expires: Date.now() + 60 * 60_000 }
    return this.mixin.key
  }

  private csrf(): string {
    const match = this.cookie ? /(?:^|;\s*)bili_jct=([^;]+)/.exec(this.cookie) : null
    return match?.[1] ?? ''
  }
}
