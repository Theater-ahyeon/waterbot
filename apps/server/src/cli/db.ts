import { isClusterRunning, describeCluster } from '../pg/cluster'
import { resolveDatabaseConfig } from '../pg/config'
import {
  DEV_CLUSTER_DATA_DIR,
  DEV_PASSWORD_FILE,
  ensureDevCluster,
  readDevClusterInfo,
  stopDevCluster,
} from '../pg/dev-cluster'
import { createPool } from '../pg/connection'
import { runMigrations } from '../pg/migrate'

/**
 * 本项目本地 PostgreSQL 的运维入口。
 * 只操作 apps/server/data/pg 下的自有集群，不碰系统服务或其他数据库。
 * 密码只存在忽略文件里，命令输出最多给出去掉密码的地址。
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status'

  if (command === 'start') {
    const { info } = await ensureDevCluster()
    console.log(`[db] postgres running at ${describeCluster(info)}`)
    console.log(`[db] password file: ${DEV_PASSWORD_FILE}（已忽略，未打印内容）`)
    return
  }

  if (command === 'stop') {
    await stopDevCluster()
    console.log('[db] postgres stopped')
    return
  }

  if (command === 'status') {
    const info = await readDevClusterInfo()
    if (!info) {
      console.log('[db] 尚未初始化（执行 npm run pg:start）')
      return
    }
    const running = await isClusterRunning(DEV_CLUSTER_DATA_DIR)
    console.log(`[db] ${describeCluster(info)} ${running ? 'running' : 'stopped'}`)
    return
  }

  if (command === 'migrate') {
    const config = await resolveDatabaseConfig()
    const pool = createPool(config.connectionString, 2)
    try {
      const result = await runMigrations(pool)
      console.log(
        `[db] migrate ${config.description} applied=${JSON.stringify(result.applied)} skipped=${JSON.stringify(result.skipped)}`,
      )
    } finally {
      await pool.end()
    }
    return
  }

  throw new Error(`未知命令 "${command}"，可用：start | stop | status | migrate`)
}

main().catch((error: unknown) => {
  console.error('[db] 失败:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
