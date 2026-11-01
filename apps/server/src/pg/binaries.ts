import { join } from 'node:path'

/**
 * PostgreSQL 二进制定位。
 *
 * 平台二进制只是「可选依赖」：Windows 用 @embedded-postgres/windows-x64，
 * 其他平台由使用方提供 PG_BIN（或自带 PostgreSQL 的 bin 目录），
 * 这样 `npm ci` 不会因 os/cpu 不匹配报 EBADPLATFORM，也不会静默跳过真实数据库测试。
 */
export interface PgBinaries {
  initdb: string
  pg_ctl: string
}

const EXE = process.platform === 'win32' ? '.exe' : ''

export function binariesFromDir(dir: string): PgBinaries {
  return {
    initdb: join(dir, `initdb${EXE}`),
    pg_ctl: join(dir, `pg_ctl${EXE}`),
  }
}

const EMBEDDED_PACKAGE = '@embedded-postgres/windows-x64'

export async function resolvePgBinaries(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PgBinaries> {
  const fromEnv = env.PG_BIN?.trim()
  if (fromEnv) {
    return binariesFromDir(fromEnv)
  }

  try {
    // 变量方式导入：让 TypeScript 不在编译期解析平台专属包，
    // 其他平台没有这个可选依赖也能通过 typecheck。
    const moduleName = EMBEDDED_PACKAGE
    const embedded = (await import(moduleName)) as unknown as PgBinaries
    return { initdb: embedded.initdb, pg_ctl: embedded.pg_ctl }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `找不到可用的 PostgreSQL 二进制（平台 ${process.platform}/${process.arch}）：` +
        '请设置 PG_BIN 指向 initdb、pg_ctl 所在目录，' +
        `或安装对应平台的 @embedded-postgres/<platform> 可选依赖。原始错误：${detail}`,
      { cause: error },
    )
  }
}
