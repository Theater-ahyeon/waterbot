import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { PROJECT_ROOT } from '../paths'
import {
  buildConnectionString,
  DEFAULT_PG_PORT,
  DEFAULT_PG_USER,
  DEV_DATABASE,
  initCluster,
  startCluster,
  stopCluster,
} from './cluster'
import { createPool } from './connection'

/** 开发集群全部落在忽略路径下；密码单独存文件，不进源码 / 日志。 */
export const DEV_CLUSTER_ROOT = resolve(PROJECT_ROOT, 'apps/server/data/pg')
export const DEV_CLUSTER_DATA_DIR = join(DEV_CLUSTER_ROOT, 'data')
export const DEV_PASSWORD_FILE = join(DEV_CLUSTER_ROOT, 'password')
export const DEV_CLUSTER_FILE = join(DEV_CLUSTER_ROOT, 'cluster.json')
export const DEV_LOG_FILE = join(DEV_CLUSTER_ROOT, 'postgres.log')

export interface DevClusterInfo {
  host: string
  port: number
  user: string
  database: string
}

export function devPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PG_PORT?.trim()
  if (!raw) {
    return DEFAULT_PG_PORT
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PG_PORT 必须是 1-65535 的整数，当前为 "${raw}"`)
  }
  return port
}

export async function readDevClusterInfo(): Promise<DevClusterInfo | undefined> {
  if (!existsSync(DEV_CLUSTER_FILE)) {
    return undefined
  }
  const raw = await readFile(DEV_CLUSTER_FILE, 'utf8')
  return JSON.parse(raw) as DevClusterInfo
}

async function createDatabaseIfMissing(adminUrl: string, database: string): Promise<void> {
  const pool = createPool(adminUrl, 1)
  try {
    const existing = await pool.query('select 1 from pg_database where datname = $1', [database])
    if (existing.rowCount === 0) {
      // 标识符不能参数化，这里只允许保守字符集
      if (!/^[a-z_][a-z0-9_]*$/.test(database)) {
        throw new Error(`数据库名不合法：${database}`)
      }
      await pool.query(`create database ${database}`)
    }
  } finally {
    await pool.end()
  }
}

/**
 * 确保开发集群已初始化并运行，返回可直接连接的 URL（含密码，只在内存中使用）。
 */
export async function ensureDevCluster(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string; info: DevClusterInfo }> {
  const port = devPortFromEnv(env)
  const user = DEFAULT_PG_USER
  const database = DEV_DATABASE

  await mkdir(DEV_CLUSTER_ROOT, { recursive: true })
  const password = await initCluster({
    dataDir: DEV_CLUSTER_DATA_DIR,
    port,
    passwordFile: DEV_PASSWORD_FILE,
    user,
  })

  await startCluster({ dataDir: DEV_CLUSTER_DATA_DIR, port, logFile: DEV_LOG_FILE })

  const adminUrl = buildConnectionString({ user, password, port, database: 'postgres' })
  await createDatabaseIfMissing(adminUrl, database)

  await writeFile(
    DEV_CLUSTER_FILE,
    JSON.stringify({ host: '127.0.0.1', port, user, database }, null, 2),
    'utf8',
  )

  return {
    url: buildConnectionString({ user, password, port, database }),
    info: { host: '127.0.0.1', port, user, database },
  }
}

export async function stopDevCluster(): Promise<void> {
  await stopCluster(DEV_CLUSTER_DATA_DIR)
}
