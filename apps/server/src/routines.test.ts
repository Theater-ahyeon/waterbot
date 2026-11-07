import { describe, expect, it } from 'vitest'

import { describeTrigger, nextOccurrence, parseTrigger } from './routines'

describe('例行任务触发规则', () => {
  it('解析结构化触发规则并拒绝无效输入', () => {
    expect(parseTrigger({ kind: 'daily', at: '09:30' })).toEqual({ kind: 'daily', at: '09:30' })
    expect(parseTrigger({ kind: 'weekly', weekdays: [5, 1, 5], at: '08:00' }))
      .toEqual({ kind: 'weekly', weekdays: [1, 5], at: '08:00' })
    expect(parseTrigger({ kind: 'interval', everyMinutes: 15 })).toEqual({ kind: 'interval', everyMinutes: 15 })
    expect(parseTrigger({ kind: 'event', name: '新邮件' })).toEqual({ kind: 'event', name: '新邮件' })
    expect(parseTrigger({ kind: 'webhook' })).toEqual({ kind: 'webhook' })
    expect(() => parseTrigger({ kind: 'daily', at: '9:00' })).toThrow('HH:MM')
    expect(() => parseTrigger({ kind: 'weekly', weekdays: [0], at: '09:00' })).toThrow('星期')
    expect(() => parseTrigger({ kind: 'interval', everyMinutes: 0 })).toThrow('间隔分钟')
    expect(() => parseTrigger({ kind: 'cron', expression: '* * * * *' })).toThrow('触发规则')
  })

  it('每天固定时间跨过夏令时缺口时跳过缺失的墙上时间', () => {
    const trigger = parseTrigger({ kind: 'daily', at: '02:30' })
    const next = nextOccurrence(trigger, 'America/New_York', new Date('2026-03-07T12:00:00Z'))
    expect(next?.toISOString()).toBe('2026-03-09T06:30:00.000Z')
  })

  it('夏令时重复的墙上时间只取较早一次', () => {
    const trigger = parseTrigger({ kind: 'daily', at: '01:30' })
    expect(nextOccurrence(trigger, 'America/New_York', new Date('2026-11-01T04:00:00Z'))?.toISOString())
      .toBe('2026-11-01T05:30:00.000Z')
    expect(nextOccurrence(trigger, 'America/New_York', new Date('2026-11-01T05:45:00Z'))?.toISOString())
      .toBe('2026-11-02T06:30:00.000Z')
  })

  it('每周规则按时区计算下一次', () => {
    const trigger = parseTrigger({ kind: 'weekly', weekdays: [1, 3], at: '09:00' })
    expect(nextOccurrence(trigger, 'Asia/Shanghai', new Date('2026-11-10T00:00:00Z'))?.toISOString())
      .toBe('2026-11-11T01:00:00.000Z')
  })

  it('间隔规则使用固定锚点，不随查询时间漂移', () => {
    const trigger = parseTrigger({ kind: 'interval', everyMinutes: 30, startAt: '2026-11-06T00:00:00Z' })
    expect(nextOccurrence(trigger, 'Asia/Shanghai', new Date('2026-11-06T00:10:00Z'))?.toISOString())
      .toBe('2026-11-06T00:30:00.000Z')
    expect(nextOccurrence(trigger, 'Asia/Shanghai', new Date('2026-11-06T00:30:00Z'))?.toISOString())
      .toBe('2026-11-06T01:00:00.000Z')
    expect(nextOccurrence(trigger, 'Asia/Shanghai', new Date('2026-11-06T01:05:00Z'))?.toISOString())
      .toBe('2026-11-06T01:30:00.000Z')
  })

  it('生成可读说明', () => {
    expect(describeTrigger({ kind: 'daily', at: '09:30' }, 'Asia/Shanghai')).toBe('每天 09:30（Asia/Shanghai）')
    expect(describeTrigger({ kind: 'weekly', weekdays: [1, 3], at: '09:00' }, 'Asia/Shanghai')).toBe('每周一、三 09:00（Asia/Shanghai）')
    expect(describeTrigger({ kind: 'interval', everyMinutes: 30 }, 'Asia/Shanghai')).toBe('每 30 分钟')
  })
})
