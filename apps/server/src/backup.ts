import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

import type { Pool } from './pg/connection'
import { withTransaction } from './pg/connection'

export interface BackupBundle {
  version: 1
  createdAt: string
  migrations: number
  tables: Record<string, unknown[]>
}

const SKIP_TABLES = new Set(['schema_migrations'])
const ALGORITHM = 'aes-256-gcm'

async function tableNames(pool: Pool): Promise<string[]> {
  return (await pool.query<{ tablename: string }>(
    `select tablename from pg_tables
      where schemaname = 'public' and tablename <> 'schema_migrations'
      order by tablename`,
  )).rows.map((row) => row.tablename)
}

function quote(table: string): string {
  return `"${table.replaceAll('"', '""')}"`
}

/** 逻辑备份：逐表读取 JSON。只覆盖业务表，schema_migrations 保持目标库现状。 */
export async function createBackup(pool: Pool): Promise<BackupBundle> {
  const tables: Record<string, unknown[]> = {}
  for (const table of await tableNames(pool)) {
    const result = await pool.query<{ rows: unknown }>(
      `select coalesce(json_agg(t), '[]'::json) as rows from public.${quote(table)} t`,
    )
    const rows = result.rows[0]?.rows
    tables[table] = Array.isArray(rows) ? rows : typeof rows === 'string' ? JSON.parse(rows) as unknown[] : []
  }
  const migrations = Number((await pool.query<{ n: string }>('select count(*)::text as n from schema_migrations')).rows[0]!.n)
  return { version: 1, createdAt: new Date().toISOString(), migrations, tables }
}

function keyFrom(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 12) throw new Error('备份口令至少 12 个字符')
  return scryptSync(passphrase, salt, 32)
}

export function encryptBackup(bundle: BackupBundle, passphrase: string): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, keyFrom(passphrase, salt), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()])
  return Buffer.from(JSON.stringify({
    version: 1,
    algorithm: ALGORITHM,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }), 'utf8')
}

export function decryptBackup(input: Buffer, passphrase: string): BackupBundle {
  const envelope = JSON.parse(input.toString('utf8')) as {
    version?: unknown; algorithm?: unknown; salt?: unknown; iv?: unknown; tag?: unknown; data?: unknown
  }
  if (envelope.version !== 1 || envelope.algorithm !== ALGORITHM) throw new Error('备份文件版本不支持')
  if (typeof envelope.salt !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
    throw new Error('备份文件格式无效')
  }
  const decipher = createDecipheriv(ALGORITHM, keyFrom(passphrase, Buffer.from(envelope.salt, 'base64')), Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
  const bundle = JSON.parse(plain.toString('utf8')) as BackupBundle
  if (bundle.version !== 1 || typeof bundle.tables !== 'object' || bundle.tables === null) throw new Error('备份内容无效')
  return bundle
}

/**
 * 恢复会清空目标库的业务表，再按 JSON 回填。需要数据库账号允许
 * session_replication_role；开发库的 postgres 账号满足。schema_migrations 不删除。
 */
export async function restoreBackup(pool: Pool, bundle: BackupBundle): Promise<{ tables: number; rows: number }> {
  const current = await tableNames(pool)
  const missing = current.filter((table) => !(table in bundle.tables))
  if (missing.length) throw new Error(`备份缺少表：${missing.join(', ')}`)
  const unknown = Object.keys(bundle.tables).filter((table) => !current.includes(table) && !SKIP_TABLES.has(table))
  if (unknown.length) throw new Error(`备份包含目标库没有的表：${unknown.join(', ')}`)
  let rows = 0
  await withTransaction(pool, async (client) => {
    await client.query(`set local session_replication_role = 'replica'`)
    for (const table of current) await client.query(`delete from public.${quote(table)}`)
    for (const table of current) {
      const values = bundle.tables[table] ?? []
      if (!values.length) continue
      await client.query(
        `insert into public.${quote(table)} select * from json_populate_recordset(null::public.${quote(table)}, $1::json)`,
        [JSON.stringify(values)],
      )
      rows += values.length
    }
  })
  return { tables: current.length, rows }
}
