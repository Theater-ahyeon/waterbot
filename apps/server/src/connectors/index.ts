import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'

import { HttpError } from '../http'
import { BilibiliConnector } from './bilibili'
import { CaldavConnector } from './caldav'
import { EmailConnector, loadEmailConfig } from './email'
import { NotionConnector } from './notion'
import { SlackConnector } from './slack'
import type { Connector, ConnectorActionDraft, ConnectorStatus, StoredAction } from './types'
import { XConnector } from './x'

export class Connectors {
  constructor(private readonly providers: readonly Connector[]) {}

  statuses(): ConnectorStatus[] {
    return this.providers.map((provider) => provider.status())
  }

  async read(providerName: string, operation: string, params: Record<string, unknown>): Promise<unknown> {
    return this.find(providerName).read(operation, params)
  }

  action(providerName: string, operation: string, params: Record<string, unknown>): ConnectorActionDraft {
    const provider = this.find(providerName)
    if (!provider.action) throw new HttpError(400, `${provider.label}不支持写入`)
    return provider.action(operation, params)
  }

  supports(account: string): boolean {
    return this.providers.some((provider) => provider.provider === account && !!provider.deliver)
  }

  async deliver(action: StoredAction): Promise<string> {
    const provider = this.providers.find((candidate) => candidate.provider === action.account_id)
    if (!provider?.deliver) throw new Error(`连接器 ${action.account_id} 不支持执行`)
    return provider.deliver(action)
  }

  private find(name: string): Connector {
    const provider = this.providers.find((candidate) => candidate.provider === name)
    if (!provider) throw new HttpError(404, '连接器不存在')
    return provider
  }
}

export function createConnectors(env: NodeJS.ProcessEnv): Connectors {
  return new Connectors([
    new NotionConnector({
      ...(env.NOTION_TOKEN?.trim() ? { token: env.NOTION_TOKEN.trim() } : {}),
      ...(env.NOTION_BASE_URL?.trim() ? { baseUrl: env.NOTION_BASE_URL.trim() } : {}),
    }),
    new SlackConnector({
      ...(env.SLACK_BOT_TOKEN?.trim() ? { token: env.SLACK_BOT_TOKEN.trim() } : {}),
      ...(env.SLACK_BASE_URL?.trim() ? { baseUrl: env.SLACK_BASE_URL.trim() } : {}),
    }),
    new XConnector({
      ...(env.X_BEARER_TOKEN?.trim() ? { token: env.X_BEARER_TOKEN.trim() } : {}),
      ...(env.X_BASE_URL?.trim() ? { baseUrl: env.X_BASE_URL.trim() } : {}),
    }),
    new BilibiliConnector({
      ...(env.BILIBILI_COOKIE?.trim() ? { cookie: env.BILIBILI_COOKIE.trim() } : {}),
      ...(env.BILIBILI_BASE_URL?.trim() ? { baseUrl: env.BILIBILI_BASE_URL.trim() } : {}),
    }),
    new CaldavConnector({
      ...(env.CALDAV_URL?.trim() ? { serverUrl: env.CALDAV_URL.trim() } : {}),
      ...(env.CALDAV_USERNAME?.trim() ? { username: env.CALDAV_USERNAME.trim() } : {}),
      ...(env.CALDAV_PASSWORD ? { password: env.CALDAV_PASSWORD } : {}),
      ...(env.CALDAV_CALENDAR?.trim() ? { calendarName: env.CALDAV_CALENDAR.trim() } : {}),
    }),
    new EmailConnector(loadEmailConfig(env)),
  ])
}

export function createConnectorTools(connectors: Connectors): ToolRegistration {
  return defineTool({
    name: 'connector_read',
    description: 'Read from a configured connector (notion, slack, x, bilibili, caldav, email). Operations are provider-specific; no writes.',
    parameters: Type.Object({
      provider: Type.String({ description: 'notion, slack, x, bilibili, caldav, or email' }),
      operation: Type.String({ description: 'Operation name, for example search, channels, messages, inbox, events, video' }),
      params: Type.Optional(Type.Any({ description: 'Operation parameters object' })),
    }),
    replay: 'safe',
    execute: async (args) => {
      const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params)
        ? args.params as Record<string, unknown>
        : {}
      const value = await connectors.read(args.provider, args.operation, params)
      return { output: [{ type: 'text', text: JSON.stringify(value).slice(0, 20_000) }] }
    },
  })
}
