import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { loadProjectEnvFile } from './env'
import { PROJECT_ENV_FILE, PROJECT_ROOT } from './paths'

describe('项目根与环境文件定位', () => {
  it('解析到的项目根就是本仓库根目录', async () => {
    const raw = await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { name?: string; workspaces?: string[] }

    expect(pkg.name).toBe('waterbot')
    expect(pkg.workspaces).toContain('apps/*')
  })

  it('.env 固定在项目根，不指向项目外任何目录', () => {
    expect(PROJECT_ENV_FILE).toBe(resolve(PROJECT_ROOT, '.env'))
    expect(resolve(PROJECT_ENV_FILE, '..')).toBe(PROJECT_ROOT)
  })

  it('文件不存在时返回 undefined，且不向别处查找', () => {
    const missing = join(PROJECT_ROOT, '.env.not-exists')

    expect(loadProjectEnvFile(missing)).toBeUndefined()
    expect(loadProjectEnvFile(missing)).toBeUndefined()
  })
})

describe('loadProjectEnvFile 实际加载', () => {
  let dir = ''

  afterAll(async () => {
    delete process.env.PA_ENV_TEST_KEY
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('只加载传入的那一个文件', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-env-'))
    const envFile = join(dir, '.env')
    await writeFile(envFile, 'PA_ENV_TEST_KEY=loaded\n', 'utf8')

    expect(loadProjectEnvFile(envFile)).toBe(envFile)
    expect(process.env.PA_ENV_TEST_KEY).toBe('loaded')
  })
})
