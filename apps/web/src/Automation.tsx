import { useEffect, useState, type FormEvent } from 'react'

import { api, type Profile } from './api/client'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card } from './components/ui/card'

interface Routine {
  id: string
  profile_id: string
  name: string
  instruction: string
  revision: number
  timezone: string
  next_due_at: string | null
  status: 'active' | 'paused' | 'completed'
  pause_reason: string | null
  describe: string
  missed_policy: 'skip' | 'coalesce' | 'catch_up'
  budget_tokens: number
  delivery: { kind: 'web_owner' | 'qq_private' | 'qq_group'; groupId?: string }
}

interface Occurrence {
  id: string
  status: 'pending' | 'dispatched' | 'done' | 'failed' | 'skipped'
  scheduled_for: string
  logical_occurrence: string
  input_tokens: number
  output_tokens: number
  result: string | null
  last_error: string | null
}

const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const reason = (error: unknown) => error instanceof Error ? error.message : '请求失败'
const labels: Record<Routine['status'], string> = { active: '运行中', paused: '已暂停', completed: '已结束' }
const occurrenceLabels: Record<Occurrence['status'], string> = {
  pending: '等待派发', dispatched: '执行中', done: '完成', failed: '失败', skipped: '跳过',
}

export function Automation({ profile, timezone }: { profile: Profile; timezone: string }) {
  const [routines, setRoutines] = useState<Routine[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [kind, setKind] = useState<'once' | 'interval' | 'daily' | 'event' | 'webhook'>('daily')
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [clock, setClock] = useState('09:00')
  const [minutes, setMinutes] = useState(60)
  const [eventName, setEventName] = useState('')
  const [on, setOn] = useState('')
  const [missed, setMissed] = useState<'skip' | 'coalesce' | 'catch_up'>('skip')
  const [budget, setBudget] = useState(0)
  const [delivery, setDelivery] = useState<'web_owner' | 'qq_private' | 'qq_group'>('web_owner')
  const [groupId, setGroupId] = useState('')
  const [open, setOpen] = useState<string>('')
  const [history, setHistory] = useState<Record<string, Occurrence[]>>({})

  const load = () => {
    setError('')
    void api<{ routines: Routine[] }>(`/api/profiles/${profile.id}/routines`).then((result) => setRoutines(result.routines))
      .catch((error: unknown) => setError(reason(error)))
  }
  useEffect(() => {
    void api<{ routines: Routine[] }>(`/api/profiles/${profile.id}/routines`).then((result) => setRoutines(result.routines))
      .catch((error: unknown) => setError(reason(error)))
  }, [profile.id])

  function trigger() {
    if (kind === 'once') return { kind, at: new Date(on).toISOString() }
    if (kind === 'interval') return { kind, everyMinutes: minutes }
    if (kind === 'daily') return { kind, at: clock }
    if (kind === 'event') return { kind, name: eventName }
    return { kind }
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy('create')
    setError('')
    try {
      await api(`/api/profiles/${profile.id}/routines`, 'POST', {
        name, instruction, trigger: trigger(), timezone, missedPolicy: missed, budgetTokens: budget,
        delivery: delivery === 'qq_group' ? { kind: delivery, groupId } : { kind: delivery },
      })
      setName('')
      setInstruction('')
      load()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function act(id: string, action: 'pause' | 'resume' | 'delete' | 'run') {
    setBusy(id)
    setError('')
    try {
      if (action === 'delete') await api(`/api/routines/${id}`, 'DELETE')
      else if (action === 'run') await api(`/api/routines/${id}/run`, 'POST', { clientRequestId: crypto.randomUUID() })
      else await api(`/api/routines/${id}/${action}`, 'POST')
      load()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function showHistory(id: string) {
    if (open === id) { setOpen(''); return }
    setOpen(id)
    try {
      const result = await api<{ occurrences: Occurrence[] }>(`/api/routines/${id}/occurrences`)
      setHistory((previous) => ({ ...previous, [id]: result.occurrences }))
    } catch (error) { setError(reason(error)) }
  }

  return <div className="space-y-5" aria-label={`${profile.name}的例行任务`}>
    <header><h2 className="text-xl font-semibold">{profile.name}的例行任务</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">按计划把任务投递到已有会话。暂停只停止未来触发，不会撤回已经开始的回合。</p></header>
    <Card className="p-5"><details><summary className="cursor-pointer font-medium">新建例行任务</summary>
      <form className="mt-4 space-y-3" onSubmit={(event) => { void create(event) }}>
        <label className="block space-y-2 text-sm"><span>名称</span><input className={field} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={!!busy} /></label>
        <label className="block space-y-2 text-sm"><span>任务说明</span><textarea className={field} rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={8000} required disabled={!!busy} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-2 text-sm"><span>触发方式</span><select className={field} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} disabled={!!busy}>
            <option value="daily">每天</option><option value="interval">固定间隔</option><option value="once">只执行一次</option><option value="event">具名事件</option><option value="webhook">webhook</option>
          </select></label>
          <label className="block space-y-2 text-sm"><span>时区</span><input className={field} value={timezone} readOnly disabled /></label>
        </div>
        {kind === 'daily' && <label className="block space-y-2 text-sm"><span>每天时间</span><input type="time" className={field} value={clock} onChange={(event) => setClock(event.target.value)} required disabled={!!busy} /></label>}
        {kind === 'interval' && <label className="block space-y-2 text-sm"><span>间隔分钟</span><input type="number" min={1} max={10080} className={field} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} required disabled={!!busy} /></label>}
        {kind === 'once' && <label className="block space-y-2 text-sm"><span>执行时间</span><input type="datetime-local" className={field} value={on} onChange={(event) => setOn(event.target.value)} required disabled={!!busy} /></label>}
        {kind === 'event' && <label className="block space-y-2 text-sm"><span>事件名称</span><input className={field} value={eventName} onChange={(event) => setEventName(event.target.value)} maxLength={80} required disabled={!!busy} /></label>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-2 text-sm"><span>错过运行</span><select className={field} value={missed} onChange={(event) => setMissed(event.target.value as typeof missed)} disabled={!!busy}>
            <option value="skip">跳过</option><option value="coalesce">合并为一次</option><option value="catch_up">限量补跑</option>
          </select></label>
          <label className="block space-y-2 text-sm"><span>24 小时 token 预算（0 不限）</span><input type="number" min={0} max={10000000} className={field} value={budget} onChange={(event) => setBudget(Number(event.target.value))} disabled={!!busy} /></label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-2 text-sm"><span>送达目标</span><select className={field} value={delivery} onChange={(event) => setDelivery(event.target.value as typeof delivery)} disabled={!!busy}>
            <option value="web_owner">工作台私聊</option><option value="qq_private">QQ 私聊</option><option value="qq_group">QQ 群</option>
          </select></label>
          {delivery === 'qq_group' && <label className="block space-y-2 text-sm"><span>群号</span><input className={field} value={groupId} onChange={(event) => setGroupId(event.target.value)} maxLength={20} required disabled={!!busy} /></label>}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={!!busy} className="min-h-11">{busy === 'create' ? '创建中…' : '创建任务'}</Button>
      </form>
    </details></Card>
    {routines === undefined ? <p role="status" className="text-sm text-muted-foreground">正在读取例行任务…</p> : !routines.length ? <p className="py-8 text-center text-sm text-muted-foreground">还没有例行任务。</p> : routines.map((routine) => <Card key={routine.id} className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words font-medium">{routine.name}</h3><p className="mt-1 break-words text-sm text-muted-foreground">{routine.describe} · {routine.timezone}</p></div><Badge tone={routine.status === 'active' ? 'success' : routine.status === 'paused' ? 'danger' : 'neutral'}>{labels[routine.status]}</Badge></div>
      <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{routine.instruction}</p>
      <p className="text-xs text-muted-foreground">下次：{routine.next_due_at ? new Date(routine.next_due_at).toLocaleString() : '无'}{routine.pause_reason ? ` · ${routine.pause_reason}` : ''}{routine.budget_tokens ? ` · 预算 ${routine.budget_tokens}` : ''}</p>
      <div className="flex flex-wrap gap-2">
        {routine.status === 'active' && <Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void act(routine.id, 'pause') }}>暂停</Button>}
        {routine.status === 'paused' && <Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void act(routine.id, 'resume') }}>恢复</Button>}
        <Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void act(routine.id, 'run') }}>立即运行</Button>
        <Button variant="outline" size="sm" className="min-h-11" onClick={() => { void showHistory(routine.id) }}>{open === routine.id ? '收起历史' : '运行历史'}</Button>
        <Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void act(routine.id, 'delete') }}>删除</Button>
      </div>
      {open === routine.id && <div className="space-y-2 border-t pt-3">{(history[routine.id] ?? []).map((item) => <div key={item.id} className="rounded-md border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>{new Date(item.scheduled_for).toLocaleString()}</span><Badge tone={item.status === 'done' ? 'success' : item.status === 'failed' ? 'danger' : 'neutral'}>{occurrenceLabels[item.status]}</Badge></div>{item.result && <p className="mt-2 break-words">{item.result}</p>}{item.last_error && <p className="mt-2 break-words text-destructive">{item.last_error}</p>}<p className="mt-2 text-xs text-muted-foreground">token {item.input_tokens + item.output_tokens}</p></div>)}{!(history[routine.id] ?? []).length && <p className="text-sm text-muted-foreground">还没有运行记录。</p>}</div>}
    </Card>)}
  </div>
}
