import { HttpError } from '../http'
import { integerParam, jsonRequest, stringParam } from './http'
import type { Connector, ConnectorActionDraft, ConnectorStatus, StoredAction } from './types'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const CHANNEL = /^[A-Za-z0-9]{2,64}$/

export class SlackConnector implements Connector {
  readonly provider = 'slack'
  readonly label = 'Slack'
  private readonly baseUrl: string

  constructor(private readonly options: { token?: string; baseUrl?: string }) {
    this.baseUrl = (options.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '')
  }

  status(): ConnectorStatus {
    return {
      provider: this.provider, label: this.label,
      configured: !!this.options.token,
      detail: this.options.token ? '已配置 Bot token' : '未配置 SLACK_BOT_TOKEN',
    }
  }

  async read(operation: string, params: Record<string, unknown>): Promise<unknown> {
    this.requireToken()
    if (operation === 'channels') {
      const value = await this.request('/conversations.list?limit=100&exclude_archived=true&types=public_channel,private_channel')
      const body = record(value) ?? {}
      if (body.ok !== true) throw new HttpError(502, `Slack 返回失败：${String(body.error ?? 'unknown')}`)
      const channels = Array.isArray(body.channels) ? body.channels : []
      return channels.slice(0, 100).map((item) => {
        const channel = record(item) ?? {}
        return { id: String(channel.id ?? ''), name: String(channel.name ?? ''), private: channel.is_private === true }
      })
    }
    if (operation === 'messages') {
      const channel = stringParam(params, 'channel', 64)
      if (!CHANNEL.test(channel)) throw new HttpError(400, 'channel 无效')
      const limit = integerParam(params, 'limit', 1, 100, 20)
      const value = await this.request(`/conversations.history?channel=${encodeURIComponent(channel)}&limit=${limit}`)
      const body = record(value) ?? {}
      if (body.ok !== true) throw new HttpError(502, `Slack 返回失败：${String(body.error ?? 'unknown')}`)
      const messages = Array.isArray(body.messages) ? body.messages : []
      return messages.slice(0, limit).map((item) => {
        const message = record(item) ?? {}
        return { ts: String(message.ts ?? ''), user: String(message.user ?? ''), text: String(message.text ?? '').slice(0, 4000) }
      })
    }
    throw new HttpError(400, 'Slack 读取操作无效')
  }

  action(operation: string, params: Record<string, unknown>): ConnectorActionDraft {
    this.requireToken()
    if (operation !== 'post') throw new HttpError(400, 'Slack 写入操作无效')
    const channel = stringParam(params, 'channel', 64)
    if (!CHANNEL.test(channel)) throw new HttpError(400, 'channel 无效')
    const text = stringParam(params, 'text', 4000)
    return {
      account: this.provider, kind: 'slack.post', target: `slack:${channel}`,
      message: text, payload: { channel, text },
    }
  }

  async deliver(action: StoredAction): Promise<string> {
    this.requireToken()
    const channel = action.payload.channel
    const text = action.payload.text
    if (typeof channel !== 'string' || typeof text !== 'string') throw new Error('Slack 动作缺少内容')
    const value = await this.request('/chat.postMessage', {
      method: 'POST',
      body: JSON.stringify({ channel, text }),
    })
    const body = record(value) ?? {}
    if (body.ok !== true) throw new Error(`Slack 发送失败：${String(body.error ?? 'unknown')}`)
    return String(body.ts ?? '')
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    return jsonRequest(this.label, `${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  }

  private requireToken(): void {
    if (!this.options.token) throw new HttpError(503, 'Slack 未配置')
  }
}
