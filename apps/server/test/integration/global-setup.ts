import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import type { TestProject } from 'vitest/node'

import { PROJECT_ROOT } from '../../src/paths'
import {
  buildConnectionString,
  initCluster,
  startCluster,
  stopCluster,
} from '../../src/pg/cluster'

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (typeof address !== 'object' || address === null) {
        reject(new Error('无法探测空闲端口'))
        return
      }
      const { port } = address
      probe.close(() => resolvePort(port))
    })
  })
}

/**
 * 集成测试的数据库来源，三选一，缺一不可用：
 * 1. TEST_DATABASE_URL：外部提供的真实 PostgreSQL（Linux / CI 常用）；
 * 2. PG_BIN：指向本机 initdb / pg_ctl 所在目录，由本测试自建临时集群；
 * 3. Windows 上的 @embedded-postgres/windows-x64 可选依赖。
 *
 * 任何一步失败都会清理已启动的集群与临时目录，不会留下进程或数据目录。
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const provided = process.env.TEST_DATABASE_URL?.trim()
  if (provided) {
    project.provide('pgAdminUrl', provided)
    return async () => undefined
  }

  const base = join(PROJECT_ROOT, 'apps/server/data')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'pg-it-'))
  const dataDir = join(root, 'data')

  try {
    const port = await freePort()
    const password = await initCluster({
      dataDir,
      port,
      passwordFile: join(root, 'password'),
    })
    await startCluster({ dataDir, port, logFile: join(root, 'postgres.log') })
    project.provide(
      'pgAdminUrl',
      buildConnectionString({ user: 'postgres', password, port, database: 'postgres' }),
    )
  } catch (error) {
    await stopCluster(dataDir).catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  return async () => {
    await stopCluster(dataDir)
    await rm(root, { recursive: true, force: true })
  }
}
