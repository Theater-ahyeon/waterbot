import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import pg from 'pg'

import { PROJECT_ROOT } from '../paths'

/** 迁移文件目录：与源码同仓库，开发 / 构建产物都指向同一处。 */
export const MIGRATIONS_DIR = resolve(PROJECT_ROOT, 'apps/server/migrations')

const ADVISORY_LOCK_KEY = 4_120_401

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

export interface AppliedMigration {
  version: string
  checksum: string
  applied_at: string
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

async function listMigrations(dir: string): Promise<{ version: string; path: string }[]> {
  const entries = await readdir(dir)
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), path: join(dir, name) }))
}

/**
 * 按文件名顺序应用未执行的迁移。
 *
 * - 每个迁移在自己的事务里执行，失败整条回滚，不会留下半张表；
 * - 已应用的迁移比对校验和，被改动过就报错而不是静默跳过；
 * - 用 advisory lock 串行化，两个进程同时迁移时不会互相踩。
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const migrations = await listMigrations(dir)
  const applied: string[] = []
  const skipped: string[] = []

  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `)

    const { rows } = await client.query<AppliedMigration>(
      'select version, checksum, applied_at from schema_migrations',
    )
    const known = new Map(rows.map((row) => [row.version, row.checksum]))

    for (const migration of migrations) {
      const sql = await readFile(migration.path, 'utf8')
      const checksum = checksumOf(sql)
      const previous = known.get(migration.version)

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `迁移 ${migration.version} 已应用但内容被改动（校验和不一致），请新增迁移而不是修改历史`,
          )
        }
        skipped.push(migration.version)
        continue
      }

      await client.query('begin')
      try {
        await client.query(sql)
        await client.query(
          'insert into schema_migrations (version, checksum) values ($1, $2)',
          [migration.version, checksum],
        )
        await client.query('commit')
        applied.push(migration.version)
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    }
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
    } finally {
      client.release()
    }
  }

  return { applied, skipped }
}

export async function listAppliedMigrations(pool: pg.Pool): Promise<AppliedMigration[]> {
  const { rows } = await pool.query<AppliedMigration>(
    'select version, checksum, applied_at from schema_migrations order by version',
  )
  return rows
}
