import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'

import { HttpError } from '../http'
import { integerParam, stringParam } from './http'
import type { Connector, ConnectorActionDraft, ConnectorStatus, StoredAction } from './types'

export interface EmailConfig {
  imapHost: string
  imapPort: number
  imapSecure: boolean
  imapUser: string
  imapPassword: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPassword: string
  from: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

export function loadEmailConfig(env: NodeJS.ProcessEnv): EmailConfig | undefined {
  const imapHost = env.IMAP_HOST?.trim()
  const imapUser = env.IMAP_USER?.trim()
  const imapPassword = env.IMAP_PASSWORD
  const smtpHost = env.SMTP_HOST?.trim()
  const smtpUser = env.SMTP_USER?.trim()
  const smtpPassword = env.SMTP_PASSWORD
  const from = env.SMTP_FROM?.trim()
  if (!imapHost && !smtpHost) return undefined
  if (!imapHost || !imapUser || !imapPassword || !smtpHost || !smtpUser || !smtpPassword || !from) {
    throw new Error('IMAP_HOST / IMAP_USER / IMAP_PASSWORD / SMTP_HOST / SMTP_USER / SMTP_PASSWORD / SMTP_FROM 必须同时设置')
  }
  return {
    imapHost, imapUser, imapPassword,
    imapPort: Number(env.IMAP_PORT?.trim() || 993),
    imapSecure: flag(env.IMAP_SECURE?.trim() || '1'),
    smtpHost, smtpUser, smtpPassword, from,
    smtpPort: Number(env.SMTP_PORT?.trim() || 465),
    smtpSecure: flag(env.SMTP_SECURE?.trim() || '1'),
  }
}

export class EmailConnector implements Connector {
  readonly provider = 'email'
  readonly label = '邮箱'

  constructor(private readonly config?: EmailConfig) {}

  status(): ConnectorStatus {
    return {
      provider: this.provider, label: this.label, configured: !!this.config,
      detail: this.config ? `${this.config.imapUser} → ${this.config.smtpHost}` : '未配置 IMAP / SMTP',
    }
  }

  async read(operation: string, params: Record<string, unknown>): Promise<unknown> {
    const config = this.requireConfig()
    const client = new ImapFlow({
      host: config.imapHost, port: config.imapPort, secure: config.imapSecure,
      auth: { user: config.imapUser, pass: config.imapPassword }, logger: false,
    })
    await client.connect()
    try {
      const lock = await client.getMailboxLock('INBOX')
      try {
        if (operation === 'inbox') {
          const limit = integerParam(params, 'limit', 1, 50, 10)
          const mailbox = client.mailbox
          if (!mailbox || typeof mailbox === 'boolean') throw new HttpError(502, 'IMAP 邮箱状态无效')
          const from = Math.max(1, mailbox.exists - limit + 1)
          const messages: unknown[] = []
          for await (const message of client.fetch(`${from}:*`, { envelope: true, uid: true, flags: true, internalDate: true })) {
            const internal = message.internalDate
            messages.push({
              uid: message.uid,
              subject: message.envelope?.subject ?? '',
              from: message.envelope?.from?.map((item) => item.address ?? '').filter(Boolean).join(', ') ?? '',
              date: internal instanceof Date ? internal.toISOString() : String(internal ?? ''),
              seen: message.flags?.has('\\Seen') ?? false,
            })
          }
          return messages.reverse().slice(0, limit)
        }
        if (operation === 'message') {
          const uid = integerParam(params, 'uid', 1, Number.MAX_SAFE_INTEGER, 0)
          if (!uid) throw new HttpError(400, 'uid 无效')
          const message = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true })
          if (message === false || !message?.source) throw new HttpError(404, '邮件不存在')
          const parsed = await simpleParser(message.source)
          return {
            uid,
            subject: parsed.subject ?? '',
            from: parsed.from?.text ?? '',
            to: Array.isArray(parsed.to) ? parsed.to.map((item) => item.text).join(', ') : parsed.to?.text ?? '',
            date: parsed.date?.toISOString() ?? '',
            text: (parsed.text ?? '').slice(0, 20_000),
            attachments: parsed.attachments.slice(0, 20).map((item) => ({ filename: item.filename ?? '', size: item.size })),
          }
        }
        throw new HttpError(400, '邮箱读取操作无效')
      } finally {
        lock.release()
      }
    } finally {
      await client.logout().catch(() => undefined)
    }
  }

  action(operation: string, params: Record<string, unknown>): ConnectorActionDraft {
    this.requireConfig()
    if (operation !== 'send') throw new HttpError(400, '邮箱写入操作无效')
    const to = stringParam(params, 'to', 320)
    if (!EMAIL.test(to)) throw new HttpError(400, '收件人无效')
    const subject = stringParam(params, 'subject', 200)
    const text = stringParam(params, 'text', 20_000)
    return {
      account: this.provider, kind: 'email.send', target: `email:${to.toLowerCase()}`,
      message: `主题：${subject}\n\n${text}`,
      payload: { to, subject, text },
    }
  }

  async deliver(action: StoredAction): Promise<string> {
    const config = this.requireConfig()
    const to = action.payload.to
    const subject = action.payload.subject
    const text = action.payload.text
    if (typeof to !== 'string' || typeof subject !== 'string' || typeof text !== 'string') throw new Error('邮件动作缺少内容')
    const transport = nodemailer.createTransport({
      host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPassword },
    })
    const info = await transport.sendMail({ from: config.from, to, subject, text })
    return info.messageId
  }

  private requireConfig(): EmailConfig {
    if (!this.config) throw new HttpError(503, '邮箱未配置')
    return this.config
  }
}
