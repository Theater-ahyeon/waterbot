import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolvePgBinaries, type PgBinaries } from './binaries'

/**
 * 本地开发 / 测试用的 PostgreSQL 集群管理。
 *
 * 直接调用平台二进制（initdb / pg_ctl），不经过 embedded-postgres 包装器：
 * 包装器的 async-exit-hook 会绑定 beforeExit 并把退出码改成 0，可能吞掉测试失败。
 *
 * Windows 注意：pg_ctl start 之后 postgres 会继承父进程的 stdio 管道，
 * 用 pipe 会导致 close 事件永不触发，所以这里一律 stdio: 'ignore'，只等自身 exit。
 */

/** 本项目开发集群端口，需要时用 PG_PORT 覆盖。 */
export const DEFAULT_PG_PORT = 55434
export const DEFAULT_PG_USER = 'postgres'
export const DEV_DATABASE = 'waterbot'

export interface ClusterOptions {
  /** 集群数据目录 */
  dataDir: string
  /** 服务端口 */
  port: number
  /** 监听地址，只允许回环 */
  host?: string
  user?: string
  /** 服务日志文件 */
  logFile?: string
  /** 覆盖二进制来源（默认 PG_BIN 或平台可选依赖） */
  env?: NodeJS.ProcessEnv
}

export interface ClusterHandle extends ClusterOptions {
  password: string
}

function assertLoopback(host: string): void {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`PG 只允许监听回环地址，当前为 "${host}"`)
  }
}

function run(
  bin: string,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${bin} 超时 ${timeoutMs}ms：${stderr}`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    // 只等自身退出：后台 postgres 进程会继承管道，close 不会来
    child.once('exit', (code) => {
      clearTimeout(timer)
      // 后台 postgres 可能继承 stderr 句柄；已捕获诊断后释放管道，让 CLI 正常退出。
      child.stderr?.destroy()
      resolve({ code: code ?? -1, stderr })
    })
  })
}

async function fileExists(path: string): Promise<boolean> {
  return existsSync(path)
}

/** 生成一次密码并写入忽略路径；密码不打印、不进源码。 */
async function ensurePassword(passwordFile: string): Promise<string> {
  if (await fileExists(passwordFile)) {
    return (await readFile(passwordFile, 'utf8')).trim()
  }

  const password = randomBytes(24).toString('base64url')
  await writeFile(passwordFile, password, { encoding: 'utf8', mode: 0o600 })
  return password
}

export interface InitClusterOptions extends ClusterOptions {
  passwordFile: string
}

/** 初始化数据目录（已初始化则跳过），返回连接密码。 */
export async function initCluster(options: InitClusterOptions): Promise<string> {
  const host = options.host ?? '127.0.0.1'
  assertLoopback(host)
  const binaries = await resolvePGBinariesFor(options.env)

  await mkdir(options.dataDir, { recursive: true })
  const password = await ensurePassword(options.passwordFile)

  if (await fileExists(join(options.dataDir, 'PG_VERSION'))) {
    return password
  }

  const pwfile = join(options.dataDir, '..', '.initdb-password')
  await writeFile(pwfile, `${password}\n`, { encoding: 'utf8', mode: 0o600 })

  try {
    const result = await run(
      binaries.initdb,
      [
        '-D',
        options.dataDir,
        '-U',
        options.user ?? DEFAULT_PG_USER,
        '-E',
        'UTF8',
        '--locale=C',
        '-A',
        'scram-sha-256',
        `--pwfile=${pwfile}`,
      ],
      180_000,
    )

    if (result.code !== 0) {
      throw new Error(`initdb 失败（退出码 ${result.code}）：${result.stderr}`)
    }
  } finally {
    await rm(pwfile, { force: true })
  }

  return password
}

function resolvePGBinariesFor(env: NodeJS.ProcessEnv | undefined): Promise<PgBinaries> {
  return resolvePgBinaries(env ?? process.env)
}

export async function isClusterRunning(
  dataDir: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!(await fileExists(join(dataDir, 'postmaster.pid')))) {
    return false
  }

  const binaries = await resolvePGBinariesFor(env)
  const result = await run(binaries.pg_ctl, ['-D', dataDir, 'status'], 15_000)
  return result.code === 0
}

export async function startCluster(options: ClusterOptions): Promise<void> {
  const host = options.host ?? '127.0.0.1'
  assertLoopback(host)

  if (await isClusterRunning(options.dataDir, options.env)) {
    return
  }

  const binaries = await resolvePGBinariesFor(options.env)
  const logFile = options.logFile ?? join(options.dataDir, '..', 'postgres.log')
  const result = await run(
    binaries.pg_ctl,
    [
      '-D',
      options.dataDir,
      '-l',
      logFile,
      '-o',
      `-p ${options.port} -h ${host}`,
      '-w',
      '-t',
      '60',
      'start',
    ],
    120_000,
  )

  if (result.code !== 0) {
    throw new Error(`pg_ctl start 失败（退出码 ${result.code}）：${result.stderr}`)
  }
}

/** fast shutdown：先断开连接再停库，避免留下未清理的数据。 */
export async function stopCluster(dataDir: string, env?: NodeJS.ProcessEnv): Promise<void> {
  if (!(await isClusterRunning(dataDir, env))) {
    return
  }

  const binaries = await resolvePGBinariesFor(env)
  const result = await run(
    binaries.pg_ctl,
    ['-D', dataDir, '-m', 'fast', '-w', '-t', '60', 'stop'],
    120_000,
  )

  if (result.code !== 0) {
    throw new Error(`pg_ctl stop 失败（退出码 ${result.code}）：${result.stderr}`)
  }
}

export function buildConnectionString(options: {
  user: string
  password: string
  port: number
  database: string
  host?: string
}): string {
  const host = options.host ?? '127.0.0.1'
  const user = encodeURIComponent(options.user)
  const password = encodeURIComponent(options.password)
  return `postgres://${user}:${password}@${host}:${options.port}/${options.database}`
}

/** 打印给日志看的地址：不含密码。 */
export function describeCluster(options: { port: number; database: string; host?: string }): string {
  return `postgres://${options.host ?? '127.0.0.1'}:${options.port}/${options.database}`
}
