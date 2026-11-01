import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Actions } from '../../src/actions'
import { createPool } from '../../src/pg/connection'

const url = process.env.PA_PG_URL
const dir = process.env.PA_ACTION_DIR
const id = process.env.PA_ACTION_ID
if (!url || !dir || !id) throw new Error('缺少测试参数')
const pool = createPool(url, 1)
const actions = new Actions(pool, async () => {
  await appendFile(join(dir, 'effects.log'), 'sent\n')
  await writeFile(join(dir, 'sent.marker'), 'ready')
  await new Promise<never>(() => undefined)
  return 'unreachable'
})
await actions.execute(id)
await pool.end()
