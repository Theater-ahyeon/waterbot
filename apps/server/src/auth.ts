import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { HttpError } from './http'
import type { Pool } from './pg/connection'

const COOKIE = 'waterbot_session'
const LIFETIME_SECONDS = 86_400
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class OwnerAuth {
  private failures = 0
  private resetAt = 0

  private constructor(private readonly pool: Pool, private readonly keyHash: string, private readonly secure: boolean) {}

  static async open(pool: Pool, keyPath: string, options: { secure?: boolean } = {}): Promise<OwnerAuth> {
    await mkdir(dirname(keyPath), { recursive: true })
    try {
      await writeFile(keyPath, `pa_${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const key = (await readFile(keyPath, 'utf8')).trim()
    if (key.length < 32) throw new Error('本机访问码文件无效，请恢复或重新生成')
    return new OwnerAuth(pool, hash(key), options.secure === true)
  }

  async login(key: unknown): Promise<string> {
    if (Date.now() > this.resetAt) {
      this.failures = 0
      this.resetAt = Date.now() + 60_000
    }
    if (this.failures >= 10) throw new HttpError(429, '尝试过于频繁，请稍后再试')
    if (typeof key !== 'string' || key.length > 200 || !timingSafeEqual(Buffer.from(hash(key.trim()), 'hex'), Buffer.from(this.keyHash, 'hex'))) {
      this.failures++
      throw new HttpError(401, '访问码不正确')
    }
    const token = randomBytes(32).toString('hex')
    await this.pool.query('delete from owner_session where expires_at <= clock_timestamp()')
    await this.pool.query(
      `insert into owner_session(token_hash, expires_at) values ($1, clock_timestamp() + interval '1 day')`,
      [hash(token)],
    )
    this.failures = 0
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LIFETIME_SECONDS}${this.secure ? '; Secure' : ''}`
  }

  async session(cookie: string | undefined): Promise<string | undefined> {
    const token = cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined
    const tokenHash = hash(token)
    const result = await this.pool.query('select 1 from owner_session where token_hash = $1 and expires_at > clock_timestamp()', [tokenHash])
    return result.rowCount === 1 ? tokenHash : undefined
  }

  async logout(tokenHash: string): Promise<string> {
    await this.pool.query('delete from owner_session where token_hash = $1', [tokenHash])
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secure ? '; Secure' : ''}`
  }
}
