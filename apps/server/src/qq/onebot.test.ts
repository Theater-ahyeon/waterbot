import { describe, expect, it } from 'vitest'

import { loadQqConfig } from '../config'
import { attachmentSummary, parseMessage, parseOwnerCommand, parseRecall, textMessage } from './onebot'

const BOT = '10001'
const event = (overrides: Record<string, unknown>) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 10001, user_id: 20002, group_id: 30003,
  message_id: 5, time: 1000, sender: { nickname: '主人' }, message: [{ type: 'text', data: { text: '你好' } }], ...overrides,
})

describe('OneBot 解析', () => {
  it('数组格式：识别 @ Bot、回复和附件', () => {
    const parsed = parseMessage(event({ message: [
      { type: 'reply', data: { id: '77' } }, { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 在吗 ' } }, { type: 'image', data: { file: 'a.png' } },
    ] }), BOT)
    expect(parsed).toMatchObject({
      kind: 'group', groupId: '30003', text: '在吗', mentionsBot: true, replyTo: '77',
      hasAttachment: true, attachments: ['image'],
    })
    expect(attachmentSummary(parsed!.attachments)).toBe('[图片]')
  })

  it('字符串格式：拆 CQ 码并反转义，文本里的转义不算 @', () => {
    const parsed = parseMessage(event({ message: '[CQ:at,qq=10001]看 &#91;CQ:at,qq=10001&#93;' }), BOT)
    expect(parsed).toMatchObject({ text: '看 [CQ:at,qq=10001]', mentionsBot: true })
    expect(parseMessage(event({ message: '&#91;CQ:at,qq=10001&#93;' }), BOT)?.mentionsBot).toBe(false)
  })

  it('@ 别人不算触发', () => {
    expect(parseMessage(event({ message: [{ type: 'at', data: { qq: '99999' } }] }), BOT)?.mentionsBot).toBe(false)
  })

  it('识别群撤回通知，不当作普通消息', () => {
    expect(parseRecall({ post_type: 'notice', notice_type: 'group_recall', group_id: 30003, message_id: 5 }))
      .toEqual({ groupId: '30003', messageId: '5' })
    expect(parseRecall({ post_type: 'message', group_id: 30003, message_id: 5 })).toBeUndefined()
    expect(parseRecall({ post_type: 'notice', notice_type: 'friend_recall', user_id: 20002, message_id: 5 })).toBeUndefined()
  })

  it('忽略别的账号、Bot 自己、元事件和临时会话', () => {
    expect(parseMessage(event({ self_id: 1 }), BOT)).toBeUndefined()
    expect(parseMessage(event({ user_id: 10001 }), BOT)).toBeUndefined()
    expect(parseMessage({ post_type: 'meta_event', self_id: 10001 }, BOT)).toBeUndefined()
    expect(parseMessage(event({ message_type: 'private', sub_type: 'group' }), BOT)).toBeUndefined()
    expect(parseMessage(event({ message_type: 'private', sub_type: 'friend' }), BOT)?.kind).toBe('private')
  })
})

describe('owner 命令', () => {
  it('只接受完整命令', () => {
    expect(parseOwnerCommand('全部停止')).toEqual({ name: 'stop_all' })
    expect(parseOwnerCommand('暂停群 123456')).toEqual({ name: 'pause_group', groupId: '123456' })
    expect(parseOwnerCommand('请全部停止吧')).toBeUndefined()
    expect(parseOwnerCommand('接入群 abc')).toBeUndefined()
    expect(parseOwnerCommand('记住：猫叫汤圆')).toEqual({ name: 'remember', text: '猫叫汤圆' })
    expect(parseOwnerCommand('忘掉 猫')).toEqual({ name: 'forget', text: '猫' })
    expect(parseOwnerCommand('忘掉群 123456')).toEqual({ name: 'forget_group', groupId: '123456' })
    expect(parseOwnerCommand('忘掉人 123456')).toEqual({ name: 'forget_member', userId: '123456' })
    expect(parseOwnerCommand('记住这个数字')).toBeUndefined()
  })
})

describe('出站与配置', () => {
  it('回复只作为文本段发送，CQ 码不会被解析', () => {
    expect(textMessage('[CQ:at,qq=all]')).toEqual([{ type: 'text', data: { text: '[CQ:at,qq=all]' } }])
  })

  it('未配置时不启用，部分配置报错，外发默认关闭', () => {
    expect(loadQqConfig({})).toBeUndefined()
    expect(() => loadQqConfig({ ONEBOT_WS_URL: 'ws://127.0.0.1:3001' })).toThrow('QQ_BOT_ID')
    const base = { ONEBOT_WS_URL: 'ws://127.0.0.1:3001', QQ_BOT_ID: '1', QQ_OWNER_ID: '2' }
    expect(loadQqConfig(base)?.allowSend).toBe(false)
    expect(loadQqConfig({ ...base, QQ_ALLOW_SEND: '1' })?.allowSend).toBe(true)
    expect(loadQqConfig({ ...base, QQ_DAILY_TOKEN_LIMIT: '1200' })?.dailyTokenLimit).toBe(1200)
    expect(() => loadQqConfig({ ...base, QQ_DAILY_TOKEN_LIMIT: '-1' })).toThrow('非负整数')
    expect(() => loadQqConfig({ ...base, QQ_OWNER_ID: '1' })).toThrow('专用小号')
  })
})
