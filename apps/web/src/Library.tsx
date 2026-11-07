import { useEffect, useState, type FormEvent } from 'react'

import { api, type Profile } from './api/client'
import { Button } from './components/ui/button'
import { Card } from './components/ui/card'

type DocumentKind = 'docx' | 'xlsx' | 'pptx'

interface DocumentSummary {
  id: string
  title: string
  kind: DocumentKind
  version: number
  updated_at: string
}

interface DocumentSource {
  sections?: { heading?: string; paragraphs: string[] }[]
  sheets?: { name: string; rows: (string | number)[][] }[]
  slides?: { title: string; bullets: string[] }[]
}

interface DocumentDetail extends DocumentSummary {
  revisions: {
    version: number
    source: DocumentSource
    created_at: string
    artifact: { id: string; name: string; size: string; mime: string }
  }[]
}

interface PageSummary { id: string; title: string; version: number; updated_at: string }
interface PageBlock { type: string; text?: string; items?: string[] }
interface PageDetail extends PageSummary {
  content: { blocks: PageBlock[] }
  revisions: { version: number; content: { blocks: PageBlock[] }; created_at: string }[]
  publications: { token: string; version: number; created_at: string }[]
}

const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const reason = (error: unknown) => error instanceof Error ? error.message : '请求失败'

function documentText(kind: DocumentKind, source: DocumentSource | undefined): string {
  if (!source) return ''
  if (kind === 'docx') return (source.sections ?? []).flatMap((section) => section.paragraphs).join('\n\n')
  if (kind === 'xlsx') return (source.sheets ?? []).flatMap((sheet) => sheet.rows.map((row) => row.join(', '))).join('\n')
  return (source.slides ?? []).map((slide) => [slide.title, ...slide.bullets.map((bullet) => `- ${bullet}`)].join('\n')).join('\n\n')
}

function documentContent(kind: DocumentKind, text: string): DocumentSource {
  const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
  if (kind === 'docx') return { sections: blocks.map((block) => ({ paragraphs: [block] })) }
  if (kind === 'xlsx') {
    const rows = text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) =>
      line.split(',').map((cell) => {
        const trimmed = cell.trim()
        const number = Number(trimmed)
        return trimmed !== '' && Number.isFinite(number) ? number : trimmed
      }),
    )
    return { sheets: [{ name: '数据', rows }] }
  }
  return {
    slides: blocks.map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
      return { title: lines[0] ?? '未命名', bullets: lines.slice(1).map((line) => line.replace(/^-\s*/, '')) }
    }),
  }
}

function pageText(blocks: PageBlock[]): string {
  return blocks.map((block) => block.text ?? block.items?.join('\n') ?? '').filter(Boolean).join('\n\n')
}

export function Library({ profile }: { profile: Profile }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>()
  const [pages, setPages] = useState<PageSummary[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [docTitle, setDocTitle] = useState('')
  const [docKind, setDocKind] = useState<DocumentKind>('docx')
  const [docText, setDocText] = useState('')
  const [pageTitle, setPageTitle] = useState('')
  const [pageTextInput, setPageTextInput] = useState('')
  const [openDoc, setOpenDoc] = useState<DocumentDetail>()
  const [docEdit, setDocEdit] = useState('')
  const [openPage, setOpenPage] = useState<PageDetail>()
  const [pageEdit, setPageEdit] = useState('')
  const [published, setPublished] = useState<Record<string, string>>({})

  function load() {
    setError('')
    void Promise.all([
      api<{ documents: DocumentSummary[] }>(`/api/profiles/${profile.id}/documents`),
      api<{ pages: PageSummary[] }>(`/api/profiles/${profile.id}/pages`),
    ]).then(([docs, list]) => { setDocuments(docs.documents); setPages(list.pages) })
      .catch((error: unknown) => setError(reason(error)))
  }
  useEffect(() => {
    void Promise.all([
      api<{ documents: DocumentSummary[] }>(`/api/profiles/${profile.id}/documents`),
      api<{ pages: PageSummary[] }>(`/api/profiles/${profile.id}/pages`),
    ]).then(([docs, list]) => { setDocuments(docs.documents); setPages(list.pages) })
      .catch((error: unknown) => setError(reason(error)))
  }, [profile.id])

  async function createDocument(event: FormEvent) {
    event.preventDefault()
    setBusy('document')
    setError('')
    try {
      await api(`/api/profiles/${profile.id}/documents`, 'POST', {
        title: docTitle, kind: docKind, content: documentContent(docKind, docText),
      })
      setDocTitle('')
      setDocText('')
      load()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function createPage(event: FormEvent) {
    event.preventDefault()
    setBusy('page')
    setError('')
    try {
      const blocks = pageTextInput.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean).map((text) => ({ type: 'text', text }))
      await api(`/api/profiles/${profile.id}/pages`, 'POST', { title: pageTitle, content: { blocks } })
      setPageTitle('')
      setPageTextInput('')
      load()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function expandDocument(id: string) {
    if (openDoc?.id === id) { setOpenDoc(undefined); return }
    try {
      const detail = await api<DocumentDetail>(`/api/documents/${id}`)
      setOpenDoc(detail)
      setDocEdit(documentText(detail.kind, detail.revisions.at(-1)?.source))
    } catch (error) { setError(reason(error)) }
  }

  async function reviseDocument(event: FormEvent) {
    event.preventDefault()
    if (!openDoc) return
    setBusy(openDoc.id)
    setError('')
    try {
      await api(`/api/documents/${openDoc.id}/revisions`, 'POST', {
        title: openDoc.title, content: documentContent(openDoc.kind, docEdit),
      })
      const detail = await api<DocumentDetail>(`/api/documents/${openDoc.id}`)
      setOpenDoc(detail)
      setDocEdit(documentText(detail.kind, detail.revisions.at(-1)?.source))
      load()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function expandPage(id: string) {
    if (openPage?.id === id) { setOpenPage(undefined); return }
    try {
      const detail = await api<PageDetail>(`/api/pages/${id}`)
      setOpenPage(detail)
      setPageEdit(pageText(detail.content.blocks))
    } catch (error) { setError(reason(error)) }
  }

  async function updatePage(event: FormEvent) {
    event.preventDefault()
    if (!openPage) return
    setBusy(openPage.id)
    setError('')
    try {
      const blocks = pageEdit.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean).map((text) => ({ type: 'text', text }))
      const detail = await api<PageDetail>(`/api/pages/${openPage.id}`, 'PATCH', {
        expectedVersion: openPage.version, content: { blocks },
      })
      setOpenPage(detail)
      setPageEdit(pageText(detail.content.blocks))
      load()
    } catch (error) { setError(reason(error)); load() } finally { setBusy('') }
  }

  async function publish(id: string) {
    setBusy(id)
    setError('')
    try {
      const result = await api<{ path: string }>(`/api/pages/${id}/publish`, 'POST')
      setPublished((previous) => ({ ...previous, [id]: result.path }))
      const detail = await api<PageDetail>(`/api/pages/${id}`)
      setOpenPage(detail)
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function unpublish(id: string) {
    setBusy(id)
    setError('')
    try {
      await api(`/api/pages/${id}/unpublish`, 'POST')
      setPublished((previous) => ({ ...previous, [id]: '' }))
      if (openPage?.id === id) setOpenPage(await api<PageDetail>(`/api/pages/${id}`))
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function removePage(id: string) {
    setBusy(id)
    setError('')
    try {
      await api(`/api/pages/${id}`, 'DELETE')
      if (openPage?.id === id) setOpenPage(undefined)
      load()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  const textOnly = openPage ? openPage.content.blocks.every((block) => block.type === 'text' || block.type === 'heading' || block.type === 'list') : false

  return <div className="space-y-5" aria-label={`${profile.name}的资料库`}>
    <header><h2 className="text-xl font-semibold">{profile.name}的资料库</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">文档和页面按人格隔离。修改会生成新版本，旧版本仍可下载；公开链接来自独立发布副本。</p></header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    <Card className="p-5"><details><summary className="cursor-pointer font-medium">生成文档</summary>
      <form className="mt-4 space-y-3" onSubmit={(event) => { void createDocument(event) }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-2 text-sm"><span>标题</span><input className={field} value={docTitle} onChange={(event) => setDocTitle(event.target.value)} maxLength={200} required disabled={!!busy} /></label>
          <label className="block space-y-2 text-sm"><span>格式</span><select className={field} value={docKind} onChange={(event) => setDocKind(event.target.value as DocumentKind)} disabled={!!busy}><option value="docx">Word 文档</option><option value="xlsx">Excel 表格</option><option value="pptx">演示文稿</option></select></label>
        </div>
        <label className="block space-y-2 text-sm"><span>{docKind === 'xlsx' ? '每行一条记录，逗号分隔单元格' : docKind === 'pptx' ? '空行分页，第一行是标题，其余是要点' : '正文，空行分段'}</span><textarea className={field} rows={5} value={docText} onChange={(event) => setDocText(event.target.value)} disabled={!!busy} required /></label>
        <Button type="submit" disabled={!!busy} className="min-h-11">{busy === 'document' ? '生成中…' : '生成文档'}</Button>
      </form>
    </details></Card>

    {documents === undefined ? <p role="status" className="text-sm text-muted-foreground">正在读取文档…</p> : !documents.length ? <p className="text-sm text-muted-foreground">还没有文档。</p> : <div className="space-y-3">{documents.map((document) => <Card key={document.id} className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><h3 className="break-words font-medium">{document.title}</h3><p className="text-xs text-muted-foreground">{document.kind} · 版本 {document.version} · {new Date(document.updated_at).toLocaleString()}</p></div><Button variant="outline" size="sm" className="min-h-11" onClick={() => { void expandDocument(document.id) }}>{openDoc?.id === document.id ? '收起' : '版本与修订'}</Button></div>
      {openDoc?.id === document.id && <div className="space-y-3 border-t pt-3">
        {openDoc.revisions.slice().reverse().map((revision) => <div key={revision.version} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"><span>版本 {revision.version} · {new Date(revision.created_at).toLocaleString()}</span><a className="underline underline-offset-4" href={`/api/artifacts/${revision.artifact.id}/download`}>下载 {revision.artifact.name}</a></div>)}
        <form className="space-y-2" onSubmit={(event) => { void reviseDocument(event) }}>
          <label className="block space-y-2 text-sm"><span>继续修改（生成新版本）</span><textarea className={field} rows={5} value={docEdit} onChange={(event) => setDocEdit(event.target.value)} disabled={!!busy} required /></label>
          <Button type="submit" disabled={!!busy} className="min-h-11">保存新版本</Button>
        </form>
      </div>}
    </Card>)}</div>}

    <Card className="p-5"><details><summary className="cursor-pointer font-medium">新建页面</summary>
      <form className="mt-4 space-y-3" onSubmit={(event) => { void createPage(event) }}>
        <label className="block space-y-2 text-sm"><span>标题</span><input className={field} value={pageTitle} onChange={(event) => setPageTitle(event.target.value)} maxLength={200} required disabled={!!busy} /></label>
        <label className="block space-y-2 text-sm"><span>正文，空行分段</span><textarea className={field} rows={4} value={pageTextInput} onChange={(event) => setPageTextInput(event.target.value)} required disabled={!!busy} /></label>
        <Button type="submit" disabled={!!busy} className="min-h-11">{busy === 'page' ? '创建中…' : '创建页面'}</Button>
      </form>
    </details></Card>

    {pages === undefined ? <p role="status" className="text-sm text-muted-foreground">正在读取页面…</p> : !pages.length ? <p className="text-sm text-muted-foreground">还没有页面。</p> : <div className="space-y-3">{pages.map((page) => <Card key={page.id} className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><h3 className="break-words font-medium">{page.title}</h3><p className="text-xs text-muted-foreground">版本 {page.version} · {new Date(page.updated_at).toLocaleString()}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" className="min-h-11" onClick={() => { void expandPage(page.id) }}>{openPage?.id === page.id ? '收起' : '查看与修订'}</Button><Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void publish(page.id) }}>发布</Button><Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void unpublish(page.id) }}>撤销分享</Button></div></div>
      {published[page.id] && <p className="text-sm"><a className="underline underline-offset-4" href={published[page.id]} target="_blank" rel="noreferrer">{location.origin}{published[page.id]}</a></p>}
      {openPage?.id === page.id && <div className="space-y-3 border-t pt-3">
        <p className="text-xs text-muted-foreground">{openPage.revisions.length} 个版本 · {openPage.publications.length} 个有效公开链接</p>
        {!textOnly && <p className="text-sm text-muted-foreground">此页面包含图表、指标或表格，界面只展示文本编辑；结构化内容请通过 API 或 Bot 工具更新。</p>}
        <form className="space-y-2" onSubmit={(event) => { void updatePage(event) }}>
          <label className="block space-y-2 text-sm"><span>页面文本</span><textarea className={field} rows={6} value={pageEdit} onChange={(event) => setPageEdit(event.target.value)} disabled={!!busy || !textOnly} required /></label>
          <Button type="submit" disabled={!!busy || !textOnly} className="min-h-11">保存新版本</Button>
        </form>
        <Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void removePage(page.id) }}>删除页面</Button>
      </div>}
    </Card>)}</div>}
  </div>
}
