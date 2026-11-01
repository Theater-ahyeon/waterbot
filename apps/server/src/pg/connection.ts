import pg from 'pg'

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient

export function createPool(connectionString: string, max = 4): Pool {
  return new pg.Pool({ connectionString, max })
}

/** 单事务执行；回调抛错即整体回滚。 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    try {
      const result = await work(client)
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback')
      throw error
    }
  } finally {
    client.release()
  }
}
