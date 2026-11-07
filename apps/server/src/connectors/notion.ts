import { HttpError } from '../http'
import { jsonRequest, stringParam } from './http'
import type { Connector, ConnectorActionDraft, ConnectorStatus, StoredAction } from './types'

const VERSION = '2022-06-28'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((item) => {
    const text = record(item)
    return typeof text?.plain_text === 'string' ? [text.plain_text] : []
  }).join('')
}

function blockText(block: Record<string, unknown>): string {
  const body = record(block[block.type as string])
  return richText(body?.rich_text)
}

export class NotionConnector implements Connector {
  readonly provider = 'notion'
  readonly label = 'Notion'
  private readonly baseUrl: string

  constructor(private readonly options: { token?: string; baseUrl?: string; version?: string }) {
    this.baseUrl = (options.baseUrl ?? 'https://api.notion.com').replace(/\/+$/, '')
  }

  status(): ConnectorStatus {
    return {
      provider: this.provider, label: this.label,
      configured: !!this.options.token,
      detail: this.options.token ? '已配置 Integration token' : '未配置 NOTION_TOKEN',
    }
  }

  async read(operation: string, params: Record<string, unknown>): Promise<unknown> {
    this.requireToken()
    if (operation === 'search') {
      const query = stringParam(params, 'query', 200)
      const value = await this.request('/v1/search', {
        method: 'POST',
        body: JSON.stringify({ query, page_size: 20 }),
      })
      const results = record(value)?.results
      if (!Array.isArray(results)) throw new HttpError(502, 'Notion 返回格式无效')
      return results.slice(0, 20).map((item) => {
        const page = record(item) ?? {}
        return {
          id: String(page.id ?? ''), object: String(page.object ?? ''),
          url: String(page.url ?? ''), last_edited_time: String(page.last_edited_time ?? ''),
        }
      })
    }
    if (operation === 'page') {
      const pageId = stringParam(params, 'pageId', 80)
      const [page, blocks] = await Promise.all([
        this.request(`/v1/pages/${encodeURIComponent(pageId)}`),
        this.request(`/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100`),
      ])
      const pageRecord = record(page) ?? {}
      const blockList = record(blocks)?.results
      if (!Array.isArray(blockList)) throw new HttpError(502, 'Notion 返回格式无效')
      return {
        id: String(pageRecord.id ?? ''), url: String(pageRecord.url ?? ''),
        blocks: blockList.slice(0, 100).map((item) => {
          const block = record(item) ?? {}
          return { id: String(block.id ?? ''), type: String(block.type ?? ''), text: blockText(block).slice(0, 2000) }
        }),
      }
    }
    throw new HttpError(400, 'Notion 操作无效')
  }

  action(operation: string, params: Record<string, unknown>): ConnectorActionDraft {
    this.requireToken()
    if (operation !== 'append') throw new HttpError(400, 'Notion 写入操作无效')
    const pageId = stringParam(params, 'pageId', 80)
    const text = stringParam(params, 'text', 4000)
    return {
      account: this.provider, kind: 'notion.append', target: `notion:${pageId}`,
      message: text, payload: { pageId, text },
    }
  }

  async deliver(action: StoredAction): Promise<string> {
    this.requireToken()
    const pageId = action.payload.pageId
    const text = action.payload.text
    if (typeof pageId !== 'string' || !pageId || typeof text !== 'string' || !text) {
      throw new Error('Notion 动作缺少内容')
    }
    const value = await this.request(`/v1/blocks/${encodeURIComponent(pageId)}/children`, {
      method: 'PATCH',
      body: JSON.stringify({
        children: [{
          object: 'block', type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
        }],
      }),
    })
    const results = record(value)?.results
    const first = Array.isArray(results) ? results[0] : undefined
    return String(record(first)?.id ?? pageId)
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    return jsonRequest(this.label, `${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'notion-version': this.options.version ?? VERSION,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  }

  private requireToken(): void {
    if (!this.options.token) throw new HttpError(503, 'Notion 未配置')
  }
}
