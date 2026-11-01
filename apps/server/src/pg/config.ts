import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { buildConnectionString } from './cluster'
import { readDevClusterInfo, DEV_PASSWORD_FILE } from './dev-cluster'

export interface DatabaseConfig {
  connectionString: string
  /** 可安全打印的地址（去掉密码） */
  description: string
}

function redact(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    url.password = ''
    return `${url.protocol}//${url.username}@${url.host}${url.pathname}`
  } catch {
    return 'postgres://<invalid>'
  }
}

/**
 * 连接配置优先级：DATABASE_URL > 本项目开发集群（密码文件）。
 * 不会去猜系统 PostgreSQL，也不会连接来路不明的库。
 */
export async function resolveDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseConfig> {
  const fromEnv = env.DATABASE_URL?.trim()
  if (fromEnv) {
    return { connectionString: fromEnv, description: redact(fromEnv) }
  }

  const info = await readDevClusterInfo()
  if (info && existsSync(DEV_PASSWORD_FILE)) {
    const password = (await readFile(DEV_PASSWORD_FILE, 'utf8')).trim()
    const connectionString = buildConnectionString({
      user: info.user,
      password,
      port: info.port,
      database: info.database,
      host: info.host,
    })
    return { connectionString, description: redact(connectionString) }
  }

  throw new Error(
    '没有可用的 PostgreSQL 配置：请设置 DATABASE_URL，或先执行 npm run pg:start 启动本项目开发库',
  )
}
