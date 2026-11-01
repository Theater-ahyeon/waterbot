// @vitest-environment node
import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createConfig,
  readProjectEnv,
  resolveServerOrigin,
  SERVER_ORIGIN_KEY,
  WEB_ROOT,
} from '../vite.config'

const STUB_SERVICE = 'proxy-target-stub'

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        reject(new Error('server 未返回监听地址'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('web 开发代理读取项目根 .env', () => {
  let envDir = ''
  let target: Server | undefined
  let targetOrigin = ''
  let vite: ViteDevServer | undefined
  let vitePort = 0
  let receivedPath = ''

  beforeAll(async () => {
    target = createHttpServer((req, res) => {
      receivedPath = req.url ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'ok',
          service: STUB_SERVICE,
          version: '0.0.0',
          uptimeSeconds: 1,
          checkedAt: new Date().toISOString(),
        }),
      )
    })

    const targetPort = await listen(target)
    targetOrigin = `http://127.0.0.1:${targetPort}`

    // 模拟项目根 .env：除代理目标外故意混入其他配置，验证不会被读取或外泄。
    envDir = await mkdtemp(join(tmpdir(), 'pa-web-env-'))
    await writeFile(
      join(envDir, '.env'),
      [
        `${SERVER_ORIGIN_KEY}=${targetOrigin}`,
        'DATABASE_URL=postgres://user:secret@127.0.0.1:5432/app',
        'API_SECRET=top-secret',
        'VITE_OTHER=should-not-be-read',
        '',
      ].join('\n'),
      'utf8',
    )

    const config = createConfig({ mode: 'development', envDir, shellEnv: {} })
    vite = await createViteServer({
      ...config,
      configFile: false,
      root: WEB_ROOT,
      logLevel: 'error',
      server: { ...config.server, port: 0 },
    })
    await vite.listen()

    const address = vite.httpServer?.address()
    if (typeof address !== 'object' || address === null) {
      throw new Error('vite 未返回监听地址')
    }
    vitePort = address.port
  }, 60_000)

  afterAll(async () => {
    await vite?.close()
    await close(target)
    if (envDir) {
      await rm(envDir, { recursive: true, force: true })
    }
  })

  it('只取 VITE_SERVER_ORIGIN，其他变量不进入返回对象', () => {
    const env = readProjectEnv({ mode: 'development', envDir })

    expect(Object.keys(env)).toEqual([SERVER_ORIGIN_KEY])
    expect(env[SERVER_ORIGIN_KEY]).toBe(targetOrigin)
  })

  it('代理目标来自 .env 的端口，进程环境优先', () => {
    expect(resolveServerOrigin({ mode: 'development', envDir, shellEnv: {} })).toBe(
      targetOrigin,
    )
    expect(
      resolveServerOrigin({
        mode: 'development',
        envDir,
        shellEnv: { [SERVER_ORIGIN_KEY]: 'http://127.0.0.1:9999' },
      }),
    ).toBe('http://127.0.0.1:9999')
  })

  it('自定义 server 端口时，/api 请求仍经代理到达目标服务', async () => {
    const res = await fetch(`http://127.0.0.1:${vitePort}/api/health`)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { service?: string }
    expect(body.service).toBe(STUB_SERVICE)
    expect(receivedPath).toBe('/api/health')
  }, 30_000)

  it('根目录 .env 不作为客户端 env 注入（envDir 仍是 apps/web）', () => {
    // Vite 内部把路径统一成 /，这里只比较归一化后的结果。
    const normalize = (value: string) => value.replace(/\\/g, '/')
    const envDir = vite?.config.envDir

    expect(typeof envDir).toBe('string')
    if (typeof envDir !== 'string') {
      throw new Error('envDir 未解析为路径')
    }

    expect(normalize(envDir)).toBe(normalize(WEB_ROOT))
    expect(vite?.config.env.VITE_OTHER).toBeUndefined()
    expect(JSON.stringify(vite?.config.env ?? {})).not.toContain('top-secret')
  })
})
