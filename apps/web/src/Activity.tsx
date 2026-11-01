import { useEffect, useRef, useState, type FormEvent } from 'react'

import { api, type Profile } from './api/client'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card } from './components/ui/card'

type Status = 'awaiting_approval' | 'ready' | 'sending' | 'confirmed' | 'unknown' | 'rejected' | 'expired' | 'failed'
interface Action {
  id: string
  target_ref: string
  payload: { message: string }
  payload_hash: string
  revision: number
  status: Status
  reason: string
}
interface Policy { id: string; target_ref: string; hourly_limit: number; active: boolean }
const labels: Record<Status, string> = { awaiting_approval: '等待确认', ready: '等待执行', sending: '执行中', confirmed: '模拟已确认', unknown: '结果待核对', rejected: '已拒绝', expired: '授权已失效', failed: '失败' }
const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const reason = (error: unknown) => error instanceof Error ? error.message : '请求失败'

function ActionCard({ action, refresh }: { action: Action; refresh: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ text: string; revision: number } | null>(null)
  async function decide(decision: 'approved' | 'rejected') {
    setBusy(true)
    setError('')
    try {
      await api(`/api/actions/${action.id}/decision`, 'POST', { revision: action.revision, payloadHash: action.payload_hash, decision })
      refresh()
    } catch (error) { setError(reason(error)); refresh() } finally { setBusy(false) }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/actions/${action.id}`, 'PATCH', { message: editing.text, revision: editing.revision })
      setEditing(null)
      refresh()
    } catch (error) { setError(reason(error)); refresh() } finally { setBusy(false) }
  }
  return <Card className="space-y-4 p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="break-words font-medium">发给 {action.target_ref}</h3><Badge tone={action.status === 'unknown' || action.status === 'failed' ? 'danger' : 'neutral'}>{labels[action.status]}</Badge></div>
    <p className="text-xs text-muted-foreground">本地模拟账号 · 模拟发送</p>
    <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm leading-relaxed">{action.payload.message}</p>
    <p className="text-sm text-muted-foreground">{action.reason}</p>
    {action.status === 'unknown' && <p className="text-sm text-destructive">结果尚不明确，这条动作不会自动重试。</p>}
    {editing ? <form className="space-y-3" onSubmit={(event) => { void save(event) }}>
      <label className="block space-y-2 text-sm"><span>修改后重新确认</span><textarea className={field} rows={3} maxLength={8000} required value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} disabled={busy} /></label>
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy} className="min-h-11">保存并重新审查</Button><Button variant="outline" disabled={busy} onClick={() => setEditing(null)} className="min-h-11">取消修改</Button></div>
    </form> : action.status === 'awaiting_approval' && <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => { void decide('approved') }} className="min-h-11">允许一次</Button>
      <Button variant="outline" disabled={busy} onClick={() => { void decide('rejected') }} className="min-h-11">拒绝</Button>
      <Button variant="outline" disabled={busy} onClick={() => setEditing({ text: action.payload.message, revision: action.revision })} className="min-h-11">修改内容</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </Card>
}

export function Activity({ profile }: { profile: Profile }) {
  const [actions, setActions] = useState<Action[]>()
  const [policies, setPolicies] = useState<Policy[]>([])
  const [target, setTarget] = useState('')
  const [message, setMessage] = useState('')
  const [ruleTarget, setRuleTarget] = useState('')
  const [limit, setLimit] = useState(5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const pending = useRef<{ target: string; message: string; id: string } | null>(null)
  const refresh = () => setRevision((value) => value + 1)

  useEffect(() => {
    const controller = new AbortController()
    let loading = false
    async function load() {
      if (loading) return
      loading = true
      try {
        const [activity, rules] = await Promise.all([
          api<{ actions: Action[] }>(`/api/profiles/${profile.id}/actions`, 'GET', undefined, controller.signal),
          api<{ policies: Policy[] }>(`/api/profiles/${profile.id}/policies`, 'GET', undefined, controller.signal),
        ])
        if (!controller.signal.aborted) { setActions(activity.actions); setPolicies(rules.policies) }
      } catch (error) { if (!controller.signal.aborted) setError(reason(error)) }
      finally { loading = false }
    }
    void load()
    const timer = setInterval(() => { void load() }, 1000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [profile.id, revision])

  async function propose(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const old = pending.current
    const attempt = old?.target === target && old.message === message ? old : { target, message, id: crypto.randomUUID() }
    pending.current = attempt
    try {
      await api(`/api/profiles/${profile.id}/actions`, 'POST', { target, message, triggerId: attempt.id })
      pending.current = null
      setMessage('')
      refresh()
    } catch (error) { setError(reason(error)) } finally { setBusy(false) }
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api(`/api/profiles/${profile.id}/policies`, 'POST', { target: ruleTarget, hourlyLimit: limit })
      setRuleTarget('')
      refresh()
    } catch (error) { setError(reason(error)) } finally { setBusy(false) }
  }

  async function revoke(id: string) {
    try { await api(`/api/policies/${id}`, 'DELETE'); refresh() }
    catch (error) { setError(reason(error)) }
  }

  return <div className="space-y-5" aria-label={`${profile.name}的活动`}>
    <header><h2 className="text-xl font-semibold">{profile.name}的活动</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">在本地验证自动执行与审批流程。这里显示的发送和回执均为模拟。</p></header>
    <Card className="p-5"><details><summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">试一次模拟动作</summary>
      <form className="mt-4 space-y-3" onSubmit={(event) => { void propose(event) }}>
        <label className="block space-y-2 text-sm"><span>模拟对象</span><input className={field} value={target} onChange={(event) => setTarget(event.target.value)} maxLength={160} required disabled={busy} placeholder="例如：项目讨论组" /></label>
        <label className="block space-y-2 text-sm"><span>拟发送的内容</span><textarea className={field} rows={3} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={8000} required disabled={busy} /></label>
        <Button type="submit" disabled={busy} className="min-h-11">创建模拟动作</Button>
      </form>
    </details></Card>
    <Card className="space-y-4 p-5"><h3 className="font-medium">自动执行范围</h3>
      {policies.filter((policy) => policy.active).map((policy) => <div key={policy.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"><p className="min-w-0 break-words">{policy.target_ref} · 每小时最多 {policy.hourly_limit} 次模拟发送</p><Button variant="outline" size="sm" className="min-h-11" onClick={() => { void revoke(policy.id) }}>撤销规则</Button></div>)}
      {!policies.some((policy) => policy.active) && <p className="text-sm text-muted-foreground">尚未设置。默认每条动作都需要你确认。</p>}
      <details><summary className="cursor-pointer text-sm font-medium">添加一个明确范围</summary>
        <form onSubmit={(event) => { void saveRule(event) }} className="mt-4 space-y-3">
          <label className="block space-y-2 text-sm"><span>允许的模拟对象</span><input className={field} maxLength={160} required value={ruleTarget} onChange={(event) => setRuleTarget(event.target.value)} disabled={busy} /></label>
          <label className="block space-y-2 text-sm"><span>每小时最多</span><input className={field} type="number" min={1} max={100} required value={limit} onChange={(event) => setLimit(Number(event.target.value))} disabled={busy} /></label>
          <p className="text-xs leading-relaxed text-muted-foreground">仅允许{profile.name}使用本地模拟账号，对“{ruleTarget || '指定对象'}”每小时自动执行最多 {limit} 次。其他对象仍需确认。</p>
          <Button type="submit" className="min-h-11" disabled={busy}>允许此范围自动执行</Button>
        </form>
      </details>
    </Card>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {actions === undefined ? <p role="status" className="text-sm text-muted-foreground">正在读取活动…</p> : !actions.length ? <p className="py-8 text-center text-sm text-muted-foreground">还没有动作。可以先创建一条模拟动作，体验确认流程。</p> : actions.map((action) => <ActionCard key={action.id} action={action} refresh={refresh} />)}
  </div>
}
