import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { ExecutionService } from './execution'

const worker = fileURLToPath(new URL('./execution-worker.mjs', import.meta.url))

describe('独立执行 worker 与产物（真实子进程 / PostgreSQL）', () => {
  let db: TestDatabase
  let dir: string
  let service: ExecutionService
  let profile: string

  const waitFor = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'wb-exec-'))
    profile = '11111111-1111-4111-8111-111111111111'
    await db.pool.query('insert into profile(id,name,instructions) values ($1,$2,$3)', [profile, '执行测试', '测试'])
    service = new ExecutionService(db.pool, dir, worker)
    await service.start()
  })

  afterAll(async () => {
    await service?.close()
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('执行命令、返回输出并索引产物', async () => {
    const task = await service.submit(profile, `node -e "require('fs').writeFileSync('out.txt','hello'); console.log('ok')"`)
    await waitFor(async () => (await service.get(task.id)).status === 'done', '执行完成')
    const done = await service.get(task.id)
    expect(done.output).toContain('ok')
    expect(done.exit_code).toBe(0)
    const artifacts = await service.artifacts(task.id)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ name: 'out.txt', mime: 'text/plain', size: '5' })
    const download = await service.downloadPath(artifacts[0]!.id)
    expect(download.path.startsWith(dir)).toBe(true)
  })

  it('取消运行中的任务，结果标记 cancelled', async () => {
    const task = await service.submit(profile, `node -e "setTimeout(()=>{},60000)"`)
    await waitFor(async () => (await service.get(task.id)).status === 'running', '任务运行中')
    const cancelled = await service.cancel(task.id)
    expect(cancelled.status).toBe('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await service.get(task.id)).status).toBe('cancelled')
  })

  it('重启时把遗留 running 任务标记失败', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    await db.pool.query(
      `insert into execution_task(id, profile_id, status, command, workspace, started_at)
       values ($1,$2,'running','x',$3,clock_timestamp())`, [id, profile, join(dir, id)],
    )
    await service.start()
    expect((await service.get(id)).status).toBe('failed')
  })
})
