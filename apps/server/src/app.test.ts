import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from './app'
import { loadConfig } from './config'
import { buildHealthPayload, SERVICE_NAME, SERVICE_VERSION } from './health'

const packageJsonUrl = new URL('../package.json', import.meta.url)

describe('buildHealthPayload', () => {
  it('按毫秒差计算运行时长并输出 ISO 时间', () => {
    const payload = buildHealthPayload({
      startedAt: new Date('2026-10-28T12:00:00.000Z'),
      now: new Date('2026-10-28T12:00:01.250Z'),
    })

    expect(payload.status).toBe('ok')
    expect(payload.service).toBe(SERVICE_NAME)
    expect(payload.version).toBe(SERVICE_VERSION)
    expect(payload.uptimeSeconds).toBe(1.3)
    expect(payload.checkedAt).toBe('2026-10-28T12:00:01.250Z')
  })

  it('时钟回拨时不会给出负的运行时长', () => {
    const payload = buildHealthPayload({
      startedAt: new Date('2026-10-28T12:00:05.000Z'),
      now: new Date('2026-10-28T12:00:00.000Z'),
    })

    expect(payload.uptimeSeconds).toBe(0)
  })

  it('SERVICE_VERSION 与包版本保持一致', async () => {
    const raw = await readFile(packageJsonUrl, 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }

    expect(pkg.version).toBe(SERVICE_VERSION)
  })
})

describe('loadConfig', () => {
  it('缺省时只监听本机回环地址', () => {
    expect(loadConfig({})).toEqual({ host: '127.0.0.1', port: 8787 })
  })

  it('拒绝监听非回环地址', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/回环地址/)
  })

  it('拒绝非法端口', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/)
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/)
  })
})

describe('GET /api/health', () => {
  const app = createApp({
    startedAt: new Date('2026-10-28T12:00:00.000Z'),
    now: () => new Date('2026-10-28T12:00:02.500Z'),
  })

  let baseUrl = ''

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      app.once('error', reject)
      app.listen(0, '127.0.0.1', () => resolve())
    })

    const address = app.address()
    if (typeof address !== 'object' || address === null) {
      throw new Error('server 未返回监听地址')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      app.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('返回 200 与契约字段', async () => {
    const res = await fetch(`${baseUrl}/api/health`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: 2.5,
      checkedAt: '2026-10-28T12:00:02.500Z',
    })
  })

  it('非 GET 方法返回 405 与 Allow 头', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { method: 'POST' })

    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
    await expect(res.json()).resolves.toEqual({ error: 'method_not_allowed' })
  })

  it('未知路径返回 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/unknown`)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'not_found' })
  })
})

/** 用原始 TCP 连接发送指定请求行，才能覆盖 fetch 无法构造的畸形 URL。 */
function rawRequest(
  port: number,
  requestLine: string,
): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })

    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      raw += chunk
    })
    socket.on('error', reject)
    socket.on('end', () => {
      const [head = '', ...rest] = raw.split('\r\n\r\n')
      resolve({
        statusLine: head.split('\r\n')[0] ?? '',
        body: rest.join('\r\n\r\n'),
      })
    })
  })
}

describe('畸形请求行', () => {
  const app = createApp()
  let port = 0

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      app.once('error', reject)
      app.listen(0, '127.0.0.1', () => resolve())
    })

    const address = app.address()
    if (typeof address !== 'object' || address === null) {
      throw new Error('server 未返回监听地址')
    }
    port = address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      app.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('absolute-form 的非法 URL 返回 400，且进程不崩、后续请求仍可用', async () => {
    const bad = await rawRequest(port, 'GET http://[ HTTP/1.1')

    expect(bad.statusLine).toContain('400')
    expect(bad.body).toContain('bad_request')

    const stillAlive = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(stillAlive.status).toBe(200)
  })

  it('合法 absolute-form 仍按路径正常处理', async () => {
    const res = await rawRequest(port, 'GET http://127.0.0.1/api/health HTTP/1.1')

    expect(res.statusLine).toContain('200')
    expect(res.body).toContain('"status":"ok"')
  })
})
