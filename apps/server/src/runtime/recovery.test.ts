import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  killAllProcs,
  startProc,
  waitForFile,
  type ProcHandle,
} from '../../test/helpers/proc'

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE = join(SERVER_ROOT, 'test/fixtures/crash-child.ts')

type SecondPhaseResult = {
  status: string
  entries: {
    kind: string
    diagnostics: unknown
    model: readonly { isError?: boolean; content?: readonly { text?: string }[] }[] | null
  }[]
}

function countLines(text: string): number {
  return text.split('\n').filter((line) => line.length > 0).length
}

function toolResults(result: SecondPhaseResult) {
  return result.entries.filter((entry) => entry.kind === 'pi.tool-result')
}

describe('进程中断恢复（独立子进程 + 受控同步点）', () => {
  let dir = ''
  let running: ProcHandle | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-recovery-'))
  })

  afterEach(async () => {
    await killAllProcs()
    running = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('replay safe 工具：重启后重跑，但已提交检查点与幂等副作用不重复', async () => {
    running = startProc({
      entry: FIXTURE,
      cwd: SERVER_ROOT,
      env: {
        PA_CHILD_MODE: 'safe',
        PA_CHILD_PHASE: 'first',
        PA_CHILD_DB: join(dir, 'runtime.sqlite'),
        PA_CHILD_DIR: dir,
      },
    })

    // 副作用已写入、工具已挂起，此时提交尚未结算 → 正是中断窗口
    await waitForFile(join(dir, 'started.marker'))
    await waitForFile(join(dir, 'submission.json'))
    await running.kill()
    running = undefined

    const second = startProc({
      entry: FIXTURE,
      cwd: SERVER_ROOT,
      env: {
        PA_CHILD_MODE: 'safe',
        PA_CHILD_PHASE: 'second',
        PA_CHILD_DB: join(dir, 'runtime.sqlite'),
        PA_CHILD_DIR: dir,
      },
    })
    const code = await second.waitForExit()
    expect(code, second.output()).toBe(0)

    const result = JSON.parse(
      await readFile(join(dir, 'second.json'), 'utf8'),
    ) as SecondPhaseResult

    expect(result.status).toBe('done')
    // 工具确实重跑了一次（探针 2 行），但建模效果仍是 1 次
    expect(countLines(await readFile(join(dir, 'runs.log'), 'utf8'))).toBe(2)
    expect(countLines(await readFile(join(dir, 'effects.log'), 'utf8'))).toBe(1)
    expect(await readFile(join(dir, 'safe-note.txt'), 'utf8')).toBe('note:hello\n')

    // 检查点复用：输入与工具调用只出现一次，结果只写一条，答案是最后一条
    expect(result.entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
    expect(result.entries.filter((entry) => entry.kind === 'pi.assistant')).toHaveLength(2)
    const results = toolResults(result)
    expect(results).toHaveLength(1)
    expect(results[0]?.model?.[0]?.isError).toBe(false)
    expect(results[0]?.model?.[0]?.content?.[0]?.text).toBe('note-stored')
  }, 120_000)

  it('replay unsafe 工具：重启后不自动重放，回执标记中断而非成功', async () => {
    running = startProc({
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
    const effectsBeforeKill = countLines(await readFile(join(dir, 'effects.log'), 'utf8'))
    expect(effectsBeforeKill).toBe(1)

    await running.kill()
    running = undefined

    const second = startProc({
      entry: FIXTURE,
      cwd: SERVER_ROOT,
      env: {
        PA_CHILD_MODE: 'unsafe',
        PA_CHILD_PHASE: 'second',
        PA_CHILD_DB: join(dir, 'runtime.sqlite'),
        PA_CHILD_DIR: dir,
      },
    })
    const code = await second.waitForExit()
    expect(code, second.output()).toBe(0)

    const result = JSON.parse(
      await readFile(join(dir, 'second.json'), 'utf8'),
    ) as SecondPhaseResult

    expect(result.status).toBe('done')
    // 没有任何第二次执行，副作用仍是 1 行
    expect(countLines(await readFile(join(dir, 'runs.log'), 'utf8'))).toBe(1)
    expect(countLines(await readFile(join(dir, 'effects.log'), 'utf8'))).toBe(1)

    const results = toolResults(result)
    expect(results).toHaveLength(1)
    expect(results[0]?.model?.[0]?.isError).toBe(true)
    expect(JSON.stringify(results[0]?.diagnostics)).toContain('interrupted')
    // 不伪称成功：回执里不能出现成功文案
    expect(results[0]?.model?.[0]?.content?.[0]?.text).not.toBe('note-stored')
  }, 120_000)
})
