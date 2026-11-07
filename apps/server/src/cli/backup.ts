import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createBackup, decryptBackup, encryptBackup, restoreBackup } from '../backup'
import { loadProjectEnvFile } from '../env'
import { resolveDatabaseConfig } from '../pg/config'
import { createPool } from '../pg/connection'

const command = process.argv[2]
const args = process.argv.slice(3)
const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

loadProjectEnvFile()
const database = await resolveDatabaseConfig()
const pool = createPool(database.connectionString, 2)
const passphrase = process.env.BACKUP_PASSPHRASE?.trim()

try {
  if (command === 'backup') {
    const out = option('--out')
    if (!out) throw new Error('用法：npm run backup -- --out backups/waterbot.wbk')
    if (!passphrase) throw new Error('需要设置 BACKUP_PASSPHRASE')
    const bundle = await createBackup(pool)
    const encrypted = encryptBackup(bundle, passphrase)
    await writeFile(resolve(out), encrypted)
    const rows = Object.values(bundle.tables).reduce((sum, values) => sum + values.length, 0)
    console.log(`[backup] wrote ${resolve(out)} tables=${Object.keys(bundle.tables).length} rows=${rows} migrations=${bundle.migrations}`)
  } else if (command === 'restore') {
    const from = option('--from')
    if (!from) throw new Error('用法：npm run restore -- --from backups/waterbot.wbk')
    if (!passphrase) throw new Error('需要设置 BACKUP_PASSPHRASE')
    const bundle = decryptBackup(await readFile(resolve(from)), passphrase)
    const result = await restoreBackup(pool, bundle)
    console.log(`[backup] restored ${resolve(from)} tables=${result.tables} rows=${result.rows}`)
  } else {
    throw new Error('用法：backup --out <file> | restore --from <file>')
  }
} finally {
  await pool.end()
}
