import { randomUUID } from 'node:crypto'

import ICAL from 'ical.js'
import { createDAVClient, type DAVCalendar } from 'tsdav'

import { HttpError } from '../http'
import { optionalString, stringParam } from './http'
import type { Connector, ConnectorActionDraft, ConnectorStatus, StoredAction } from './types'

function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

function icsTime(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function buildEventIcal(input: {
  uid: string
  summary: string
  start: string
  end: string
  description?: string
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Waterbot//Calendar//CN',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(input.start)}`,
    `DTEND:${icsTime(input.end)}`,
    `SUMMARY:${escapeIcs(input.summary)}`,
  ]
  if (input.description) lines.push(`DESCRIPTION:${escapeIcs(input.description)}`)
  lines.push('END:VEVENT', 'END:VCALENDAR', '')
  return lines.join('\r\n')
}

function parseEvents(objects: { url: string; data: string }[]): unknown[] {
  return objects.flatMap((object) => {
    try {
      const component = new ICAL.Component(ICAL.parse(object.data))
      return component.getAllSubcomponents('vevent').map((item) => {
        const event = new ICAL.Event(item)
        return {
          uid: event.uid,
          summary: event.summary,
          start: event.startDate?.toJSDate().toISOString() ?? '',
          end: event.endDate?.toJSDate().toISOString() ?? '',
          location: event.location || '',
          url: object.url,
        }
      })
    } catch {
      return []
    }
  }).slice(0, 100)
}

export class CaldavConnector implements Connector {
  readonly provider = 'caldav'
  readonly label = '日历'
  private calendar?: DAVCalendar

  constructor(private readonly options: {
    serverUrl?: string
    username?: string
    password?: string
    calendarName?: string
  }) {}

  status(): ConnectorStatus {
    const configured = !!(this.options.serverUrl && this.options.username && this.options.password)
    return {
      provider: this.provider, label: this.label, configured,
      detail: configured ? `CalDAV：${this.options.serverUrl}` : '未配置 CALDAV_URL / 用户名 / 密码',
    }
  }

  async read(operation: string, params: Record<string, unknown>): Promise<unknown> {
    this.requireConfig()
    if (operation !== 'events') throw new HttpError(400, '日历读取操作无效')
    const start = stringParam(params, 'start', 40)
    const end = stringParam(params, 'end', 40)
    if (Number.isNaN(new Date(start).getTime()) || Number.isNaN(new Date(end).getTime())) throw new HttpError(400, '时间范围无效')
    const calendar = await this.selectCalendar(optionalString(params, 'calendar', 200))
    const objects = await this.client().then((client) => client.fetchCalendarObjects({
      calendar, timeRange: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    }))
    return parseEvents(objects.map((object) => ({ url: object.url, data: object.data })))
  }

  action(operation: string, params: Record<string, unknown>): ConnectorActionDraft {
    this.requireConfig()
    if (operation !== 'event') throw new HttpError(400, '日历写入操作无效')
    const summary = stringParam(params, 'summary', 200)
    const start = stringParam(params, 'start', 40)
    const end = stringParam(params, 'end', 40)
    if (Number.isNaN(new Date(start).getTime()) || Number.isNaN(new Date(end).getTime())) throw new HttpError(400, '时间无效')
    if (new Date(end) <= new Date(start)) throw new HttpError(400, '结束时间必须晚于开始时间')
    const description = optionalString(params, 'description', 2000)
    const calendar = optionalString(params, 'calendar', 200)
    return {
      account: this.provider, kind: 'caldav.event', target: `caldav:${calendar ?? this.options.calendarName ?? 'default'}`,
      message: `${summary} · ${start} → ${end}`,
      payload: { summary, start, end, ...(description ? { description } : {}), ...(calendar ? { calendar } : {}) },
    }
  }

  async deliver(action: StoredAction): Promise<string> {
    this.requireConfig()
    const summary = action.payload.summary
    const start = action.payload.start
    const end = action.payload.end
    const description = action.payload.description
    const calendarName = action.payload.calendar
    if (typeof summary !== 'string' || typeof start !== 'string' || typeof end !== 'string') throw new Error('日历动作缺少内容')
    const calendar = await this.selectCalendar(typeof calendarName === 'string' ? calendarName : undefined)
    const filename = `waterbot-${randomUUID()}.ics`
    const client = await this.client()
    const response = await client.createCalendarObject({
      calendar,
      filename,
      iCalString: buildEventIcal({
        uid: filename.replace(/\.ics$/, ''),
        summary, start, end,
        ...(typeof description === 'string' ? { description } : {}),
      }),
    })
    if (!response.ok) throw new Error(`日历写入失败：${response.status}`)
    return filename
  }

  private async client() {
    return createDAVClient({
      serverUrl: this.options.serverUrl!,
      credentials: { username: this.options.username!, password: this.options.password! },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    })
  }

  private async selectCalendar(name?: string): Promise<DAVCalendar> {
    if (this.calendar && (!name || this.calendar.displayName === name)) return this.calendar
    const calendars = await this.client().then((client) => client.fetchCalendars())
    const wanted = name ?? this.options.calendarName
    const calendar = wanted ? calendars.find((item) => item.displayName === wanted) : calendars[0]
    if (!calendar) throw new HttpError(404, '找不到日历')
    this.calendar = calendar
    return calendar
  }

  private requireConfig(): void {
    if (!this.options.serverUrl || !this.options.username || !this.options.password) throw new HttpError(503, '日历未配置')
  }
}
