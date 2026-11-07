import { randomUUID } from 'node:crypto'

import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'

import { HttpError, textField } from './http'
import { withTransaction, type Pool } from './pg/connection'

export type PageBlock =
  | { type: 'heading'; text: string; level: 2 | 3 }
  | { type: 'text'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'metric'; label: string; value: string; hint?: string }
  | { type: 'chart'; chart: 'bar' | 'line'; title: string; labels: string[]; values: number[] }

export interface PageContent { blocks: PageBlock[] }

export interface PageRow {
  id: string
  profile_id: string
  title: string
  version: number
  content: PageContent
  created_at: Date
  updated_at: Date
}

export interface PageRevisionView {
  version: number
  content: PageContent
  created_at: Date
}

export interface PagePublicationView {
  token: string
  version: number
  created_at: Date
}

export interface PageView extends PageRow {
  revisions: PageRevisionView[]
  publications: PagePublicationView[]
}

export interface PublishedPage {
  title: string
  version: number
  content: PageContent
}

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts"

const TOKEN = /^[a-f0-9]{32}$/

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${field}无效`)
  return value as Record<string, unknown>
}

function arrayField(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new HttpError(400, `${field}数量必须在 ${min}—${max} 之间`)
  }
  return value
}

function stringField(value: unknown, field: string, max: number, empty = false): string {
  return textField(value, field, max, empty)
}

function stringList(value: unknown, field: string, min: number, max: number): string[] {
  return arrayField(value, field, min, max).map((item) => stringField(item, field, 500))
}

export function parsePageContent(value: unknown): PageContent {
  const input = objectField(value, '页面内容')
  const blocks: PageBlock[] = arrayField(input.blocks, '页面块', 1, 100).map((item, index): PageBlock => {
    const block = objectField(item, `第 ${index + 1} 个页面块`)
    if (block.type === 'heading') {
      const level = block.level === 3 ? 3 : 2
      return { type: 'heading' as const, text: stringField(block.text, '标题', 200), level }
    }
    if (block.type === 'text') return { type: 'text' as const, text: stringField(block.text, '正文', 5000) }
    if (block.type === 'list') {
      return { type: 'list' as const, items: stringList(block.items, '列表项', 1, 100) }
    }
    if (block.type === 'table') {
      const columns = stringList(block.columns, '表头', 1, 20)
      const rows = arrayField(block.rows, '表格行', 0, 500).map((row) => {
        const cells = arrayField(row, '表格单元格', columns.length, columns.length)
        return cells.map((cell) => stringField(cell, '表格内容', 1000, true))
      })
      return { type: 'table' as const, columns, rows }
    }
    if (block.type === 'metric') {
      return {
        type: 'metric' as const,
        label: stringField(block.label, '指标名称', 80),
        value: stringField(block.value, '指标值', 200),
        ...(block.hint !== undefined ? { hint: stringField(block.hint, '指标说明', 300) } : {}),
      }
    }
    if (block.type === 'chart') {
      if (block.chart !== 'bar' && block.chart !== 'line') throw new HttpError(400, '图表类型无效')
      const labels = stringList(block.labels, '图表标签', 1, 24)
      const values = arrayField(block.values, '图表数值', 1, 24).map((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, '图表数值无效')
        return value
      })
      if (labels.length !== values.length) throw new HttpError(400, '图表标签和数值数量必须一致')
      return {
        type: 'chart' as const,
        chart: block.chart,
        title: stringField(block.title, '图表标题', 200),
        labels,
        values,
      }
    }
    throw new HttpError(400, '页面块类型无效')
  })
  if (JSON.stringify({ blocks }).length > 80_000) throw new HttpError(400, '页面内容过长')
  return { blocks }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;'
    if (char === '<') return '&lt;'
    if (char === '>') return '&gt;'
    if (char === '"') return '&quot;'
    return '&#39;'
  })
}

function numericRange(values: number[]): { min: number; max: number } {
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    min -= 1
    max += 1
  }
  return { min, max }
}

function barChart(labels: string[], values: number[]): string {
  const { min, max } = numericRange(values)
  const width = 640
  const height = 260
  const plotTop = 20
  const plotHeight = 190
  const step = width / values.length
  const barWidth = Math.max(8, Math.min(64, step * 0.6))
  const zero = plotTop + ((max - 0) / (max - min)) * plotHeight
  const bars = values.map((value, index) => {
    const x = index * step + (step - barWidth) / 2
    const y = plotTop + ((max - value) / (max - min)) * plotHeight
    const base = Math.max(plotTop, Math.min(plotTop + plotHeight, zero))
    const barY = Math.min(y, base)
    const barHeight = Math.max(1, Math.abs(base - y))
    const label = labels[index] ?? ''
    return `<g><rect x="${x.toFixed(1)}" y="${barY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="4" fill="#3b82f6"><title>${escapeHtml(label)}：${value}</title></rect><text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 24}" text-anchor="middle" font-size="11" fill="#6b7280">${escapeHtml(label.slice(0, 12))}</text></g>`
  }).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="柱状图"><line x1="0" y1="${zero.toFixed(1)}" x2="${width}" y2="${zero.toFixed(1)}" stroke="#d1d5db"/>${bars}</svg>`
}

function lineChart(labels: string[], values: number[]): string {
  const { min, max } = numericRange(values)
  const width = 640
  const height = 260
  const left = 20
  const right = width - 20
  const top = 20
  const bottom = 190
  const step = values.length > 1 ? (right - left) / (values.length - 1) : 0
  const points = values.map((value, index) => {
    const x = values.length > 1 ? left + index * step : (left + right) / 2
    const y = top + ((max - value) / (max - min)) * (bottom - top)
    return { x, y, label: labels[index] ?? '', value }
  })
  const polyline = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
  const dots = points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" fill="#3b82f6"><title>${escapeHtml(point.label)}：${point.value}</title></circle>`).join('')
  const labelIndexes = values.length <= 6
    ? points.map((_, index) => index)
    : [...new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])]
  const labelNodes = labelIndexes.map((index) => {
    const point = points[index]
    return point ? `<text x="${point.x.toFixed(1)}" y="${height - 24}" text-anchor="middle" font-size="11" fill="#6b7280">${escapeHtml(point.label.slice(0, 16))}</text>` : ''
  }).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="折线图"><polyline points="${polyline}" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linejoin="round"/>${dots}${labelNodes}</svg>`
}

const PAGE_SCRIPT = `
document.querySelectorAll('table[data-sortable]').forEach(function (table) {
  table.querySelectorAll('thead th').forEach(function (th, index) {
    th.addEventListener('click', function () {
      var body = table.tBodies[0];
      var rows = Array.prototype.slice.call(body.rows);
      var direction = th.getAttribute('data-direction') === 'asc' ? 'desc' : 'asc';
      th.setAttribute('data-direction', direction);
      rows.sort(function (left, right) {
        var a = left.cells[index] ? left.cells[index].textContent : '';
        var b = right.cells[index] ? right.cells[index].textContent : '';
        var na = Number(a);
        var nb = Number(b);
        var result = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b, 'zh-CN');
        return direction === 'asc' ? result : -result;
      });
      rows.forEach(function (row) { body.appendChild(row); });
    });
  });
});
`

function renderBlock(block: PageBlock): string {
  if (block.type === 'heading') {
    const tag = block.level === 3 ? 'h3' : 'h2'
    return `<${tag}>${escapeHtml(block.text)}</${tag}>`
  }
  if (block.type === 'text') return `<p>${escapeHtml(block.text)}</p>`
  if (block.type === 'list') {
    return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
  }
  if (block.type === 'metric') {
    return `<div class="metric"><div class="metric-label">${escapeHtml(block.label)}</div><div class="metric-value">${escapeHtml(block.value)}</div>${block.hint ? `<div class="metric-hint">${escapeHtml(block.hint)}</div>` : ''}</div>`
  }
  if (block.type === 'chart') {
    return `<figure class="chart"><figcaption>${escapeHtml(block.title)}</figcaption>${block.chart === 'bar' ? barChart(block.labels, block.values) : lineChart(block.labels, block.values)}</figure>`
  }
  return `<div class="table-wrap"><table data-sortable><thead><tr>${block.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

export function renderPageHtml(title: string, content: PageContent): string {
  const metrics = content.blocks.filter((block) => block.type === 'metric')
  const body = content.blocks.filter((block) => block.type !== 'metric').map(renderBlock).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f8fafc;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--card:#ffffff;--accent:#3b82f6}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e5e7eb;--muted:#94a3b8;--line:#334155;--card:#111c33;--accent:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:40px 20px 80px}header{border-bottom:1px solid var(--line);margin-bottom:28px;padding-bottom:18px}
h1{font-size:28px;margin:0;letter-spacing:-.02em}h2{font-size:20px;margin:32px 0 12px}h3{font-size:17px;margin:24px 0 8px}
p{margin:10px 0;white-space:pre-wrap}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:18px 0}
.metric{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.metric-label{font-size:12px;color:var(--muted)}.metric-value{font-size:24px;font-weight:600;margin-top:4px}.metric-hint{font-size:12px;color:var(--muted);margin-top:4px}
.chart{margin:20px 0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.chart figcaption{font-size:13px;color:var(--muted);margin-bottom:6px}.chart svg{width:100%;height:auto;display:block}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;margin:16px 0}table{border-collapse:collapse;width:100%;background:var(--card)}th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}th{color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap}tbody tr:last-child td{border-bottom:0}
footer{margin-top:40px;color:var(--muted);font-size:12px}ul{padding-left:22px}
</style></head><body><main><header><h1>${escapeHtml(title)}</h1></header>${metrics.length ? `<div class="metrics">${metrics.map(renderBlock).join('')}</div>` : ''}${body}<footer>由 Waterbot 发布 · 页面只读，内容已转义</footer></main><script>${PAGE_SCRIPT}</script></body></html>`
}

export class Pages {
  constructor(private readonly pool: Pool) {}

  async create(profileId: string, body: Record<string, unknown>): Promise<PageView> {
    if (!(await this.pool.query('select 1 from profile where id = $1', [profileId])).rowCount) throw new HttpError(404, '人格不存在')
    const title = textField(body.title, '标题', 200).trim()
    const content = parsePageContent(body.content)
    const id = randomUUID()
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `insert into page(id, profile_id, title, version, content) values ($1,$2,$3,1,$4)`,
        [id, profileId, title, JSON.stringify(content)],
      )
      await client.query(
        'insert into page_revision(page_id, version, content) values ($1,1,$2)',
        [id, JSON.stringify(content)],
      )
    })
    return this.get(id)
  }

  async list(profileId: string): Promise<PageRow[]> {
    return (await this.pool.query<PageRow>(
      'select * from page where profile_id = $1 order by updated_at desc limit 100', [profileId],
    )).rows
  }

  async get(id: string): Promise<PageView> {
    const page = (await this.pool.query<PageRow>('select * from page where id = $1', [id])).rows[0]
    if (!page) throw new HttpError(404, '页面不存在')
    const revisions = (await this.pool.query<PageRevisionView>(
      'select version, content, created_at from page_revision where page_id = $1 order by version', [id],
    )).rows
    const publications = (await this.pool.query<PagePublicationView>(
      'select token, version, created_at from page_publication where page_id = $1 and revoked_at is null order by created_at desc', [id],
    )).rows
    return { ...page, revisions, publications }
  }

  async update(id: string, body: Record<string, unknown>): Promise<PageView> {
    if (typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion)) throw new HttpError(400, '缺少版本')
    const contentInput = body.content === undefined ? undefined : parsePageContent(body.content)
    const title = body.title === undefined ? undefined : textField(body.title, '标题', 200).trim()
    await withTransaction(this.pool, async (client) => {
      const page = (await client.query<PageRow>('select * from page where id = $1 for update', [id])).rows[0]
      if (!page) throw new HttpError(404, '页面不存在')
      if (page.version !== body.expectedVersion) throw new HttpError(409, '页面已被修改，请刷新后再保存')
      const version = page.version + 1
      const content = contentInput ?? page.content
      await client.query(
        `update page set version = $2, title = $3, content = $4, updated_at = clock_timestamp() where id = $1`,
        [id, version, title ?? page.title, JSON.stringify(content)],
      )
      await client.query(
        'insert into page_revision(page_id, version, content) values ($1,$2,$3)',
        [id, version, JSON.stringify(content)],
      )
    })
    return this.get(id)
  }

  async remove(id: string): Promise<void> {
    const result = await this.pool.query('delete from page where id = $1', [id])
    if (!result.rowCount) throw new HttpError(404, '页面不存在')
  }

  async publish(id: string): Promise<{ token: string; path: string; version: number }> {
    const page = (await this.pool.query<PageRow>('select * from page where id = $1', [id])).rows[0]
    if (!page) throw new HttpError(404, '页面不存在')
    const token = randomUUID().replaceAll('-', '')
    await this.pool.query(
      `insert into page_publication(token, page_id, version, title, content) values ($1,$2,$3,$4,$5)`,
      [token, id, page.version, page.title, JSON.stringify(page.content)],
    )
    return { token, path: `/api/public/pages/${token}`, version: page.version }
  }

  async unpublish(id: string): Promise<number> {
    return (await this.pool.query(
      'update page_publication set revoked_at = clock_timestamp() where page_id = $1 and revoked_at is null', [id],
    )).rowCount ?? 0
  }

  async publicPage(token: string): Promise<PublishedPage> {
    if (!TOKEN.test(token)) throw new HttpError(404, '页面不存在')
    const page = (await this.pool.query<PublishedPage>(
      'select title, version, content from page_publication where token = $1 and revoked_at is null', [token],
    )).rows[0]
    if (!page) throw new HttpError(404, '页面不存在')
    return page
  }

  async updateForConversation(
    conversationId: string,
    pageId: string,
    body: Record<string, unknown>,
  ): Promise<PageView> {
    const binding = (await this.pool.query<{ profile_id: string; scope_kind: string }>(
      'select profile_id, scope_kind from conversation_binding where pi_conversation_id = $1', [conversationId],
    )).rows[0]
    if (!binding) throw new HttpError(403, '当前会话不能修改页面')
    if (binding.scope_kind !== 'owner_private') throw new HttpError(403, '只有主人私聊可以修改页面')
    const page = (await this.pool.query<PageRow>('select * from page where id = $1', [pageId])).rows[0]
    if (!page || page.profile_id !== binding.profile_id) throw new HttpError(404, '页面不存在')
    return this.update(pageId, { expectedVersion: page.version, ...body })
  }
}

export function createPageTool(pages: Pages): ToolRegistration {
  return defineTool({
    name: 'update_page',
    description: 'Update one of the owner\'s saved pages with structured content. Only available in the owner private conversation.',
    parameters: Type.Object({
      pageId: Type.String({ description: 'Page ID from the owner' }),
      content: Type.Any({ description: 'Structured page content: {"blocks":[...]}' }),
      title: Type.Optional(Type.String()),
    }),
    replay: 'unsafe',
    execute: async (args, api) => {
      const updated = await pages.updateForConversation(String(api.conversationId), args.pageId, {
        content: args.content,
        ...(args.title ? { title: args.title } : {}),
      })
      return { output: [{ type: 'text', text: `页面“${updated.title}”已更新到版本 ${updated.version}` }] }
    },
  })
}
