import { HttpError } from '../http'
import { jsonRequest, stringParam } from './http'
import type { Connector, ConnectorStatus } from './types'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function tweets(value: unknown): unknown[] {
  const data = record(value)?.data
  if (!Array.isArray(data)) throw new HttpError(502, 'X 返回格式无效')
  return data.slice(0, 10).map((item) => {
    const tweet = record(item) ?? {}
    return {
      id: String(tweet.id ?? ''),
      text: String(tweet.text ?? '').slice(0, 4000),
      created_at: String(tweet.created_at ?? ''),
      author_id: String(tweet.author_id ?? ''),
    }
  })
}

const USERNAME = /^[A-Za-z0-9_]{1,15}$/

export class XConnector implements Connector {
  readonly provider = 'x'
  readonly label = 'X'
  private readonly baseUrl: string

  constructor(private readonly options: { token?: string; baseUrl?: string }) {
    this.baseUrl = (options.baseUrl ?? 'https://api.x.com/2').replace(/\/+$/, '')
  }

  status(): ConnectorStatus {
    return {
      provider: this.provider, label: this.label,
      configured: !!this.options.token,
      detail: this.options.token ? '只读 Bearer token；没有写入凭据' : '未配置 X_BEARER_TOKEN',
    }
  }

  async read(operation: string, params: Record<string, unknown>): Promise<unknown> {
    this.requireToken()
    if (operation === 'search') {
      const query = stringParam(params, 'query', 512)
      return tweets(await this.request(
        `/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=created_at,author_id`,
      ))
    }
    if (operation === 'user') {
      const username = stringParam(params, 'username', 15)
      if (!USERNAME.test(username)) throw new HttpError(400, 'username 无效')
      const profile = record(await this.request(`/users/by/username/${encodeURIComponent(username)}?user.fields=description,public_metrics`))
      const user = record(profile?.data)
      if (!user) throw new HttpError(502, 'X 返回格式无效')
      const id = String(user.id ?? '')
      const timeline = tweets(await this.request(
        `/users/${encodeURIComponent(id)}/tweets?max_results=10&tweet.fields=created_at,author_id`,
      ))
      return {
        id, username: String(user.username ?? username), name: String(user.name ?? ''),
        description: String(user.description ?? '').slice(0, 1000), tweets: timeline,
      }
    }
    throw new HttpError(400, 'X 读取操作无效')
  }

  private async request(path: string): Promise<unknown> {
    return jsonRequest(this.label, `${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.options.token}` },
    })
  }

  private requireToken(): void {
    if (!this.options.token) throw new HttpError(503, 'X 未配置')
  }
}
