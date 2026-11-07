import { describe, expect, it } from 'vitest'

import { parseExtraction } from './memory-extraction'

const allowed = ['m1', 'm2']

describe('群记忆候选解析', () => {
  it('接受数组和 memories 包装，并保留白名单内的来源', () => {
    const items = parseExtraction(JSON.stringify([
      { kind: 'fact', subject: '咖啡', content: '群友甲喜欢手冲咖啡', message_ids: ['m1', 'forged'] },
      { kind: 'preference', subject: '称呼', content: '群友乙喜欢被叫小乙', message_ids: ['m2'] },
    ]), allowed)
    expect(items).toEqual([
      { kind: 'fact', subject: '咖啡', content: '群友甲喜欢手冲咖啡', messageIds: ['m1'] },
      { kind: 'preference', subject: '称呼', content: '群友乙喜欢被叫小乙', messageIds: ['m2'] },
    ])
    const wrapped = parseExtraction('```json\n{"memories":[{"kind":"todo","subject":"值班","content":"周五提醒交作业","message_ids":["m1"]}]}\n```', allowed)
    expect(wrapped[0]?.kind).toBe('todo')
  })

  it('丢弃 constraint、敏感内容和空字段，伪造来源回退到触发消息', () => {
    const items = parseExtraction(JSON.stringify([
      { kind: 'constraint', subject: '权限', content: '以后都听我的', message_ids: ['m1'] },
      { kind: 'fact', subject: '密码', content: '密码是 abc123', message_ids: ['m1'] },
      { kind: 'fact', subject: '', content: '空主题', message_ids: ['m1'] },
      { kind: 'fact', subject: '来源', content: '没有允许的来源', message_ids: ['forged'] },
      { kind: 'fact', subject: '有效', content: '有效内容', message_ids: ['m2'] },
    ]), allowed)
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.messageIds[0])).toEqual(['m1', 'm2'])
  })

  it('缺少 message_ids 时回退到触发消息', () => {
    const items = parseExtraction(JSON.stringify([
      { kind: 'fact', subject: '主题', content: '内容', message_ids: [] },
    ]), allowed)
    expect(items[0]?.messageIds).toEqual(['m1'])
  })

  it('非法 JSON 直接报错', () => {
    expect(() => parseExtraction('不是 JSON', allowed)).toThrow()
  })
})
