import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { listAppliedMigrations, runMigrations } from '../pg/migrate'
import { createTestDatabase, type TestDatabase } from '../../test/integration/database'

describe('真实 PostgreSQL 迁移', () => {
  let db: TestDatabase
  let dir: string

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-migrations-'))
    await writeFile(join(dir, '0001_alpha.sql'), 'create table alpha (id int primary key);\n', 'utf8')
    await writeFile(join(dir, '0002_beta.sql'), 'create table beta (id int primary key);\n', 'utf8')

    // 这个文件测迁移机制本身，先清空仓库迁移留下的表
    await db.pool.query(
      'drop schema public cascade; create schema public',
    )
  })

  afterAll(async () => {
    await db.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('按顺序应用并在重复运行时跳过', async () => {
    const first = await runMigrations(db.pool, dir)
    expect(first.applied).toEqual(['0001_alpha', '0002_beta'])
    expect(first.skipped).toEqual([])

    const second = await runMigrations(db.pool, dir)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(['0001_alpha', '0002_beta'])

    const rows = await db.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    )
    expect(rows.rows.map((row) => row.table_name)).toEqual([
      'alpha',
      'beta',
      'schema_migrations',
    ])
    expect(await listAppliedMigrations(db.pool)).toHaveLength(2)
  })

  it('失败的迁移整条回滚，不留半张表也不记账', async () => {
    await db.pool.query('drop table if exists schema_migrations')
    await db.pool.query('drop table if exists alpha, beta')

    await writeFile(
      join(dir, '0003_broken.sql'),
      'create table gamma (id int primary key);\nselect * from missing_table;\n',
      'utf8',
    )

    await expect(runMigrations(db.pool, dir)).rejects.toThrow()

    const tables = await db.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    )
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'alpha',
      'beta',
      'schema_migrations',
    ])

    const applied = await listAppliedMigrations(db.pool)
    expect(applied.map((row) => row.version)).toEqual(['0001_alpha', '0002_beta'])
  })

  it('已应用的迁移被改写时报错而不是静默跳过', async () => {
    await writeFile(join(dir, '0002_beta.sql'), 'create table beta (id int);\n', 'utf8')

    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/校验和不一致/)
  })
})
