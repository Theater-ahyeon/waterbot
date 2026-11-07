import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension } from '@earendil-works/pi-durable'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { createApp } from './app'
import { OwnerAuth } from './auth'
import { Chats } from './chat'
import { Documents } from './documents'
import { ExecutionService } from './execution'
import { createPageTool, Pages } from './pages'
import { Profiles, type Profile } from './profiles'
import { createEchoTool, openRuntime, type AgentRuntime } from './runtime'

describe('文档、Pages 与产物（真实 PG / 文件 / HTTP）', () => {
  let db: TestDatabase
  let dir: string
  let workspace: string
  let documentsRoot: string
  let runtime: AgentRuntime
  let profiles: Profiles
  let chats: Chats
  let documents: Documents
  let pages: Pages
  let execution: ExecutionService
  let server: Server
  let base = ''
  let cookie = ''
  let owner: Profile

  const request = (path: string, method = 'GET', body?: unknown, authenticated = true) => fetch(`${base}${path}`, {
    method,
    headers: { origin: base, ...(authenticated && cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-artifacts-'))
    workspace = join(dir, 'workspaces')
    documentsRoot = join(dir, 'documents')
    runtime = await openRuntime({ databasePath: join(dir, 'runtime.sqlite'), tools: [createEchoTool()], demo: true })
    const auth = await OwnerAuth.open(db.pool, join(dir, 'owner-key'))
    profiles = new Profiles(db.pool, runtime)
    await profiles.seed()
    owner = (await profiles.list())[0]!
    chats = new Chats(db.pool, runtime, profiles)
    chats.start()
    documents = new Documents(db.pool, documentsRoot)
    pages = new Pages(db.pool)
    execution = new ExecutionService(db.pool, workspace, join(dir, 'worker.mjs'), [documentsRoot])
    await execution.start()
    server = createApp({ services: { auth, profiles, chats, documents, pages, execution } })
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server 未启动')
    base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ key: (await readFile(join(dir, 'owner-key'), 'utf8')).trim() }),
    })
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')!.split(';')[0]!
  })

  afterAll(async () => {
    if (server) await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
    await chats?.close()
    await execution?.close()
    await runtime?.close()
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('生成真实 docx / xlsx / pptx，并保留连续修订', async () => {
    const docx = await documents.create(owner.id, {
      title: '季度报告',
      kind: 'docx',
      content: { sections: [{ heading: '概览', paragraphs: ['第一段内容', '第二段内容'] }] },
    })
    expect(docx.version).toBe(1)
    expect(docx.revisions).toHaveLength(1)
    const first = docx.revisions[0]!.artifact
    expect(first.mime).toContain('wordprocessingml')
    expect((await readFile(first.storage_path)).subarray(0, 2).toString()).toBe('PK')
    const docxZip = await JSZip.loadAsync(await readFile(first.storage_path))
    const docxXml = await docxZip.file('word/document.xml')!.async('string')
    expect(docxXml).toContain('季度报告')
    expect(docxXml).toContain('第一段内容')

    const revised = await documents.revise(docx.id, {
      content: { sections: [{ heading: '修订', paragraphs: ['更新后的内容'] }] },
    })
    expect(revised.version).toBe(2)
    expect(revised.revisions).toHaveLength(2)
    const second = revised.revisions[1]!.artifact
    expect(second.storage_path).not.toBe(first.storage_path)
    expect(await stat(first.storage_path)).toBeTruthy()
    const revisedXml = await (await JSZip.loadAsync(await readFile(second.storage_path))).file('word/document.xml')!.async('string')
    expect(revisedXml).toContain('更新后的内容')

    const xlsx = await documents.create(owner.id, {
      title: '数据表',
      kind: 'xlsx',
      content: { sheets: [{ name: '数据', rows: [['项目', '数量'], ['苹果', 3], ['梨', 5]] }] },
    })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(xlsx.revisions[0]!.artifact.storage_path)
    const sheet = workbook.getWorksheet('数据')!
    expect(sheet.getCell('A1').value).toBe('项目')
    expect(sheet.getCell('B2').value).toBe(3)

    const pptx = await documents.create(owner.id, {
      title: '演示稿',
      kind: 'pptx',
      content: { slides: [{ title: '本周进展', bullets: ['完成文档生成', '完成页面发布'] }] },
    })
    const pptxZip = await JSZip.loadAsync(await readFile(pptx.revisions[0]!.artifact.storage_path))
    const slideXml = await pptxZip.file('ppt/slides/slide1.xml')!.async('string')
    expect(slideXml).toContain('本周进展')
    expect(slideXml).toContain('完成页面发布')

    await expect(documents.create(owner.id, {
      title: '坏表', kind: 'xlsx', content: { sheets: [{ name: 'a/b', rows: [] }] },
    })).rejects.toThrow('不允许的字符')
  })

  it('页面版本、发布副本、撤销和会话范围', async () => {
    const page = await pages.create(owner.id, {
      title: '周报 <草稿>',
      content: {
        blocks: [
          { type: 'heading', text: '本周概览' },
          { type: 'metric', label: '完成任务', value: '7', hint: '比上周多 2 个' },
          { type: 'text', text: '<script>alert(1)</script>' },
          { type: 'table', columns: ['项目', '状态'], rows: [['文档', '完成'], ['页面', '进行中']] },
          { type: 'chart', chart: 'bar', title: '每日完成', labels: ['一', '二', '三'], values: [2, 4, 1] },
        ],
      },
    })
    expect(page.version).toBe(1)
    const updated = await pages.update(page.id, {
      expectedVersion: 1,
      content: { blocks: [{ type: 'text', text: '更新后的内容' }] },
    })
    expect(updated.version).toBe(2)
    expect(updated.revisions).toHaveLength(2)
    await expect(pages.update(page.id, { expectedVersion: 1, content: { blocks: [{ type: 'text', text: '旧版本' }] } }))
      .rejects.toThrow('已被修改')

    const published = await pages.publish(page.id)
    expect(published.path).toBe(`/api/public/pages/${published.token}`)
    const snapshot = await pages.publicPage(published.token)
    expect(snapshot.version).toBe(2)
    expect(snapshot.content.blocks[0]).toEqual({ type: 'text', text: '更新后的内容' })

    await pages.update(page.id, { expectedVersion: 2, content: { blocks: [{ type: 'text', text: '发布后的新版本' }] } })
    expect((await pages.publicPage(published.token)).content.blocks[0]).toEqual({ type: 'text', text: '更新后的内容' })
    expect(await pages.unpublish(page.id)).toBe(1)
    await expect(pages.publicPage(published.token)).rejects.toThrow('页面不存在')

    const conversationKey = `profile:${owner.id}:owner`
    await db.pool.query(
      `insert into conversation_binding(profile_id, conversation_key, pi_conversation_id, scope_kind, scope_ref, readable_groups)
       values ($1,$2,'9001','owner_private','', '{}')`, [owner.id, conversationKey],
    )
    const fromTool = await pages.updateForConversation('9001', page.id, {
      content: { blocks: [{ type: 'text', text: '由例行对话更新' }] },
    })
    expect(fromTool.version).toBe(4)
    await db.pool.query(
      `insert into conversation_binding(profile_id, conversation_key, pi_conversation_id, scope_kind, scope_ref, readable_groups)
       values ($1,$2,'9002','qq_group','onebot:1:1','{}')`, [owner.id, `profile:${owner.id}:qq_group:1`],
    )
    await expect(pages.updateForConversation('9002', page.id, { content: { blocks: [{ type: 'text', text: '越权' }] } }))
      .rejects.toThrow('只有主人私聊')
  })

  it('主人私聊的工具可以更新页面并生成新版本', async () => {
    const page = await pages.create(owner.id, {
      title: '工具更新页',
      content: { blocks: [{ type: 'text', text: '初始内容' }] },
    })
    const toolRuntime = await openRuntime({
      databasePath: join(dir, 'tool-runtime.sqlite'),
      tools: [createEchoTool()],
      responses: [
        fauxAssistantMessage([fauxToolCall('update_page', {
          pageId: page.id,
          content: { blocks: [{ type: 'text', text: '工具写入的内容' }] },
        })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('页面已经更新。'),
      ],
      extensions: [defineExtension({ name: 'test.page', tools: [createPageTool(pages)] })],
    })
    try {
      const toolProfiles = new Profiles(db.pool, toolRuntime)
      const { conversation } = await toolProfiles.conversation(owner.id, {
        suffix: 'owner_tool', scopeKind: 'owner_private', scopeRef: '', readableGroups: [],
      })
      const submission = await conversation.submit({
        type: 'input', content: '请把页面更新一下。', requestId: 'page-tool-1',
      }, BACKGROUND_CONTEXT)
      const settled = await submission.wait(BACKGROUND_CONTEXT)
      expect(settled.status).toBe('done')
    } finally {
      await toolRuntime.close()
    }
    const updated = await pages.get(page.id)
    expect(updated.version).toBe(2)
    expect(updated.content.blocks[0]).toEqual({ type: 'text', text: '工具写入的内容' })
  })

  it('HTTP 页面发布、下载和范围检查', async () => {
    const created = await request(`/api/profiles/${owner.id}/pages`, 'POST', {
      title: '发布会页面',
      content: { blocks: [{ type: 'text', text: '公开内容 <b>不能注入</b>' }] },
    })
    expect(created.status).toBe(201)
    const page = await created.json() as { id: string; version: number }
    const published = await request(`/api/pages/${page.id}/publish`, 'POST', {})
    expect(published.status).toBe(201)
    const publication = await published.json() as { token: string }
    const html = await fetch(`${base}/api/public/pages/${publication.token}`)
    expect(html.status).toBe(200)
    expect(html.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
    const body = await html.text()
    expect(body).toContain('发布会页面')
    expect(body).toContain('公开内容 &lt;b&gt;不能注入&lt;/b&gt;')
    expect(body).not.toContain('<b>不能注入</b>')
    expect((await request(`/api/pages/${page.id}/unpublish`, 'POST', {})).status).toBe(200)
    expect((await fetch(`${base}/api/public/pages/${publication.token}`)).status).toBe(404)

    const documentResponse = await request(`/api/profiles/${owner.id}/documents`, 'POST', {
      title: '接口文档',
      kind: 'docx',
      content: { sections: [{ paragraphs: ['通过 HTTP 创建'] }] },
    })
    expect(documentResponse.status).toBe(201)
    const document = await documentResponse.json() as { id: string; revisions: { artifact: { id: string; size: string } }[] }
    expect(document.revisions).toHaveLength(1)
    const download = await request(`/api/artifacts/${document.revisions[0]!.artifact.id}/download`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('wordprocessingml')
    const bytes = Buffer.from(await download.arrayBuffer())
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    expect(bytes.length).toBe(Number(document.revisions[0]!.artifact.size))

    const strayPath = join(dir, 'outside.bin')
    await writeFile(strayPath, 'stray')
    const stray = randomUUID()
    await db.pool.query(
      `insert into artifact(id, profile_id, execution_id, name, relative_path, mime, size, sha256, storage_path)
       values ($1,$2,null,'outside.bin','outside.bin','application/octet-stream',5,'x',$3)`,
      [stray, owner.id, strayPath],
    )
    await expect(execution.downloadPath(stray)).rejects.toThrow('越界')

    expect((await request(`/api/profiles/${owner.id}/documents`)).status).toBe(200)
    expect((await request(`/api/profiles/${owner.id}/pages`)).status).toBe(200)
  })
})
