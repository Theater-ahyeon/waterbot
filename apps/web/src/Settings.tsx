import { useEffect, useState, type FormEvent } from 'react'

import { api, type Profile } from './api/client'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card } from './components/ui/card'

interface Template { id: string; name: string; description: string; instructions: string }
export interface SettingsValue { timezone: string; theme: 'light' | 'dark' | 'system'; density: 'comfortable' | 'compact'; notifications: boolean }
interface UsageDay { day: string; input: number; output: number; costUsd: number }
interface SearchItem { id: string; title: string; detail: string; profileId?: string; timestamp: string }
interface SearchGroup { kind: string; label: string; items: SearchItem[] }
interface StatusPayload {
  queue: { pendingOutbox: number; dispatchedJobs: number; failedJobs: number }
  routines?: { active: number; paused: number; due: number }
  usage: { input: number; output: number; costUsd: number }
}

const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const reason = (error: unknown) => error instanceof Error ? error.message : '请求失败'

export function SettingsPanel({
  active, settings, onSettings, onProfiles,
}: {
  active?: Profile
  settings?: SettingsValue
  onSettings: (value: SettingsValue) => void
  onProfiles: () => void
}) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [allProfiles, setAllProfiles] = useState<Profile[]>()
  const [usage, setUsage] = useState<UsageDay[]>([])
  const [status, setStatus] = useState<StatusPayload>()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchGroup[]>()
  const [templateId, setTemplateId] = useState('')
  const [newName, setNewName] = useState('')
  const [copyName, setCopyName] = useState('')
  const [includeSkills, setIncludeSkills] = useState(false)
  const [draft, setDraft] = useState<SettingsValue>()
  const form = draft ?? settings ?? { timezone: 'Asia/Shanghai', theme: 'system', density: 'comfortable', notifications: true }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const loadProfiles = () => {
    void api<{ profiles: Profile[] }>('/api/profiles?includeArchived=1').then((result) => setAllProfiles(result.profiles))
      .catch((error: unknown) => setError(reason(error)))
  }
  useEffect(() => {
    loadProfiles()
    void api<{ templates: Template[] }>('/api/templates').then((result) => setTemplates(result.templates)).catch((error: unknown) => setError(reason(error)))
    void api<StatusPayload>('/api/status').then(setStatus).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!active) return
    void api<{ days: UsageDay[] }>(`/api/profiles/${active.id}/usage`).then((result) => setUsage(result.days))
      .catch((error: unknown) => setError(reason(error)))
  }, [active])

  async function saveSettings(event: FormEvent) {
    event.preventDefault()
    setBusy('settings')
    setError('')
    try {
      const saved = await api<SettingsValue>('/api/settings', 'PUT', form)
      setDraft(undefined)
      onSettings(saved)
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function createFromTemplate(event: FormEvent) {
    event.preventDefault()
    setBusy('template')
    setError('')
    try {
      await api('/api/profiles', 'POST', { name: newName, templateId })
      setNewName('')
      loadProfiles()
      onProfiles()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function copy(id: string) {
    setBusy(id)
    setError('')
    try {
      await api(`/api/profiles/${id}/copy`, 'POST', { includeSkills, ...(copyName.trim() ? { name: copyName.trim() } : {}) })
      setCopyName('')
      loadProfiles()
      onProfiles()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function archive(id: string) {
    setBusy(id)
    setError('')
    try {
      await api(`/api/profiles/${id}`, 'DELETE')
      loadProfiles()
      onProfiles()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function restore(id: string) {
    setBusy(id)
    setError('')
    try {
      await api(`/api/profiles/${id}/restore`, 'POST')
      loadProfiles()
      onProfiles()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function search(event: FormEvent) {
    event.preventDefault()
    if (!query.trim()) { setResults([]); return }
    setBusy('search')
    setError('')
    try {
      const result = await api<{ groups: SearchGroup[] }>(`/api/search?q=${encodeURIComponent(query.trim())}`)
      setResults(result.groups)
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  return <div className="space-y-5" aria-label="工作台设置">
    <header><h2 className="text-xl font-semibold">设置与组织</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">人格复制只带设定文本和显式选择的技能；归档保留全部历史，不物理删除。</p></header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    <Card className="space-y-4 p-5"><h3 className="font-medium">统一搜索</h3>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { void search(event) }}>
        <label className="min-w-0 flex-1"><span className="sr-only">搜索工作台</span><input className={field} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder="搜索人格、记忆、技能、任务、页面、文档、执行和群消息" /></label>
        <Button type="submit" className="min-h-11" disabled={busy === 'search'}>搜索</Button>
      </form>
      {results && (results.length ? <div className="space-y-3">{results.map((group) => <div key={group.kind}><h4 className="mb-2 text-sm font-medium">{group.label}</h4><div className="space-y-2">{group.items.map((item) => <div key={`${group.kind}:${item.id}`} className="rounded-md border p-3 text-sm"><p className="break-words font-medium">{item.title}</p><p className="mt-1 break-words text-muted-foreground">{item.detail}</p></div>)}</div></div>)}</div> : <p className="text-sm text-muted-foreground">没有匹配结果。</p>)}
    </Card>

    <Card className="space-y-4 p-5"><h3 className="font-medium">从模板新建人格</h3>
      <form className="space-y-3" onSubmit={(event) => { void createFromTemplate(event) }}>
        <label className="block space-y-2 text-sm"><span>名称</span><input className={field} value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={80} required /></label>
        <label className="block space-y-2 text-sm"><span>模板</span><select className={field} value={templateId} onChange={(event) => setTemplateId(event.target.value)} required><option value="">选择模板</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}：{template.description}</option>)}</select></label>
        <Button type="submit" disabled={busy === 'template'} className="min-h-11">创建</Button>
      </form>
    </Card>

    <Card className="space-y-4 p-5"><h3 className="font-medium">人格组织</h3>
      <label className="block space-y-2 text-sm"><span>副本名称（留空自动生成）</span><input className={field} value={copyName} onChange={(event) => setCopyName(event.target.value)} maxLength={80} placeholder={active ? `${active.name} 副本` : ''} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeSkills} onChange={(event) => setIncludeSkills(event.target.checked)} />复制技能文本（不复制记忆、动作、页面、文档、例行任务和账号）</label>
      {allProfiles === undefined ? <p role="status" className="text-sm text-muted-foreground">正在读取人格…</p> : <div className="space-y-2">{allProfiles.map((profile) => <div key={profile.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"><div className="min-w-0"><p className="break-words font-medium">{profile.name}</p><p className="text-xs text-muted-foreground">{profile.archived_at ? `已归档 · ${new Date(profile.archived_at).toLocaleDateString()}` : `版本 ${profile.revision}`}</p></div><div className="flex flex-wrap gap-2">{(profile.archived_at === null || profile.archived_at === undefined) ? <><Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void copy(profile.id) }}>复制</Button><Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void archive(profile.id) }}>归档</Button></> : <Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void restore(profile.id) }}>恢复</Button>}</div></div>)}</div>}
    </Card>

    <Card className="space-y-4 p-5"><h3 className="font-medium">外观与通知</h3>
      <form className="space-y-3" onSubmit={(event) => { void saveSettings(event) }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-2 text-sm"><span>主题</span><select className={field} value={form.theme} onChange={(event) => setDraft({ ...form, theme: event.target.value as SettingsValue['theme'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <label className="block space-y-2 text-sm"><span>密度</span><select className={field} value={form.density} onChange={(event) => setDraft({ ...form, density: event.target.value as SettingsValue['density'] })}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
        </div>
        <label className="block space-y-2 text-sm"><span>时区</span><input className={field} value={form.timezone} onChange={(event) => setDraft({ ...form, timezone: event.target.value })} maxLength={80} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.notifications} onChange={(event) => setDraft({ ...form, notifications: event.target.checked })} />接收工作台通知</label>
        <Button type="submit" disabled={busy === 'settings'} className="min-h-11">保存设置</Button>
      </form>
    </Card>

    <Card className="space-y-3 p-5"><h3 className="font-medium">用量</h3>
      {active ? <><p className="text-sm text-muted-foreground">当前人格：{active.name}</p>{usage.length ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3">日期</th><th className="py-1 pr-3">输入</th><th className="py-1 pr-3">输出</th><th className="py-1">费用</th></tr></thead><tbody>{usage.map((day) => <tr key={day.day} className="border-t"><td className="py-1 pr-3">{day.day}</td><td className="py-1 pr-3">{day.input}</td><td className="py-1 pr-3">{day.output}</td><td className="py-1">{day.costUsd.toFixed(4)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-muted-foreground">最近没有模型用量。</p>}</> : <p className="text-sm text-muted-foreground">选择一个人格查看用量。</p>}
    </Card>

    <Card className="space-y-2 p-5"><h3 className="font-medium">数据与服务</h3>
      {status ? <div className="grid gap-2 text-sm sm:grid-cols-2"><p>待派发：{status.queue.pendingOutbox}</p><p>执行中：{status.queue.dispatchedJobs}</p><p>失败作业：{status.queue.failedJobs}</p><p>例行任务：{status.routines ? `${status.routines.active} 运行 / ${status.routines.paused} 暂停 / ${status.routines.due} 到期` : '未启用'}</p><p>最近 24 小时 token：{status.usage.input + status.usage.output}</p><p>估算费用：{status.usage.costUsd.toFixed(4)}</p></div> : <p className="text-sm text-muted-foreground">正在读取服务状态…</p>}
      <p className="text-xs leading-relaxed text-muted-foreground">备份和恢复仍通过本机命令 `npm run backup` / `npm run restore` 执行；工作台没有一键升级。</p>
      <Badge tone="neutral">本地单进程</Badge>
    </Card>
  </div>
}
