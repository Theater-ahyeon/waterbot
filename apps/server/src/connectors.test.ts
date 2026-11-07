import { createServer, type IncomingMessage, type Server } from 'node:http'

import ICAL from 'ical.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BilibiliConnector, signWbi } from './connectors/bilibili'
import { buildEventIcal, CaldavConnector } from './connectors/caldav'
import { EmailConnector, loadEmailConfig } from './connectors/email'
import { Connectors } from './connectors'
import { NotionConnector } from './connectors/notion'
import { SlackConnector } from './connectors/slack'
import { XConnector } from './connectors/x'

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

describe('具名连接器（本地夹具）', () => {
  let server: Server
  let base = ''
  let authorization = ''
  let lastPost = ''
  let notion: NotionConnector
  let slack: SlackConnector
  let x: XConnector
  let bilibili: BilibiliConnector

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        authorization = String(request.headers.authorization ?? '')
        const url = request.url ?? '/'
        const json = (value: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        if (url === '/v1/search') return json({ results: [{ id: 'page1', object: 'page', url: 'https://notion.so/page1', last_edited_time: '2026-11-06T00:00:00Z' }] })
        if (url === '/v1/pages/page1') return json({ id: 'page1', url: 'https://notion.so/page1' })
        if (url.startsWith('/v1/blocks/page1/children') && request.method === 'GET') {
          return json({ results: [{ id: 'block1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: '页面正文' }] } }] })
        }
        if (url.startsWith('/v1/blocks/page1/children') && request.method === 'PATCH') {
          lastPost = await body(request)
          return json({ results: [{ id: 'block2' }] })
        }
        if (url.startsWith('/conversations.list')) return json({ ok: true, channels: [{ id: 'C1', name: 'general', is_private: false }] })
        if (url.startsWith('/conversations.history')) return json({ ok: true, messages: [{ ts: '1', user: 'U1', text: 'hello slack' }] })
        if (url === '/chat.postMessage') {
          lastPost = await body(request)
          return json({ ok: true, ts: '2' })
        }
        if (url.startsWith('/tweets/search/recent')) return json({ data: [{ id: 't1', text: 'hello x', created_at: '2026-11-06T00:00:00Z', author_id: '9' }] })
        if (url.startsWith('/users/by/username/test')) return json({ data: { id: '9', username: 'test', name: 'Test', description: 'profile' } })
        if (url.startsWith('/users/9/tweets')) return json({ data: [{ id: 't2', text: 'tweet two', created_at: '2026-11-06T00:00:00Z', author_id: '9' }] })
        if (url === '/x/web-interface/nav') {
          return json({ code: 0, data: { wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
          } } })
        }
        if (url.startsWith('/x/web-interface/wbi/search/type')) {
          lastPost = url
          return json({ code: 0, data: { result: [{ bvid: 'BV1xx411c7mD', title: '<em>测试</em>视频', author: 'up', play: 10, description: 'desc' }] } })
        }
        if (url.startsWith('/x/web-interface/view')) {
          return json({ code: 0, data: { aid: 123, bvid: 'BV1xx411c7mD', title: '视频', owner: { name: 'up' }, desc: '简介', stat: { view: 10 } } })
        }
        if (url.startsWith('/x/v2/reply/add')) {
          lastPost = await body(request)
          return json({ code: 0, data: { rpid: 999 } })
        }
        if (url.startsWith('/x/v2/reply')) {
          return json({ code: 0, data: { replies: [{ rpid: 1, member: { uname: 'u' }, content: { message: 'hi' }, like: 2 }] } })
        }
        response.writeHead(404)
        response.end()
      })().catch(() => {
        response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture 未启动')
    base = `http://127.0.0.1:${address.port}`
    notion = new NotionConnector({ token: 'notion-token', baseUrl: base })
    slack = new SlackConnector({ token: 'slack-token', baseUrl: base })
    x = new XConnector({ token: 'x-token', baseUrl: base })
    bilibili = new BilibiliConnector({ cookie: 'SESSDATA=session; bili_jct=csrf', baseUrl: base })
  })

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
  })

  it('Notion 读取、追加动作和回执', async () => {
    expect(await notion.read('search', { query: '会议' })).toEqual([{
      id: 'page1', object: 'page', url: 'https://notion.so/page1', last_edited_time: '2026-11-06T00:00:00Z',
    }])
    expect(authorization).toBe('Bearer notion-token')
    const page = await notion.read('page', { pageId: 'page1' }) as { blocks: { text: string }[] }
    expect(page.blocks[0]!.text).toBe('页面正文')
    const draft = notion.action('append', { pageId: 'page1', text: '新内容' })
    expect(draft.kind).toBe('notion.append')
    expect(await notion.deliver({ account_id: 'notion', target_ref: draft.target, payload: draft.payload })).toBe('block2')
    expect(lastPost).toContain('新内容')
  })

  it('Slack 读取频道 / 消息并发送', async () => {
    expect(await slack.read('channels', {})).toEqual([{ id: 'C1', name: 'general', private: false }])
    expect(authorization).toBe('Bearer slack-token')
    expect(await slack.read('messages', { channel: 'C1' })).toEqual([{ ts: '1', user: 'U1', text: 'hello slack' }])
    const draft = slack.action('post', { channel: 'C1', text: '发送内容' })
    expect(await slack.deliver({ account_id: 'slack', target_ref: draft.target, payload: draft.payload })).toBe('2')
    expect(JSON.parse(lastPost)).toEqual({ channel: 'C1', text: '发送内容' })
  })

  it('X 只读搜索和用户时间线', async () => {
    expect(await x.read('search', { query: 'waterbot' })).toEqual([{
      id: 't1', text: 'hello x', created_at: '2026-11-06T00:00:00Z', author_id: '9',
    }])
    const user = await x.read('user', { username: 'test' }) as { username: string; tweets: { id: string }[] }
    expect(user.username).toBe('test')
    expect(user.tweets[0]!.id).toBe('t2')
    expect(authorization).toBe('Bearer x-token')
  })

  it('B站搜索使用 WBI 签名，读取视频和评论，评论动作带回执', async () => {
    const result = await bilibili.read('search', { keyword: '测试' }) as { title: string }[]
    expect(result[0]!.title).toBe('测试视频')
    expect(lastPost).toContain('w_rid=')
    expect(lastPost).toContain('wts=')
    const video = await bilibili.read('video', { bvid: 'BV1xx411c7mD' }) as { aid: number; title: string }
    expect(video.aid).toBe(123)
    const comments = await bilibili.read('comments', { bvid: 'BV1xx411c7mD' }) as { message: string }[]
    expect(comments[0]!.message).toBe('hi')
    const draft = bilibili.action('comment', { bvid: 'BV1xx411c7mD', text: '评论内容' })
    expect(await bilibili.deliver({ account_id: 'bilibili', target_ref: draft.target, payload: draft.payload })).toBe('999')
    expect(lastPost).toContain('csrf=csrf')
    expect(lastPost).toContain('message=%E8%AF%84%E8%AE%BA%E5%86%85%E5%AE%B9')
  })

  it('WBI 签名稳定且包含 w_rid', () => {
    const query = signWbi({ keyword: '测试', page: 1 }, '0123456789abcdef0123456789abcdef', 1_700_000_000_000)
    expect(query).toContain('wts=1700000000')
    expect(query).toMatch(/w_rid=[a-f0-9]{32}$/)
  })

  it('日历 ICS 可以重新解析，邮箱动作校验收件人', () => {
    const ics = buildEventIcal({
      uid: 'event-1', summary: '项目会议', start: '2026-11-06T01:00:00Z',
      end: '2026-11-06T02:00:00Z', description: '讨论;预算,下一步',
    })
    const component = new ICAL.Component(ICAL.parse(ics))
    const vevent = component.getFirstSubcomponent('vevent')
    if (!vevent) throw new Error('ICS 没有 VEVENT')
    const event = new ICAL.Event(vevent)
    expect(event.summary).toBe('项目会议')
    expect(event.description).toBe('讨论;预算,下一步')

    const config = loadEmailConfig({
      IMAP_HOST: 'imap.example.com', IMAP_USER: 'owner@example.com', IMAP_PASSWORD: 'secret',
      SMTP_HOST: 'smtp.example.com', SMTP_USER: 'owner@example.com', SMTP_PASSWORD: 'secret', SMTP_FROM: 'owner@example.com',
    })
    const email = new EmailConnector(config)
    expect(email.status().configured).toBe(true)
    expect(email.action('send', { to: 'friend@example.com', subject: '标题', text: '正文' }).target)
      .toBe('email:friend@example.com')
    expect(() => email.action('send', { to: 'bad', subject: '标题', text: '正文' })).toThrow('收件人')
    expect(() => loadEmailConfig({ IMAP_HOST: 'imap.example.com' })).toThrow('必须同时设置')
  })

  it('注册表汇总状态并拒绝未知连接器', async () => {
    const registry = new Connectors([notion, slack, x, bilibili, new CaldavConnector({})])
    expect(registry.statuses().map((item) => item.provider)).toEqual(['notion', 'slack', 'x', 'bilibili', 'caldav'])
    expect(registry.supports('slack')).toBe(true)
    expect(registry.supports('x')).toBe(false)
    await expect(registry.read('missing', 'read', {})).rejects.toThrow('不存在')
  })
})
