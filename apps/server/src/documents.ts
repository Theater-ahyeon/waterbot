import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  Document as DocxDocument,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'

import { HttpError, textField } from './http'
import { withTransaction, type Pool, type PoolClient } from './pg/connection'

export type DocumentKind = 'docx' | 'xlsx' | 'pptx'

export interface DocumentRow {
  id: string
  profile_id: string
  title: string
  kind: DocumentKind
  version: number
  created_at: Date
  updated_at: Date
}

export interface DocumentArtifact {
  id: string
  name: string
  mime: string
  size: string
  sha256: string
  storage_path: string
  created_at: Date
}

export interface DocumentRevisionView {
  version: number
  source: unknown
  created_at: Date
  artifact: DocumentArtifact
}

export interface DocumentView extends DocumentRow {
  revisions: DocumentRevisionView[]
}

interface DocxSection { heading?: string; paragraphs: string[] }
interface Sheet { name: string; rows: (string | number)[][] }
interface Slide { title: string; bullets: string[] }
interface DocumentContent { sections?: DocxSection[]; sheets?: Sheet[]; slides?: Slide[] }

const MIME: Record<DocumentKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const MAX_CONTENT_CHARS = 60_000

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

export function parseDocumentContent(kind: DocumentKind, value: unknown): DocumentContent {
  const input = objectField(value, '文档内容')
  if (JSON.stringify(input).length > MAX_CONTENT_CHARS) throw new HttpError(400, '文档内容过长')
  if (kind === 'docx') {
    const sections = arrayField(input.sections, '章节', 1, 50).map((item, index) => {
      const section = objectField(item, `第 ${index + 1} 节`)
      return {
        ...(section.heading !== undefined ? { heading: stringField(section.heading, '小节标题', 200) } : {}),
        paragraphs: arrayField(section.paragraphs, '段落', 1, 100)
          .map((paragraph) => stringField(paragraph, '段落内容', 5000)),
      }
    })
    return { sections }
  }
  if (kind === 'xlsx') {
    const sheets = arrayField(input.sheets, '工作表', 1, 20).map((item, index) => {
      const sheet = objectField(item, `第 ${index + 1} 个工作表`)
      const name = stringField(sheet.name, '工作表名称', 31).trim()
      if (/[[\]:*?/\\]/.test(name)) throw new HttpError(400, '工作表名称含有不允许的字符')
      const rows = arrayField(sheet.rows, '行', 0, 1000).map((row) => {
        const cells = arrayField(row, '单元格', 0, 50)
        return cells.map((cell) => {
          if (typeof cell === 'number') {
            if (!Number.isFinite(cell)) throw new HttpError(400, '单元格数字无效')
            return cell
          }
          return stringField(cell, '单元格内容', 1000, true)
        })
      })
      return { name, rows }
    })
    return { sheets }
  }
  const slides = arrayField(input.slides, '幻灯片', 1, 50).map((item, index) => {
    const slide = objectField(item, `第 ${index + 1} 页`)
    return {
      title: stringField(slide.title, '幻灯片标题', 200),
      bullets: arrayField(slide.bullets ?? [], '要点', 0, 20).map((bullet) => stringField(bullet, '要点内容', 1000)),
    }
  })
  return { slides }
}

function safeName(title: string): string {
  const characters = [...title].map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? ' ' : char))
  const name = characters.join('').trim().slice(0, 120)
  return name || 'document'
}

async function writeDocx(title: string, content: DocumentContent, path: string): Promise<void> {
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]
  for (const section of content.sections ?? []) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }))
    }
    for (const paragraph of section.paragraphs) {
      children.push(new Paragraph({ children: [new TextRun(paragraph)] }))
    }
  }
  const document = new DocxDocument({ sections: [{ children }] })
  await writeFile(path, await Packer.toBuffer(document))
}

async function writeXlsx(content: DocumentContent, path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  for (const sheet of content.sheets ?? []) {
    const worksheet = workbook.addWorksheet(sheet.name)
    for (const row of sheet.rows) worksheet.addRow(row)
  }
  await workbook.xlsx.writeFile(path)
}

async function writePptx(title: string, content: DocumentContent, path: string): Promise<void> {
  const deck = new PptxGenJS()
  deck.title = title
  for (const slide of content.slides ?? []) {
    const page = deck.addSlide()
    page.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 28, bold: true, color: '1F2937' })
    if (slide.bullets.length) {
      page.addText(
        slide.bullets.map((bullet) => ({ text: bullet, options: { bullet: true } })),
        { x: 0.7, y: 1.5, w: 8.6, h: 4.6, fontSize: 16, color: '374151' },
      )
    }
  }
  await deck.writeFile({ fileName: path })
}

async function writeDocument(kind: DocumentKind, title: string, content: DocumentContent, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  if (kind === 'docx') await writeDocx(title, content, path)
  else if (kind === 'xlsx') await writeXlsx(content, path)
  else await writePptx(title, content, path)
}

function kindField(value: unknown): DocumentKind {
  if (value === 'docx' || value === 'xlsx' || value === 'pptx') return value
  throw new HttpError(400, '文档类型必须是 docx、xlsx 或 pptx')
}

async function insertArtifact(
  client: PoolClient,
  input: { profileId: string; title: string; kind: DocumentKind; storagePath: string },
): Promise<DocumentArtifact> {
  const info = await stat(input.storagePath)
  const data = await readFile(input.storagePath)
  const id = randomUUID()
  const name = `${safeName(input.title)}.${input.kind}`
  return (await client.query<DocumentArtifact>(
    `insert into artifact(id, profile_id, execution_id, name, relative_path, mime, size, sha256, storage_path)
     values ($1,$2,null,$3,$4,$5,$6,$7,$8) returning id, name, mime, size::text, sha256, storage_path, created_at`,
    [id, input.profileId, name, name, MIME[input.kind], String(info.size),
      createHash('sha256').update(data).digest('hex'), input.storagePath],
  )).rows[0]!
}

export class Documents {
  constructor(private readonly pool: Pool, private readonly root: string) {}

  async create(profileId: string, body: Record<string, unknown>): Promise<DocumentView> {
    if (!(await this.pool.query('select 1 from profile where id = $1', [profileId])).rowCount) throw new HttpError(404, '人格不存在')
    const title = textField(body.title, '标题', 200).trim()
    const kind = kindField(body.kind)
    const content = parseDocumentContent(kind, body.content)
    const id = randomUUID()
    const path = join(this.root, id, `v1.${kind}`)
    try {
      await writeDocument(kind, title, content, path)
      await withTransaction(this.pool, async (client) => {
        await client.query(
          `insert into document(id, profile_id, title, kind, version) values ($1,$2,$3,$4,1)`,
          [id, profileId, title, kind],
        )
        const artifact = await insertArtifact(client, { profileId, title, kind, storagePath: path })
        await client.query(
          'insert into document_revision(document_id, version, artifact_id, source) values ($1,1,$2,$3)',
          [id, artifact.id, JSON.stringify(content)],
        )
      })
    } catch (error) {
      await unlink(path).catch(() => undefined)
      throw error
    }
    return this.get(id)
  }

  async list(profileId: string): Promise<DocumentRow[]> {
    return (await this.pool.query<DocumentRow>(
      'select * from document where profile_id = $1 order by updated_at desc limit 100', [profileId],
    )).rows
  }

  async get(id: string): Promise<DocumentView> {
    const document = (await this.pool.query<DocumentRow>('select * from document where id = $1', [id])).rows[0]
    if (!document) throw new HttpError(404, '文档不存在')
    const revisions = (await this.pool.query<{
      version: number; source: unknown; created_at: Date;
      id: string; name: string; mime: string; size: string; sha256: string; storage_path: string; artifact_created_at: Date
    }>(
      `select r.version, r.source, r.created_at,
              a.id, a.name, a.mime, a.size::text as size, a.sha256, a.storage_path, a.created_at as artifact_created_at
         from document_revision r join artifact a on a.id = r.artifact_id
        where r.document_id = $1 order by r.version`, [id],
    )).rows
    return {
      ...document,
      revisions: revisions.map((row) => ({
        version: row.version,
        source: row.source,
        created_at: row.created_at,
        artifact: {
          id: row.id, name: row.name, mime: row.mime, size: row.size,
          sha256: row.sha256, storage_path: row.storage_path, created_at: row.artifact_created_at,
        },
      })),
    }
  }

  async revise(id: string, body: Record<string, unknown>): Promise<DocumentView> {
    const contentInput = parseDocumentContent(await this.kindOf(id), body.content)
    const title = body.title === undefined ? undefined : textField(body.title, '标题', 200).trim()
    await withTransaction(this.pool, async (client) => {
      const document = (await client.query<DocumentRow>('select * from document where id = $1 for update', [id])).rows[0]
      if (!document) throw new HttpError(404, '文档不存在')
      const version = document.version + 1
      const path = join(this.root, id, `v${version}.${document.kind}`)
      await writeDocument(document.kind, title ?? document.title, contentInput, path)
      const artifact = await insertArtifact(client, {
        profileId: document.profile_id, title: title ?? document.title, kind: document.kind, storagePath: path,
      })
      await client.query(
        'insert into document_revision(document_id, version, artifact_id, source) values ($1,$2,$3,$4)',
        [id, version, artifact.id, JSON.stringify(contentInput)],
      )
      await client.query(
        `update document set version = $2, title = $3, updated_at = clock_timestamp() where id = $1`,
        [id, version, title ?? document.title],
      )
    })
    return this.get(id)
  }

  private async kindOf(id: string): Promise<DocumentKind> {
    const row = (await this.pool.query<{ kind: DocumentKind }>('select kind from document where id = $1', [id])).rows[0]
    if (!row) throw new HttpError(404, '文档不存在')
    return row.kind
  }
}
