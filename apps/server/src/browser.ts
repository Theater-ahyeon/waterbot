import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'

import { HttpError } from './http'
import { withTransaction, type Pool } from './pg/connection'

export interface BrowserSurface {
  id: string
  profile_id: string
  state: 'closed' | 'ready' | 'disconnected'
  lease_holder: 'agent' | 'human' | 'none'
  lease_version: number
  lease_until: Date | null
  current_url: string | null
  title: string | null
  last_error: string | null
  updated_at: Date
}

export interface BrowserElement {
  ref: string
  tag: string
  role: string
  name: string
  disabled: boolean
}

export interface BrowserSnapshot {
  url: string
  title: string
  aria: string
  elements: BrowserElement[]
  lease: { holder: BrowserSurface['lease_holder']; version: number; until: Date | null }
}

export interface BrowserArtifact {
  id: string
  name: string
  mime: string
  size: string
  storage_path: string
}

interface Session {
  context: BrowserContext
  page: Page
  refs: Locator[]
}

interface BrowserOptions {
  channel?: string
  headless?: boolean
  /** 测试用；生产默认拒绝本机和私有网段。 */
  allowPrivate?: boolean
}

const PRIVATE_HOSTS = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i

function validateUrl(value: string, allowPrivate: boolean): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, '网址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, '只允许 http 或 https 网址')
  if (!allowPrivate && PRIVATE_HOSTS.test(url.hostname)) throw new HttpError(400, '默认不访问本机或私有网段')
  return url.toString()
}

function roleOf(tag: string, role: string | null): string {
  if (role) return role
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'input' || tag === 'textarea') return 'textbox'
  if (tag === 'select') return 'combobox'
  return tag
}

export class BrowserService {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly pool: Pool,
    private readonly profileRoot: string,
    private readonly shotRoot: string,
    private readonly options: BrowserOptions = {},
  ) {}

  async profileForConversation(conversationId: string): Promise<string> {
    const row = (await this.pool.query<{ profile_id: string; scope_kind: string }>(
      'select profile_id, scope_kind from conversation_binding where pi_conversation_id = $1', [conversationId],
    )).rows[0]
    if (!row) throw new HttpError(403, '当前会话不能使用浏览器')
    if (row.scope_kind !== 'owner_private') throw new HttpError(403, '只有主人私聊可以控制浏览器')
    return row.profile_id
  }

  async status(profileId: string): Promise<BrowserSurface | null> {
    return (await this.pool.query<BrowserSurface>(
      'select * from browser_surface where profile_id = $1', [profileId],
    )).rows[0] ?? null
  }

  async open(profileId: string, rawUrl: string): Promise<BrowserSnapshot> {
    await this.assertAgent(profileId)
    const url = validateUrl(rawUrl, this.options.allowPrivate ?? false)
    const session = await this.session(profileId)
    try {
      await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      await this.touch(profileId, session.page.url(), await session.page.title())
    } catch (error) {
      await this.fail(profileId, error)
      throw error
    }
    return this.snapshot(profileId)
  }

  async snapshot(profileId: string): Promise<BrowserSnapshot> {
    await this.assertAgent(profileId)
    const session = this.sessions.get(profileId)
    if (!session) throw new HttpError(409, '浏览器还没有打开')
    const page = session.page
    const url = page.url()
    const title = await page.title()
    let aria: string
    try {
      aria = await page.locator('body').ariaSnapshot({ timeout: 5_000 })
    } catch {
      aria = ''
    }
    const elements: BrowserElement[] = []
    const refs: Locator[] = []
    const candidates = page.locator('a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"]')
    const count = Math.min(await candidates.count(), 80)
    for (let index = 0; index < count; index++) {
      const locator = candidates.nth(index)
      try {
        if (!(await locator.isVisible())) continue
        const tag = await locator.evaluate((element) => element.tagName.toLowerCase())
        const role = await locator.getAttribute('role')
        const ariaLabel = await locator.getAttribute('aria-label')
        const placeholder = await locator.getAttribute('placeholder')
        const text = (await locator.innerText().catch(() => '')).trim().slice(0, 80)
        const disabled = await locator.isDisabled().catch(() => false)
        refs.push(locator)
        elements.push({
          ref: `e${refs.length}`,
          tag,
          role: roleOf(tag, role),
          name: ariaLabel || placeholder || text || tag,
          disabled,
        })
      } catch {
        // 元素在快照期间消失，跳过；下次快照会重新编号。
      }
    }
    session.refs = refs
    await this.touch(profileId, url, title)
    const surface = await this.status(profileId)
    return {
      url, title, aria: aria.slice(0, 20_000), elements,
      lease: {
        holder: surface?.lease_holder ?? 'agent',
        version: surface?.lease_version ?? 1,
        until: surface?.lease_until ?? null,
      },
    }
  }

  async click(profileId: string, ref: string): Promise<BrowserSnapshot> {
    await this.assertAgent(profileId)
    const locator = this.ref(profileId, ref)
    await locator.click({ timeout: 10_000 })
    return this.snapshot(profileId)
  }

  async type(profileId: string, ref: string, text: string, submit = false): Promise<BrowserSnapshot> {
    await this.assertAgent(profileId)
    const locator = this.ref(profileId, ref)
    await locator.fill(text, { timeout: 10_000 })
    if (submit) await locator.press('Enter')
    return this.snapshot(profileId)
  }

  async screenshot(profileId: string): Promise<BrowserArtifact> {
    await this.assertAgent(profileId)
    const session = this.sessions.get(profileId)
    if (!session) throw new HttpError(409, '浏览器还没有打开')
    const buffer = await session.page.screenshot({ fullPage: true, type: 'png' })
    const directory = join(this.shotRoot, profileId)
    await mkdir(directory, { recursive: true })
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.png`
    const path = join(directory, name)
    await writeFile(path, buffer)
    const id = randomUUID()
    const artifact = (await this.pool.query<BrowserArtifact>(
      `insert into artifact(id, profile_id, execution_id, name, relative_path, mime, size, sha256, storage_path)
       values ($1,$2,null,$3,$3,'image/png',$4,$5,$6)
       returning id, name, mime, size::text, storage_path`,
      [id, profileId, name, String(buffer.length), createHash('sha256').update(buffer).digest('hex'), path],
    )).rows[0]!
    return artifact
  }

  async closeSurface(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId)
    if (session) {
      this.sessions.delete(profileId)
      await session.context.close().catch(() => undefined)
    }
    await this.pool.query(
      `update browser_surface set state = 'closed', updated_at = clock_timestamp() where profile_id = $1`, [profileId],
    )
  }

  async lease(profileId: string, holder: BrowserSurface['lease_holder']): Promise<BrowserSurface> {
    return withTransaction(this.pool, async (client) => {
      const surface = (await client.query<BrowserSurface>(
        'select * from browser_surface where profile_id = $1 for update', [profileId],
      )).rows[0]
      const until = holder === 'human' ? new Date(Date.now() + 15 * 60_000) : null
      if (!surface) {
        return (await client.query<BrowserSurface>(
          `insert into browser_surface(id, profile_id, lease_holder, lease_until)
           values ($1,$2,$3,$4) returning *`,
          [randomUUID(), profileId, holder, until],
        )).rows[0]!
      }
      return (await client.query<BrowserSurface>(
        `update browser_surface set lease_holder = $2, lease_until = $3, lease_version = lease_version + 1,
           updated_at = clock_timestamp() where profile_id = $1 returning *`,
        [profileId, holder, until],
      )).rows[0]!
    })
  }

  async close(): Promise<void> {
    for (const [profileId, session] of this.sessions) {
      this.sessions.delete(profileId)
      await session.context.close().catch(() => undefined)
    }
  }

  private async assertAgent(profileId: string): Promise<void> {
    const surface = await this.status(profileId)
    if (!surface || surface.lease_holder !== 'human') return
    if (surface.lease_until && surface.lease_until.getTime() <= Date.now()) {
      await this.pool.query(
        `update browser_surface set lease_holder = 'agent', lease_until = null, lease_version = lease_version + 1,
           updated_at = clock_timestamp() where profile_id = $1`, [profileId],
      )
      return
    }
    throw new HttpError(409, '浏览器正由人工接管，先交还控制权')
  }

  private ref(profileId: string, ref: string): Locator {
    const session = this.sessions.get(profileId)
    if (!session) throw new HttpError(409, '浏览器还没有打开')
    const index = Number(ref.replace(/^e/, ''))
    const locator = Number.isSafeInteger(index) ? session.refs[index - 1] : undefined
    if (!locator) throw new HttpError(400, '元素引用已失效，请重新快照')
    return locator
  }

  private async session(profileId: string): Promise<Session> {
    const existing = this.sessions.get(profileId)
    if (existing) return existing
    try {
      await mkdir(join(this.profileRoot, profileId), { recursive: true })
      const context = await chromium.launchPersistentContext(join(this.profileRoot, profileId), {
        channel: this.options.channel ?? 'msedge',
        headless: this.options.headless ?? true,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: false,
      })
      const page = context.pages()[0] ?? await context.newPage()
      page.setDefaultTimeout(10_000)
      const session: Session = { context, page, refs: [] }
      this.sessions.set(profileId, session)
      await this.pool.query(
        `insert into browser_surface(id, profile_id, state) values ($1,$2,'ready')
         on conflict (profile_id) do update set state = 'ready', last_error = null, updated_at = clock_timestamp()`,
        [randomUUID(), profileId],
      )
      return session
    } catch (error) {
      await this.fail(profileId, error)
      throw new HttpError(503, `浏览器启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async touch(profileId: string, url: string, title: string): Promise<void> {
    await this.pool.query(
      `update browser_surface set current_url = $2, title = $3, state = 'ready', last_error = null,
         updated_at = clock_timestamp() where profile_id = $1`, [profileId, url, title],
    )
  }

  private async fail(profileId: string, error: unknown): Promise<void> {
    await this.pool.query(
      `insert into browser_surface(id, profile_id, state, last_error) values ($1,$2,'disconnected',$3)
       on conflict (profile_id) do update set state = 'disconnected', last_error = $3, updated_at = clock_timestamp()`,
      [randomUUID(), profileId, (error instanceof Error ? error.message : String(error)).slice(0, 500)],
    ).catch(() => undefined)
  }
}

export function createBrowserTools(browser: BrowserService): ToolRegistration[] {
  const profile = async (conversationId: { toString(): string }) => browser.profileForConversation(String(conversationId))
  const output = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value).slice(0, 20_000) }]
  return [
    defineTool({
      name: 'browser_open',
      description: 'Open an http(s) URL in the owner\'s isolated browser profile and return a page snapshot.',
      parameters: Type.Object({ url: Type.String() }),
      replay: 'unsafe',
      execute: async (args, api) => {
        const snapshot = await browser.open(await profile(api.conversationId), args.url)
        return { output: output(snapshot) }
      },
    }),
    defineTool({
      name: 'browser_snapshot',
      description: 'Read the current page title, ARIA snapshot and interactive element refs. Does not act.',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async (_args, api) => {
        const snapshot = await browser.snapshot(await profile(api.conversationId))
        return { output: output(snapshot) }
      },
    }),
    defineTool({
      name: 'browser_click',
      description: 'Click one interactive element by its ref from the latest snapshot, then return a new snapshot.',
      parameters: Type.Object({ ref: Type.String() }),
      replay: 'unsafe',
      execute: async (args, api) => {
        const snapshot = await browser.click(await profile(api.conversationId), args.ref)
        return { output: output(snapshot) }
      },
    }),
    defineTool({
      name: 'browser_type',
      description: 'Fill a text field by ref from the latest snapshot. Password values are never returned in snapshots.',
      parameters: Type.Object({ ref: Type.String(), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
      replay: 'unsafe',
      execute: async (args, api) => {
        const snapshot = await browser.type(await profile(api.conversationId), args.ref, args.text, args.submit ?? false)
        return { output: output(snapshot) }
      },
    }),
    defineTool({
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot into the owner\'s artifacts and return its artifact id.',
      parameters: Type.Object({}),
      replay: 'unsafe',
      execute: async (_args, api) => {
        const artifact = await browser.screenshot(await profile(api.conversationId))
        return { output: output(artifact) }
      },
    }),
  ]
}
