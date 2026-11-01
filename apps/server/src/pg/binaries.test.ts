import { describe, expect, it } from 'vitest'

import { binariesFromDir, resolvePgBinaries } from './binaries'

const EXE = process.platform === 'win32' ? '.exe' : ''

describe('PostgreSQL 二进制定位', () => {
  it('PG_BIN 指向的目录优先，并按平台补扩展名', async () => {
    const binaries = await resolvePgBinaries({ PG_BIN: '/opt/postgres/bin' })

    expect(binaries.initdb).toBe(binariesFromDir('/opt/postgres/bin').initdb)
    expect(binaries.pg_ctl).toBe(binariesFromDir('/opt/postgres/bin').pg_ctl)
    expect(binaries.initdb.endsWith(`initdb${EXE}`)).toBe(true)
  })

  it('binariesFromDir 与平台扩展名一致', () => {
    const binaries = binariesFromDir('/usr/lib/postgresql/18/bin')

    expect(binaries.initdb.endsWith(`initdb${EXE}`)).toBe(true)
    expect(binaries.pg_ctl.endsWith(`pg_ctl${EXE}`)).toBe(true)
  })

  it('既没有 PG_BIN 也没有平台可选依赖时给出可执行的报错', async () => {
    if (process.platform === 'win32') {
      // Windows 上可选依赖存在，这里只验证它能解析出路径
      const binaries = await resolvePgBinaries({})
      expect(binaries.initdb.length).toBeGreaterThan(0)
      return
    }

    await expect(resolvePgBinaries({})).rejects.toThrow(/PG_BIN/)
  })
})
