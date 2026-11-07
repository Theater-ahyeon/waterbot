import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { BrowserService } from './browser'
import { ExecutionService } from './execution'

/** 只在装有 Edge 的 Windows 开发机执行；其他宿主没有验证浏览器通道。 */
const describeBrowser = process.platform === 'win32' ? describe : describe.skip

describeBrowser('浏览器工作面（真实 Edge / 本机 HTTP）', () => {
  let db: TestDatabase
  let dir: string
  let browser: BrowserService
  let execution: ExecutionService
  let fixture: Server
  let base = ''
  let profileA = ''
  let profileB = ''

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-browser-'))
    profileA = '55555555-5555-4555-8555-555555555555'
    profileB = '66666666-6666-4666-8666-666666666666'
    await db.pool.query(
      'insert into profile(id,name,instructions) values ($1,$2,$3), ($4,$5,$6)',
      [profileA, '浏览器 A', '测试', profileB, '浏览器 B', '测试'],
    )
    fixture = createServer((request, response) => {
      if (request.url === '/set-cookie') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'session=alice; Path=/' })
        response.end('<h1>cookie set</h1>')
        return
      }
      if (request.url === '/whoami') {
        const session = /session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<h1>${session ?? '无 cookie'}</h1>`)
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>浏览器测试页</title></head><body>
        <h1>浏览器测试页</h1>
        <button onclick="document.getElementById('out').textContent='已点击'">点击我</button>
        <p id="out">等待</p>
        <label>名字 <input aria-label="名字" oninput="document.getElementById('out').textContent=this.value"></label>
      </body></html>`)
    })
    await new Promise<void>((ready) => fixture.listen(0, '127.0.0.1', ready))
    const address = fixture.address()
    if (!address || typeof address === 'string') throw new Error('fixture 未启动')
    base = `http://127.0.0.1:${address.port}`
    browser = new BrowserService(db.pool, join(dir, 'profiles'), join(dir, 'shots'), {
      allowPrivate: true, channel: 'msedge', headless: true,
    })
    execution = new ExecutionService(db.pool, join(dir, 'workspaces'), join(dir, 'worker.mjs'), [join(dir, 'shots')])
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((done) => { fixture?.close(() => done()) })
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('打开页面、读取可访问树、点击、输入并截图', async () => {
    const opened = await browser.open(profileA, `${base}/`)
    expect(opened.title).toBe('浏览器测试页')
    expect(opened.aria).toContain('浏览器测试页')
    const button = opened.elements.find((element) => element.name.includes('点击我'))
    expect(button).toBeTruthy()
    const clicked = await browser.click(profileA, button!.ref)
    expect(clicked.aria).toContain('已点击')

    const input = clicked.elements.find((element) => element.name.includes('名字'))
    expect(input).toBeTruthy()
    const typed = await browser.type(profileA, input!.ref, '水母')
    expect(typed.aria).toContain('水母')

    const artifact = await browser.screenshot(profileA)
    expect(artifact.mime).toBe('image/png')
    expect((await readFile(artifact.storage_path)).subarray(0, 4).toString('hex')).toBe('89504e47')
    const download = await execution.downloadPath(artifact.id)
    expect(download.path).toBe(artifact.storage_path)
    expect((await stat(download.path)).size).toBe(Number(artifact.size))
  })

  it('不同人格的浏览器 profile 不共享 cookie', async () => {
    await browser.open(profileA, `${base}/set-cookie`)
    const a = await browser.open(profileA, `${base}/whoami`)
    expect(a.aria).toContain('alice')
    const b = await browser.open(profileB, `${base}/whoami`)
    expect(b.aria).toContain('无 cookie')
  })

  it('人工接管时阻止 agent 操作，交还后恢复', async () => {
    const leased = await browser.lease(profileA, 'human')
    expect(leased.lease_holder).toBe('human')
    await expect(browser.click(profileA, 'e1')).rejects.toThrow('人工接管')
    await expect(browser.snapshot(profileA)).rejects.toThrow('人工接管')
    await browser.lease(profileA, 'agent')
    const snapshot = await browser.snapshot(profileA)
    expect(snapshot.lease.holder).toBe('agent')
  })

  it('默认拒绝本机和私有网段', async () => {
    const guarded = new BrowserService(db.pool, join(dir, 'guarded'), join(dir, 'guarded-shots'), { channel: 'msedge' })
    await expect(guarded.open(profileA, `${base}/`)).rejects.toThrow('私有网段')
    await expect(guarded.open(profileA, 'file:///C:/Windows/win.ini')).rejects.toThrow('http 或 https')
    await guarded.close()
  })
})
