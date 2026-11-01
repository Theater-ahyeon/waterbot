import { randomBytes } from 'node:crypto'

import { createPool, type Pool } from '../../src/pg/connection'
import { runMigrations } from '../../src/pg/migrate'

export interface TestDatabase {
  url: string
  pool: Pool
  dispose(): Promise<void>
}

/** 每个测试文件一个独立数据库，跑完删除；建库或迁移失败也会回收连接与库。 */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `pa_it_${randomBytes(4).toString('hex')}`
  const admin = createPool(adminUrl, 1)
  let pool: Pool | undefined

  try {
    await admin.query(`create database ${name}`)

    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    const connectionString = url.toString()

    pool = createPool(connectionString, 4)
    await runMigrations(pool)

    const created = pool
    return {
      url: connectionString,
      pool: created,
      async dispose() {
        await created.end()
        await admin.query(`drop database if exists ${name} with (force)`)
        await admin.end()
      },
    }
  } catch (error) {
    await pool?.end().catch(() => undefined)
    await admin.query(`drop database if exists ${name} with (force)`).catch(() => undefined)
    await admin.end().catch(() => undefined)
    throw error
  }
}
