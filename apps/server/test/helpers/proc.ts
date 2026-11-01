import { spawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'

/**
 * 测试用子进程管理：所有子进程都登记在册，
 * 超时必须先杀掉再报错，避免残留句柄占用 SQLite。
 */

export interface ProcHandle {
  readonly child: ChildProcess
  output(): string
  waitForExit(timeoutMs?: number): Promise<number | null>
  kill(): Promise<void>
}

const tracked = new Set<ProcHandle>()

export interface StartProcOptions {
  entry: string
  cwd: string
  env?: Record<string, string>
}

export function startProc(options: StartProcOptions): ProcHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', options.entry], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let captured = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    captured += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    captured += chunk.toString()
  })

  const handle: ProcHandle = {
    child,
    output: () => captured,
    waitForExit(timeoutMs = 60_000) {
      return new Promise((resolveExit, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveExit(child.exitCode)
          return
        }

        const timer = setTimeout(() => {
          // 超时先终止，再报错：不能让失败的测试留下进程与数据库句柄
          child.kill('SIGKILL')
          reject(new Error(`子进程 ${timeoutMs}ms 未退出：\n${captured}`))
        }, timeoutMs)

        child.once('exit', (code) => {
          clearTimeout(timer)
          resolveExit(code)
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      const exited = handle.waitForExit(5_000)
      child.kill('SIGKILL')
      await exited.catch(() => undefined)
    },
  }

  tracked.add(handle)
  return handle
}

/** 在 afterEach 里调用：回收本轮所有子进程。 */
export async function killAllProcs(): Promise<void> {
  await Promise.all([...tracked].map((handle) => handle.kill()))
  tracked.clear()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 受控同步点：只等文件出现，不用固定 sleep 猜时序。 */
export async function waitForFile(path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (await exists(path)) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`等待同步文件超时：${path}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

/** 等子进程输出里出现某段文本，用于“服务已就绪 / 恢复已完成”这类同步点。 */
export async function waitForOutput(
  handle: ProcHandle,
  pattern: RegExp,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (pattern.test(handle.output())) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`等待输出超时 ${pattern}：\n${handle.output()}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}
