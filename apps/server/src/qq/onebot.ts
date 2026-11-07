/** OneBot v11 协议解析：只认平台字段；昵称、群名片和正文都不参与身份判断。 */

export interface QqMessage {
  kind: 'private' | 'group'
  userId: string
  groupId?: string
  messageId: string
  time: number
  text: string
  /** 仅展示和存档；不参与身份判断 */
  nickname?: string
  mentionsBot: boolean
  replyTo?: string
  /** 图片、语音等非文本段；首版只标记，不下载 */
  hasAttachment: boolean
  attachments: string[]
}

interface Segment { type: string; data: Record<string, unknown> }

function segmentsOf(message: unknown): Segment[] | undefined {
  if (Array.isArray(message)) {
    const segments = message.filter((item): item is Segment => typeof item?.type === 'string')
    return segments.map((item) => ({ type: item.type, data: item.data ?? {} }))
  }
  if (typeof message !== 'string') return undefined
  // 字符串格式：拆出 CQ 码，其余按文本反转义。
  const segments: Segment[] = []
  const pattern = /\[CQ:([a-z_]+)((?:,[^\],]+=[^\],]*)*)\]/g
  let cursor = 0
  const text = (raw: string) => {
    if (raw) segments.push({ type: 'text', data: { text: raw.replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&amp;', '&') } })
  }
  for (const match of message.matchAll(pattern)) {
    text(message.slice(cursor, match.index))
    const data = Object.fromEntries((match[2] ?? '').split(',').filter(Boolean).map((pair) => {
      const index = pair.indexOf('=')
      return [pair.slice(0, index), pair.slice(index + 1)]
    }))
    segments.push({ type: match[1]!, data })
    cursor = match.index + match[0].length
  }
  text(message.slice(cursor))
  return segments
}

const id = (value: unknown): string | undefined =>
  (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value)) ? String(value) : undefined

/** 不是发给这个账号的普通消息一律返回 undefined。 */
export function parseMessage(raw: unknown, botId: string): QqMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const event = raw as Record<string, unknown>
  if (event.post_type !== 'message' || id(event.self_id) !== botId) return undefined
  const userId = id(event.user_id)
  const messageId = id(event.message_id)
  const time = event.time
  const segments = segmentsOf(event.message)
  if (!userId || !messageId || typeof time !== 'number' || !segments || userId === botId) return undefined
  const kind = event.message_type
  if (kind !== 'private' && kind !== 'group') return undefined
  const groupId = id(event.group_id)
  if (kind === 'group' && !groupId) return undefined
  // 临时会话等不是好友私聊，不能当作主人入口。
  if (kind === 'private' && event.sub_type !== 'friend') return undefined

  const sender = (event.sender ?? {}) as { card?: unknown; nickname?: unknown }
  const nickname = [sender.card, sender.nickname].find((value): value is string => typeof value === 'string' && value.length > 0)
  const parts: string[] = []
  let mentionsBot = false
  let replyTo: string | undefined
  const attachments: string[] = []
  for (const segment of segments) {
    if (segment.type === 'text') parts.push(String(segment.data.text ?? ''))
    else if (segment.type === 'at') mentionsBot ||= id(segment.data.qq) === botId
    else if (segment.type === 'reply') replyTo = id(segment.data.id)
    else if (segment.type === 'image' || segment.type === 'record' || segment.type === 'video' || segment.type === 'file') {
      attachments.push(segment.type)
    }
  }
  return {
    kind, userId, messageId, time, text: parts.join('').trim(), mentionsBot,
    hasAttachment: attachments.length > 0, attachments,
    ...(groupId && kind === 'group' ? { groupId } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(nickname ? { nickname } : {}),
  }
}

export function attachmentSummary(types: readonly string[]): string {
  const names: Record<string, string> = { image: '图片', record: '语音', video: '视频', file: '文件' }
  return types.map((type) => `[${names[type] ?? '附件'}]`).join('')
}

export interface QqRecall {
  groupId: string
  messageId: string
}

/** OneBot 群撤回通知；不是消息，不能进 parseMessage。 */
export function parseRecall(raw: unknown): QqRecall | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const event = raw as Record<string, unknown>
  if (event.post_type !== 'notice' || event.notice_type !== 'group_recall') return undefined
  const groupId = id(event.group_id)
  const messageId = id(event.message_id)
  return groupId && messageId ? { groupId, messageId } : undefined
}

/** 文本段发送：回复内容里的 CQ 码不会被协议端当成指令解析。 */
export function textMessage(text: string): { type: 'text'; data: { text: string } }[] {
  return [{ type: 'text', data: { text } }]
}

export type OwnerCommand =
  | { name: 'stop_all' }
  | { name: 'resume_all' }
  | { name: 'list_memory' }
  | { name: 'remember'; text: string }
  | { name: 'forget'; text: string }
  | { name: 'forget_member'; userId: string }
  | { name: 'add_group' | 'pause_group' | 'resume_group' | 'forget_group'; groupId: string }

export function parseOwnerCommand(text: string): OwnerCommand | undefined {
  if (text === '全部停止') return { name: 'stop_all' }
  if (text === '全部恢复') return { name: 'resume_all' }
  if (text === '你记得什么') return { name: 'list_memory' }
  const member = /^忘掉人\s*(\d{5,12})$/.exec(text)
  if (member) return { name: 'forget_member', userId: member[1]! }
  const match = /^(接入群|暂停群|恢复群|忘掉群)\s*(\d{5,12})$/.exec(text)
  if (match) {
    const names = { 接入群: 'add_group', 暂停群: 'pause_group', 恢复群: 'resume_group', 忘掉群: 'forget_group' } as const
    return { name: names[match[1] as keyof typeof names], groupId: match[2]! }
  }
  const memory = /^(记住|忘掉)[：:\s]\s*(\S[\s\S]*)$/.exec(text)
  if (memory) return { name: memory[1] === '记住' ? 'remember' : 'forget', text: memory[2]! }
  return undefined
}
