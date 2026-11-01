import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../../test/integration/database'
import {
  killAllProcs,
  startProc,
  waitForFile,
  waitForOutput,
  type ProcHandle,
} from '../../test/helpers/proc'
import { openRuntime } from './runtime'

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SERVER_ENTRY = join(SERVER_ROOT, 'src/index.ts')
const FIXTURE = join(SERVER_ROOT, 'test/fixtures/crash-child.ts')

/** 与生产 note_file 同形；只用于重开数据库读取 transcript，不会执行。 */
const noteTool = defineTool({
  name: 'note_file',
  description: 'Append one line to the local notes file. Has a real local side effect.',
  parameters: Type.Object({ text: Type.String() }),
  replay: 'unsafe',
  execute: async () => ({ output: [{ type: 'text', text: 'note-appended' }] }),
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function countLines(text: string): number {
  return text.split('\n').filter((line) => line.length > 0).length
}

/** 造一个“工具已执行、回执未落库”的遗留数据库。 */
async function prepareInterruptedWork(dir: string): Promise<void> {
  const child: ProcHandle = startProc({
    entry: FIXTURE,
    cwd: SERVER_ROOT,
    env: {
      PA_CHILD_MODE: 'unsafe',
      PA_CHILD_PHASE: 'first',
      PA_CHILD_DB: join(dir, 'runtime.sqlite'),
      PA_CHILD_DIR: dir,
    },
  })

  await waitForFile(join(dir, 'started.marker'))
  await waitForFile(join(dir, 'submission.json'))
  await child.kill()
}

describe('真实 server 启动恢复与失败清理（真实 PostgreSQL + SQLite）', () => {
  let db: TestDatabase
  let dir = ''

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
  })

  afterEach(async () => {
    await killAllProcs()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  afterAll(async () => {
    await db.dispose()
  })

  it('启动时主动恢复上次遗留工作：不重放 unsafe 工具，回执标记中断', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-server-'))
    const databasePath = join(dir, 'runtime.sqlite')
    const notesDirectory = join(dir, 'notes')
    await prepareInterruptedWork(dir)
    expect(countLines(await readFile(join(dir, 'effects.log'), 'utf8'))).toBe(1)

    const server = startProc({
      entry: SERVER_ENTRY,
      cwd: SERVER_ROOT,
      env: {
        HOST: '127.0.0.1',
        PORT: '0',
        DATABASE_URL: db.url,
        RUNTIME_SQLITE_PATH: databasePath,
        RUNTIME_NOTES_DIR: notesDirectory,
      },
    })

    await waitForOutput(server, /postgres ready/, 60_000)
    await waitForOutput(server, /runtime resumed/, 60_000)
    await waitForOutput(server, /runtime recovery settled/, 60_000)

    // Windows 无法向控制台子进程投递 SIGTERM，这里强杀；
    // 优雅关闭语义由 runtime 单测与“启动失败清理”用例覆盖。
    await server.kill()

    // 恢复过程没有重放 unsafe 工具：生产 note_file 的写入目录始终没有文件
    expect(await exists(join(notesDirectory, 'notes.log'))).toBe(false)
    expect(countLines(await readFile(join(dir, 'effects.log'), 'utf8'))).toBe(1)

    // 重开同一库确认回执：一个输入、一个中断的工具结果
    const runtime = await openRuntime({
      databasePath,
      tools: [noteTool],
    })

    try {
      const view = await runtime.conversation.context(BACKGROUND_CONTEXT)
      const kinds = view.entries.map((entry) => entry.kind)
      expect(kinds.filter((kind) => kind === 'pi.user')).toHaveLength(1)

      const results = view.entries.filter((entry) => entry.kind === 'pi.tool-result')
      expect(results).toHaveLength(1)

      const message = results[0]?.model?.[0] as
        | { isError?: boolean; content?: readonly { text?: string }[] }
        | undefined
      expect(message?.isError).toBe(true)
      expect(JSON.stringify(results[0]?.data)).toContain('interrupted')
    } finally {
      await runtime.close()
    }
  }, 180_000)

  it('端口被占用时退出非零，并关闭已打开的 Harness / SQLite / PG 连接', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-server-'))
    const databasePath = join(dir, 'runtime.sqlite')
    const notesDirectory = join(dir, 'notes')

    const blocker = createServer()
    await new Promise<void>((ready, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => ready())
    })
    const address = blocker.address()
    if (typeof address !== 'object' || address === null) {
      throw new Error('blocker 未拿到端口')
    }

    try {
      const server = startProc({
        entry: SERVER_ENTRY,
        cwd: SERVER_ROOT,
        env: {
          HOST: '127.0.0.1',
          PORT: String(address.port),
          DATABASE_URL: db.url,
          RUNTIME_SQLITE_PATH: databasePath,
          RUNTIME_NOTES_DIR: notesDirectory,
        },
      })

      const code = await server.waitForExit(60_000)

      expect(code, server.output()).toBe(1)
      expect(server.output()).toContain('已被占用')
      expect(server.output()).toContain('runtime and postgres closed after failed start')
      expect(await exists(`${databasePath}-wal`)).toBe(false)
      expect(await exists(`${databasePath}-shm`)).toBe(false)

      // PG 连接已释放：这条库上没有其它后端
      const deadline = Date.now() + 10_000
      for (;;) {
        const { rows } = await db.pool.query<{ count: string }>(
          'select count(*)::text as count from pg_stat_activity where datname = current_database()',
        )
        if (rows[0]?.count === '1') {
          break
        }
        if (Date.now() > deadline) {
          throw new Error(`失败的 server 仍占用 PG 连接：${rows[0]?.count}`)
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      }

      // 数据库没有被失败的进程占住：可以正常再次打开并关闭
      const runtime = await openRuntime({ databasePath, tools: [noteTool] })
      await runtime.close()
    } finally {
      await new Promise<void>((closed) => blocker.close(() => closed()))
    }
  }, 180_000)
})
