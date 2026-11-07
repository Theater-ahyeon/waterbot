import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { createBackup, decryptBackup, encryptBackup, restoreBackup } from './backup'

describe('加密逻辑备份（真实 PostgreSQL）', () => {
  let db: TestDatabase

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
  })

  afterAll(async () => {
    await db?.dispose()
  })

  it('导出、加密、解密并恢复业务表；错误口令不能解密', async () => {
    const id = randomUUID()
    await db.pool.query('insert into profile(id, name, instructions) values ($1,$2,$3)', [id, '备份测试', '测试'])
    const bundle = await createBackup(db.pool)
    expect(bundle.version).toBe(1)
    expect(bundle.tables.profile).toHaveLength(1)
    expect(bundle.tables.owner_context).toHaveLength(1)

    const encrypted = encryptBackup(bundle, 'correct horse battery')
    expect(() => decryptBackup(encrypted, 'wrong passphrase')).toThrow()
    const decrypted = decryptBackup(encrypted, 'correct horse battery')
    expect(decrypted.tables.profile).toEqual(bundle.tables.profile)

    await db.pool.query('delete from profile where id = $1', [id])
    expect((await db.pool.query('select 1 from profile where id = $1', [id])).rowCount).toBe(0)
    const restored = await restoreBackup(db.pool, decrypted)
    expect(restored.rows).toBeGreaterThan(0)
    expect((await db.pool.query('select name from profile where id = $1', [id])).rows[0].name).toBe('备份测试')
  })
})
