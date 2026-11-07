import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { HttpError } from './http'
import type { Pool } from './pg/connection'

export interface ExecutionTask {
  id: string
  profile_id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  command: string
  workspace: string
  output: string | null
  exit_code: number | null
  error: string | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

export interface Artifact {
  id: string
  profile_id: string
  execution_id: string | null
  name: string
  relative_path: string
  mime: string
  size: string
  sha256: string
  storage_path: string | null
  created_at: Date
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

const CANCELLED = '任务已取消'
const MAX_FILES = 50

export class ExecutionService {
  private readonly children = new Map<string, ReturnType<typeof spawn>>()

  constructor(
    private readonly pool: Pool,
    private readonly workspaceRoot: string,
    private readonly workerPath: string,
    /** 文档生成等受控产物目录；下载校验只允许这些根目录。 */
    private readonly extraArtifactRoots: readonly string[] = [],
  ) {}

  async start(): Promise<void> {
    await this.pool.query(
      `update execution_task set status = 'failed', error = '进程中断，任务需要重新提交', finished_at = clock_timestamp()
        where status in ('queued', 'running')`,
    )
  }

  async submit(profileId: string, command: string, timeoutMs = 60_000): Promise<ExecutionTask> {
    const text = command.trim()
    if (!text || text.length > 4000) throw new HttpError(400, '命令长度必须在 1—4000 字之间')
    if (!(await this.pool.query('select 1 from profile where id = $1', [profileId])).rowCount) throw new HttpError(404, '人格不存在')
    const id = randomUUID()
    const workspace = join(this.workspaceRoot, id)
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'spec.json'), JSON.stringify({
      command: text, cwd: workspace, timeoutMs: Math.max(1_000, Math.min(timeoutMs, 10 * 60_000)),
    }), 'utf8')
    const task = (await this.pool.query<ExecutionTask>(
      `insert into execution_task(id, profile_id, status, command, workspace, started_at)
       values ($1,$2,'running',$3,$4,clock_timestamp()) returning *`,
      [id, profileId, text, workspace],
    )).rows[0]!
    const child = spawn(process.execPath, [this.workerPath, join(workspace, 'spec.json')], {
      cwd: workspace,
      windowsHide: true,
      stdio: 'ignore',
      env: workerEnv(),
    })
    this.children.set(id, child)
    child.once('close', () => {
      this.children.delete(id)
      void this.finish(id).catch((error: unknown) => {
        console.error('[execution] 结算失败:', error instanceof Error ? error.message : String(error))
      })
    })
    child.once('error', () => {
      this.children.delete(id)
      void this.pool.query(
        `update execution_task set status = 'failed', error = 'worker 启动失败', finished_at = clock_timestamp() where id = $1`,
        [id],
      )
    })
    return task
  }

  private async finish(id: string): Promise<void> {
    const resultPath = join(this.workspaceRoot, id, 'result.json')
    let raw: { exitCode?: number | null; output?: string } | undefined
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        raw = JSON.parse(await readFile(resultPath, 'utf8')) as { exitCode?: number | null; output?: string }
        break
      } catch {
        await new Promise((done) => setTimeout(done, 50))
      }
    }
    const task = (await this.pool.query<ExecutionTask>('select * from execution_task where id = $1', [id])).rows[0]
    if (!task || task.status === 'cancelled') return
    if (!raw) {
      await this.pool.query(
        `update execution_task set status = 'failed', error = 'worker 没有返回结果', finished_at = clock_timestamp() where id = $1`, [id],
      )
      return
    }
    await this.indexArtifacts(task)
    const failed = raw.exitCode !== 0
    await this.pool.query(
      `update execution_task set status = $2, output = $3, exit_code = $4, error = $5, finished_at = clock_timestamp()
        where id = $1`,
      [id, failed ? 'failed' : 'done', (raw.output ?? '').slice(0, 20_000), raw.exitCode ?? null, failed ? `退出码 ${String(raw.exitCode)}` : null],
    )
  }

  private async indexArtifacts(task: ExecutionTask): Promise<void> {
    const rows: { name: string; relative_path: string; mime: string; size: string; sha256: string }[] = []
    const walk = async (directory: string): Promise<void> => {
      if (rows.length >= MAX_FILES) return
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (rows.length >= MAX_FILES) return
        const full = join(directory, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.isFile() || entry.name === 'spec.json' || entry.name === 'result.json') continue
        const info = await stat(full)
        if (info.size > 10 * 1024 * 1024) continue
        const data = await readFile(full)
        const relativePath = relative(task.workspace, full)
        rows.push({
          name: entry.name,
          relative_path: relativePath,
          mime: MIME[relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream',
          size: String(info.size),
          sha256: createHash('sha256').update(data).digest('hex'),
        })
      }
    }
    await walk(task.workspace)
    for (const row of rows) {
      await this.pool.query(
        `insert into artifact(id, profile_id, execution_id, name, relative_path, mime, size, sha256)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), task.profile_id, task.id, row.name, row.relative_path, row.mime, row.size, row.sha256],
      )
    }
  }

  async list(profileId: string): Promise<ExecutionTask[]> {
    return (await this.pool.query<ExecutionTask>(
      'select * from execution_task where profile_id = $1 order by created_at desc limit 100', [profileId],
    )).rows
  }

  async get(id: string): Promise<ExecutionTask> {
    const task = (await this.pool.query<ExecutionTask>('select * from execution_task where id = $1', [id])).rows[0]
    if (!task) throw new HttpError(404, '执行任务不存在')
    return task
  }

  async artifacts(executionId: string): Promise<Artifact[]> {
    return (await this.pool.query<Artifact>('select * from artifact where execution_id = $1 order by created_at', [executionId])).rows
  }

  async downloadPath(id: string): Promise<{ path: string; artifact: Artifact }> {
    const artifact = (await this.pool.query<Artifact>('select * from artifact where id = $1', [id])).rows[0]
    if (!artifact) throw new HttpError(404, '产物不存在')
    if (artifact.storage_path) {
      const path = resolve(artifact.storage_path)
      const roots = [resolve(this.workspaceRoot), ...this.extraArtifactRoots.map((root) => resolve(root))]
      if (!roots.some((root) => path.startsWith(root + sep))) throw new HttpError(400, '产物路径越界')
      return { path, artifact }
    }
    if (!artifact.execution_id) throw new HttpError(404, '产物没有可下载文件')
    const task = await this.get(artifact.execution_id)
    const path = resolve(task.workspace, artifact.relative_path)
    if (!path.startsWith(resolve(task.workspace) + sep)) throw new HttpError(400, '产物路径越界')
    return { path, artifact }
  }

  async cancel(id: string): Promise<ExecutionTask> {
    const task = await this.get(id)
    if (['done', 'failed', 'cancelled'].includes(task.status)) return task
    const child = this.children.get(id)
    if (child?.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
    }
    return (await this.pool.query<ExecutionTask>(
      `update execution_task set status = 'cancelled', error = $2, finished_at = clock_timestamp() where id = $1 returning *`,
      [id, CANCELLED],
    )).rows[0]!
  }

  async close(): Promise<void> {
    for (const [id, child] of this.children) {
      if (child.pid) {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill('SIGKILL')
      }
      this.children.delete(id)
    }
  }
}

function workerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['DATABASE_URL', 'PGPASSWORD', 'PGUSER', 'PGHOST', 'PGPORT', 'BACKUP_PASSPHRASE', 'OPENAI_API_KEY', 'ONEBOT_ACCESS_TOKEN']) {
    delete env[key]
  }
  return env
}
