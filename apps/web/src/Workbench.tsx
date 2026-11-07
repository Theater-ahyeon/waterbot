import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

import { api, type ChatSnapshot, type Profile } from './api/client'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card } from './components/ui/card'
import { useHealth } from './hooks/useHealth'
import { Activity } from './Activity'
import { Automation } from './Automation'
import { Library } from './Library'
import { SettingsPanel, type SettingsValue } from './Settings'
import { Tools } from './Tools'

const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const reason = (error: unknown) => error instanceof Error ? error.message : '发生错误，请重试'

export function HealthStatus() {
  const { state, refresh } = useHealth()
  return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <span role="status" data-testid="health-status">{state.status === 'success' ? '已连接' : state.status === 'loading' ? '连接中' : '连接失败'}</span>
    {state.status === 'success' && <span data-testid="health-details">{state.payload.service} · {Math.floor(state.payload.uptimeSeconds)} 秒</span>}
    {state.status === 'error' && <span data-testid="health-error">{state.message}</span>}
    {state.status !== 'loading' && <Button size="sm" variant="outline" onClick={refresh}>重新检查</Button>}
  </div>
}

function ProfileForm({ profile, onSave, onCancel }: { profile?: Profile; onSave: (profile: Profile) => void; onCancel: () => void }) {
  const id = useId()
  const [name, setName] = useState(profile?.name ?? '')
  const [instructions, setInstructions] = useState(profile?.instructions ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [expectedRevision] = useState(profile?.revision)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const saved = await api<Profile>(profile ? `/api/profiles/${profile.id}` : '/api/profiles', profile ? 'PATCH' : 'POST', { name, instructions, ...(profile ? { revision: expectedRevision } : {}) })
      onSave(saved)
    } catch (error) { setError(reason(error)) } finally { setBusy(false) }
  }
  return <form onSubmit={(event) => { void submit(event) }} className="space-y-3 rounded-lg border bg-muted p-4" aria-label={profile ? '编辑人格' : '新建人格'}>
    <div><label htmlFor={`${id}-name`} className="mb-1 block text-sm font-medium">人格名称</label>
      <input id={`${id}-name`} className={field} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={busy} /></div>
    <div><label htmlFor={`${id}-instructions`} className="mb-1 block text-sm font-medium">人格设定</label>
      <textarea id={`${id}-instructions`} className={field} rows={4} value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={8000} disabled={busy} /></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy} className="min-h-11">{busy ? '保存中…' : '保存人格'}</Button><Button variant="outline" onClick={onCancel} disabled={busy} className="min-h-11">取消</Button></div>
  </form>
}

function Conversation({ onLogout }: { onLogout: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [activeId, setActiveId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [view, setView] = useState<ChatSnapshot>()
  const [error, setError] = useState('')
  const [streamError, setStreamError] = useState('')
  const [sending, setSending] = useState('')
  const [retry, setRetry] = useState(0)
  const [form, setForm] = useState<'create' | 'edit' | null>(null)
  const [tab, setTab] = useState<'chat' | 'activity' | 'automation' | 'library' | 'tools' | 'settings'>('chat')
  const [settings, setSettings] = useState<SettingsValue>()
  const [profileRevision, setProfileRevision] = useState(0)
  const pending = useRef(new Map<string, { text: string; nonce: string }>())
  const active = profiles.find((profile) => profile.id === activeId)
  const timezone = settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const current = view?.profile.id === activeId ? view : undefined

  useEffect(() => {
    const controller = new AbortController()
    void api<{ profiles: Profile[] }>('/api/profiles', 'GET', undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!Array.isArray(result.profiles)) throw new Error('人格列表无效')
      setProfiles(result.profiles)
      setActiveId((previous) => result.profiles.some((profile) => profile.id === previous) ? previous : result.profiles[0]?.id ?? '')
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(reason(error)) })
    return () => controller.abort()
  }, [profileRevision])

  useEffect(() => {
    const controller = new AbortController()
    void api<SettingsValue>('/api/settings', 'GET', undefined, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setSettings(value) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (!settings) return
    if (settings.theme === 'system') delete root.dataset.theme
    else root.dataset.theme = settings.theme
    root.dataset.density = settings.density
  }, [settings])

  useEffect(() => {
    if (!activeId) return
    let closed = false
    const stream = new EventSource(`/api/profiles/${activeId}/events`)
    stream.addEventListener('snapshot', (event: MessageEvent<string>) => {
      if (closed) return
      try {
        const next = JSON.parse(event.data) as ChatSnapshot
        if (next.profile.id !== activeId || !Array.isArray(next.messages)) throw new Error('会话更新无效')
        setView(next)
        setStreamError('')
        setProfiles((previous) => previous.map((profile) => profile.id === next.profile.id && profile.revision !== next.profile.revision ? next.profile : profile))
      } catch (error) { setStreamError(reason(error)) }
    })
    stream.onerror = () => { if (!closed) setStreamError('更新连接已断开，正在重连；也可退出后重新登录。') }
    stream.addEventListener('failure', () => { if (!closed) setStreamError('服务暂时无法更新，请重试。') })
    return () => { closed = true; stream.close() }
  }, [activeId, retry])

  async function send(event: FormEvent) {
    event.preventDefault()
    const id = activeId
    const text = drafts[id] ?? ''
    if (!text.trim() || sending) return
    const previous = pending.current.get(id)
    const request = previous?.text === text ? previous : { text, nonce: crypto.randomUUID() }
    pending.current.set(id, request)
    setSending(id)
    setError('')
    try {
      await api(`/api/profiles/${id}/messages`, 'POST', { message: text, clientRequestId: request.nonce })
      pending.current.delete(id)
      setDrafts((previous) => previous[id] === text ? { ...previous, [id]: '' } : previous)
    } catch (error) { setError(reason(error)) } finally { setSending('') }
  }

  function saved(profile: Profile) {
    setProfiles((previous) => previous.some((item) => item.id === profile.id) ? previous.map((item) => item.id === profile.id ? profile : item) : [...previous, profile])
    setActiveId(profile.id)
    setForm(null)
  }

  return <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
    <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div><p className="mb-1 text-xs text-muted-foreground">你的个人工作台</p><h1 className="text-2xl font-semibold tracking-tight">Waterbot</h1></div>
      <div className="flex flex-wrap items-center gap-3"><Badge tone="neutral">本地演示模型</Badge><Button variant="outline" onClick={onLogout} className="min-h-11">退出登录</Button></div>
    </header>
    <nav aria-label="工作台功能" className="mb-5 flex flex-wrap gap-2">
      <Button variant={tab === 'chat' ? 'default' : 'outline'} aria-pressed={tab === 'chat'} onClick={() => setTab('chat')} className="min-h-11">对话</Button>
      <Button variant={tab === 'activity' ? 'default' : 'outline'} aria-pressed={tab === 'activity'} onClick={() => setTab('activity')} className="min-h-11">活动与审批</Button>
      <Button variant={tab === 'automation' ? 'default' : 'outline'} aria-pressed={tab === 'automation'} onClick={() => setTab('automation')} className="min-h-11">例行任务</Button>
      <Button variant={tab === 'library' ? 'default' : 'outline'} aria-pressed={tab === 'library'} onClick={() => setTab('library')} className="min-h-11">资料库</Button>
      <Button variant={tab === 'tools' ? 'default' : 'outline'} aria-pressed={tab === 'tools'} onClick={() => setTab('tools')} className="min-h-11">工具与执行</Button>
      <Button variant={tab === 'settings' ? 'default' : 'outline'} aria-pressed={tab === 'settings'} onClick={() => setTab('settings')} className="min-h-11">设置与组织</Button>
    </nav>
    <div className="grid min-w-0 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-4">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold">我的人格</h2>
          <nav aria-label="切换人格" className="flex flex-wrap gap-2 lg:flex-col">
            {profiles.map((profile, index) => <button key={profile.id} type="button" aria-pressed={activeId === profile.id} onClick={() => { setActiveId(profile.id); setForm(null); setError(''); setStreamError('') }} className={`flex min-h-11 min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${activeId === profile.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}>
              <span aria-hidden="true" className="shrink-0 opacity-60">{String(index + 1).padStart(2, '0')}</span><span className="break-words">{profile.name}</span>
            </button>)}
          </nav>
          {!profiles.length && <p className="text-sm text-muted-foreground">正在读取人格…</p>}
          <Button variant="outline" className="mt-4 min-h-11 w-full" onClick={() => { setForm('create'); setTab('chat') }}>新建人格</Button>
        </Card>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">每个人格拥有独立的对话。记忆共享功能将在后续加入。</p>
      </aside>
      <section className="min-w-0 space-y-4" aria-label="工作台内容">
        {tab === 'activity' && (active ? <Activity key={activeId} profile={active} /> : <p className="text-sm text-muted-foreground">请先选择一个人格。</p>)}
        {tab === 'automation' && (active ? <Automation key={activeId} profile={active} timezone={timezone} /> : <p className="text-sm text-muted-foreground">请先选择一个人格。</p>)}
        {tab === 'library' && (active ? <Library key={activeId} profile={active} /> : <p className="text-sm text-muted-foreground">请先选择一个人格。</p>)}
        {tab === 'tools' && (active ? <Tools key={activeId} profile={active} /> : <p className="text-sm text-muted-foreground">请先选择一个人格。</p>)}
        {tab === 'settings' && <SettingsPanel active={active} settings={settings} onSettings={setSettings} onProfiles={() => setProfileRevision((value) => value + 1)} />}
        {tab === 'chat' && <>
        {form && <ProfileForm key={form === 'edit' ? activeId : 'new'} profile={form === 'edit' ? active : undefined} onSave={saved} onCancel={() => setForm(null)} />}
        <Card className="flex min-h-[520px] min-w-0 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
            <div className="min-w-0"><h2 className="break-words text-lg font-semibold">{active?.name ?? '准备对话'}</h2><p className="mt-1 max-w-xl break-words text-xs leading-relaxed text-muted-foreground">{active?.instructions}</p></div>
            <Button variant="outline" size="sm" disabled={!active} onClick={() => setForm('edit')} className="min-h-11">编辑设定</Button>
          </div>
          <div role="log" aria-label={active ? `${active.name}的对话` : '对话记录'} aria-live="polite" className="max-h-[60dvh] min-h-64 flex-1 space-y-5 overflow-y-auto p-5">
            {!current ? <p className="text-sm text-muted-foreground">正在连接当前人格…</p> : !current.messages.length ? <div className="py-14 text-center"><p className="font-medium">从一句话开始</p><p className="mt-2 text-sm text-muted-foreground">告诉{active?.name}你现在想聊什么。</p></div> : current.messages.map((message) => <article key={message.id} className={`max-w-[94%] rounded-lg px-4 py-3 sm:max-w-[85%] ${message.role === 'user' ? 'ml-auto bg-muted' : 'border bg-background'}`}>
              <p className="mb-2 text-xs font-medium text-muted-foreground">{message.role === 'user' ? '你' : active?.name}</p><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.text}</p>
            </article>)}
            {!!current?.pending && <p role="status" className="text-sm text-muted-foreground">正在回复 · {current.pending} 条待完成</p>}
            {current?.failed && <p className="text-sm text-destructive">有回复未能完成，你可以重新发送。</p>}
          </div>
          <form onSubmit={(event) => { void send(event) }} className="space-y-3 border-t p-4 sm:p-5">
            <label htmlFor="message" className="sr-only">发给{active?.name ?? '当前人格'}的消息</label>
            <textarea id="message" className={`${field} min-h-24 resize-y`} value={drafts[activeId] ?? ''} onChange={(event) => setDrafts((previous) => ({ ...previous, [activeId]: event.target.value }))} maxLength={8000} disabled={!active} placeholder="写下你的想法…" />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {streamError && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><span>{streamError}</span><Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>重连</Button></div>}
            <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">当前为演示回复，不连接外部模型。</p><Button type="submit" className="min-h-11" disabled={!active || !!sending || !(drafts[activeId] ?? '').trim()}>{sending === activeId ? '发送中…' : '发送消息'}</Button></div>
          </form>
        </Card>
        </>}
      </section>
    </div>
    <footer className="mt-6"><HealthStatus /></footer>
  </main>
}

export function Workbench() {
  const [session, setSession] = useState<'loading' | 'guest' | 'owner' | 'error'>('loading')
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void api<{ authenticated: boolean }>('/api/session', 'GET', undefined, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      if (typeof value.authenticated !== 'boolean') throw new Error('登录状态无效')
      setSession(value.authenticated ? 'owner' : 'guest')
    }).catch((error: unknown) => { if (!controller.signal.aborted) { setError(reason(error)); setSession('error') } })
    return () => controller.abort()
  }, [retry])
  async function login(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try { await api('/api/login', 'POST', { key }); setKey(''); setSession('owner') }
    catch (error) { setError(reason(error)) } finally { setBusy(false) }
  }
  async function logout() {
    try { await api('/api/logout', 'POST'); setSession('guest'); setError('') }
    catch (error) { setError(reason(error)) }
  }
  if (session === 'owner') return <><Conversation onLogout={() => { void logout() }} />{error && <p role="alert" className="mx-auto max-w-xl p-4 text-destructive">{error}</p>}</>
  return <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-5 py-10">
    <header><p className="mb-2 text-xs text-muted-foreground">你的个人工作台</p><h1 className="text-3xl font-semibold tracking-tight">Waterbot</h1><p className="mt-3 text-sm leading-relaxed text-muted-foreground">不同人格，各自记得与你的对话。</p></header>
    <Card className="p-6">
      {session === 'loading' ? <p role="status">正在连接本机服务…</p> : session === 'error' ? <div className="space-y-4"><p role="alert" className="text-sm text-destructive">{error}</p><Button onClick={() => setRetry((value) => value + 1)}>重新连接</Button></div> : <form onSubmit={(event) => { void login(event) }} className="space-y-4">
        <div><label htmlFor="owner-key" className="mb-2 block text-sm font-medium">本机访问码</label><input id="owner-key" type="password" className={field} value={key} onChange={(event) => setKey(event.target.value)} autoComplete="current-password" required disabled={busy} aria-describedby="login-help" /></div>
        <p id="login-help" className="break-words text-xs leading-relaxed text-muted-foreground">首次使用：从本机项目的 apps/server/data/owner-key 文件复制访问码。它只用于保护这个工作台，请勿分享。</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !key.trim()} className="min-h-11 w-full">{busy ? '登录中…' : '进入工作台'}</Button>
      </form>}
    </Card>
    <HealthStatus />
  </main>
}
