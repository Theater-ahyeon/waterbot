import { useEffect, useState, type FormEvent } from 'react'

import { api, type Profile } from './api/client'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card } from './components/ui/card'

interface Skill { id: string; name: string; description: string; body: string; version: number; status: 'draft' | 'active' }
interface McpServer { id: string; name: string; command: string; args: string[]; state: string; last_error: string | null; profile_ids: string[] }
interface McpTool { server_id: string; name: string; description: string; enabled: boolean }
interface Execution { id: string; status: string; command: string; output: string | null; exit_code: number | null; error: string | null; created_at: string }
interface Artifact { id: string; name: string; mime: string; size: string }
interface BrowserSurface { state: string; lease_holder: string; lease_version: number; current_url: string | null; title: string | null; last_error: string | null }
interface BrowserSnapshot {
  url: string
  title: string
  aria: string
  elements: { ref: string; tag: string; role: string; name: string; disabled: boolean }[]
  lease: { holder: string; version: number }
}
interface ConnectorStatus { provider: string; label: string; configured: boolean; detail: string }
interface VoiceStatus { configured: boolean; stt: boolean; tts: boolean }

const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const reason = (error: unknown) => error instanceof Error ? error.message : '请求失败'

function isSnapshot(value: unknown): value is BrowserSnapshot {
  return !!value && typeof value === 'object' && 'elements' in value
}
function isArtifact(value: unknown): value is Artifact {
  return !!value && typeof value === 'object' && 'storage_path' in value
}
function isSurface(value: unknown): value is BrowserSurface {
  return !!value && typeof value === 'object' && 'lease_holder' in value
}

function paramsOf(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象')
  return value as Record<string, unknown>
}

export function Tools({ profile }: { profile: Profile }) {
  const [skills, setSkills] = useState<Skill[]>()
  const [servers, setServers] = useState<McpServer[]>()
  const [executions, setExecutions] = useState<Execution[]>()
  const [tools, setTools] = useState<Record<string, McpTool[]>>({})
  const [artifacts, setArtifacts] = useState<Record<string, Artifact[]>>({})
  const [surface, setSurface] = useState<BrowserSurface | null>(null)
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>()
  const [browserUrl, setBrowserUrl] = useState('')
  const [browserRef, setBrowserRef] = useState('')
  const [browserText, setBrowserText] = useState('')
  const [shot, setShot] = useState<Artifact>()
  const [connectors, setConnectors] = useState<ConnectorStatus[]>()
  const [provider, setProvider] = useState('')
  const [operation, setOperation] = useState('')
  const [params, setParams] = useState('{}')
  const [connectorResult, setConnectorResult] = useState('')
  const [actionResult, setActionResult] = useState('')
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>()
  const [voiceText, setVoiceText] = useState('')
  const [voiceArtifact, setVoiceArtifact] = useState<Artifact>()
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [skillName, setSkillName] = useState('')
  const [skillBody, setSkillBody] = useState('')
  const [serverName, setServerName] = useState('')
  const [serverCommand, setServerCommand] = useState('')
  const [serverArgs, setServerArgs] = useState('')
  const [command, setCommand] = useState('')

  function loadSkills() {
    void api<{ skills: Skill[] }>(`/api/profiles/${profile.id}/skills`).then((result) => setSkills(result.skills)).catch((error: unknown) => setError(reason(error)))
  }
  function loadServers() {
    void api<{ servers: McpServer[] }>('/api/mcp/servers').then((result) => setServers(result.servers)).catch((error: unknown) => setError(reason(error)))
  }
  function loadExecutions() {
    void api<{ executions: Execution[] }>(`/api/profiles/${profile.id}/executions`).then((result) => setExecutions(result.executions)).catch((error: unknown) => setError(reason(error)))
  }
  useEffect(() => {
    void api<{ skills: Skill[] }>(`/api/profiles/${profile.id}/skills`).then((result) => setSkills(result.skills)).catch((error: unknown) => setError(reason(error)))
    void api<{ servers: McpServer[] }>('/api/mcp/servers').then((result) => setServers(result.servers)).catch((error: unknown) => setError(reason(error)))
    void api<{ executions: Execution[] }>(`/api/profiles/${profile.id}/executions`).then((result) => setExecutions(result.executions)).catch((error: unknown) => setError(reason(error)))
    void api<{ surface: BrowserSurface | null }>(`/api/profiles/${profile.id}/browser`).then((result) => setSurface(result.surface)).catch(() => undefined)
    void api<{ connectors: ConnectorStatus[] }>('/api/connectors').then((result) => {
      setConnectors(result.connectors)
      setProvider((previous) => previous || result.connectors[0]?.provider || '')
    }).catch(() => undefined)
    void api<VoiceStatus>(`/api/profiles/${profile.id}/voice/status`).then(setVoiceStatus).catch(() => undefined)
  }, [profile.id])

  async function createSkill(event: FormEvent) {
    event.preventDefault()
    setBusy('skill')
    setError('')
    try {
      await api(`/api/profiles/${profile.id}/skills`, 'POST', { name: skillName, body: skillBody })
      setSkillName('')
      setSkillBody('')
      loadSkills()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function toggleSkill(skill: Skill) {
    setBusy(skill.id)
    setError('')
    try {
      await api(`/api/skills/${skill.id}/${skill.status === 'active' ? 'deactivate' : 'activate'}`, 'POST')
      loadSkills()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function deleteSkill(id: string) {
    setBusy(id)
    try { await api(`/api/skills/${id}`, 'DELETE'); loadSkills() }
    catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function addServer(event: FormEvent) {
    event.preventDefault()
    setBusy('server')
    setError('')
    try {
      await api('/api/mcp/servers', 'POST', {
        name: serverName, command: serverCommand,
        ...(serverArgs.trim() ? { args: serverArgs.trim().split(/\s+/) } : {}),
      })
      setServerName('')
      setServerCommand('')
      setServerArgs('')
      loadServers()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function refreshServer(id: string) {
    setBusy(id)
    setError('')
    try {
      const result = await api<{ tools: McpTool[] }>(`/api/mcp/servers/${id}/refresh`, 'POST')
      setTools((previous) => ({ ...previous, [id]: result.tools }))
      loadServers()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function loadTools(id: string) {
    try {
      const result = await api<{ tools: McpTool[] }>(`/api/mcp/servers/${id}/tools`)
      setTools((previous) => ({ ...previous, [id]: result.tools }))
    } catch (error) { setError(reason(error)) }
  }

  async function toggleTool(serverId: string, tool: McpTool) {
    setBusy(`${serverId}:${tool.name}`)
    try {
      await api(`/api/mcp/servers/${serverId}/tools/${encodeURIComponent(tool.name)}`, 'POST', { enabled: !tool.enabled })
      await loadTools(serverId)
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function bindServer(server: McpServer) {
    setBusy(server.id)
    setError('')
    try {
      const enabled = !server.profile_ids.includes(profile.id)
      await api(`/api/mcp/servers/${server.id}/profiles/${profile.id}`, 'POST', { enabled })
      loadServers()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function submitExecution(event: FormEvent) {
    event.preventDefault()
    setBusy('execution')
    setError('')
    try {
      await api(`/api/profiles/${profile.id}/executions`, 'POST', { command })
      setCommand('')
      loadExecutions()
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function cancelExecution(id: string) {
    setBusy(id)
    try { await api(`/api/executions/${id}/cancel`, 'POST'); loadExecutions() }
    catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function loadArtifacts(id: string) {
    if (artifacts[id]) { setArtifacts((previous) => { const next = { ...previous }; delete next[id]; return next }); return }
    try {
      const result = await api<{ artifacts: Artifact[] }>(`/api/executions/${id}/artifacts`)
      setArtifacts((previous) => ({ ...previous, [id]: result.artifacts }))
    } catch (error) { setError(reason(error)) }
  }

  async function browserAction(action: string, body?: unknown) {
    setBusy(`browser:${action}`)
    setError('')
    try {
      const method = action === 'snapshot' ? 'GET' : 'POST'
      const result = await api<BrowserSnapshot | Artifact | { closed: boolean } | BrowserSurface>(
        `/api/profiles/${profile.id}/browser/${action}`, method, method === 'GET' ? undefined : (body ?? {}),
      )
      if (isSnapshot(result)) { setSnapshot(result); setSurface((previous) => previous ? { ...previous, current_url: result.url, title: result.title, lease_holder: result.lease.holder, lease_version: result.lease.version } : previous) }
      else if (isArtifact(result)) setShot(result)
      else if (isSurface(result)) setSurface(result)
      else setSnapshot(undefined)
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function readConnector(event: FormEvent) {
    event.preventDefault()
    setBusy('connector:read')
    setError('')
    setConnectorResult('')
    try {
      const result = await api<{ data: unknown }>(`/api/connectors/${provider}/read`, 'POST', {
        operation, params: paramsOf(params),
      })
      setConnectorResult(JSON.stringify(result.data, null, 2).slice(0, 20_000))
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function proposeConnectorAction(event: FormEvent) {
    event.preventDefault()
    setBusy('connector:action')
    setError('')
    setActionResult('')
    try {
      const action = await api<{ id: string; status: string; target_ref: string }>(`/api/connectors/${provider}/actions`, 'POST', {
        profileId: profile.id, operation, params: paramsOf(params), clientRequestId: crypto.randomUUID(),
      })
      setActionResult(`${action.status} · ${action.target_ref} · ${action.id}`)
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function speak(event: FormEvent) {
    event.preventDefault()
    setBusy('voice:speak')
    setError('')
    try {
      const result = await api<{ artifact: Artifact }>(`/api/profiles/${profile.id}/voice/speak`, 'POST', { text: voiceText })
      setVoiceArtifact(result.artifact)
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  async function transcribe(file: File) {
    setBusy('voice:transcribe')
    setError('')
    setTranscript('')
    try {
      const response = await fetch(`/api/profiles/${profile.id}/voice/transcribe`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': file.type || 'audio/webm', 'x-audio-filename': file.name },
        body: file,
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : `转写失败（${response.status}）`
        throw new Error(message)
      }
      if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') throw new Error('转写返回无效')
      setTranscript(value.text)
    } catch (error) { setError(reason(error)) } finally { setBusy('') }
  }

  return <div className="space-y-5" aria-label={`${profile.name}的工具与连接`}>
    <header><h2 className="text-xl font-semibold">{profile.name}的工具与连接</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">技能是提示文本，不直接授予权限；MCP 工具和服务仍是外部代码，逐工具开关在服务端校验。</p></header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    <Card className="space-y-4 p-5"><h3 className="font-medium">技能</h3>
      <form className="space-y-2" onSubmit={(event) => { void createSkill(event) }}>
        <label className="block space-y-2 text-sm"><span>名称</span><input className={field} value={skillName} onChange={(event) => setSkillName(event.target.value)} maxLength={80} required disabled={!!busy} /></label>
        <label className="block space-y-2 text-sm"><span>步骤</span><textarea className={field} rows={3} value={skillBody} onChange={(event) => setSkillBody(event.target.value)} maxLength={4000} required disabled={!!busy} /></label>
        <Button type="submit" disabled={!!busy} className="min-h-11">添加技能</Button>
      </form>
      {skills === undefined ? <p role="status" className="text-sm text-muted-foreground">正在读取技能…</p> : !skills.length ? <p className="text-sm text-muted-foreground">还没有技能。</p> : skills.map((skill) => <div key={skill.id} className="space-y-2 rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><p className="break-words font-medium">{skill.name} <Badge tone={skill.status === 'active' ? 'success' : 'neutral'}>{skill.status === 'active' ? '启用' : '草稿'}</Badge></p><p className="text-xs text-muted-foreground">版本 {skill.version}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void toggleSkill(skill) }}>{skill.status === 'active' ? '停用' : '启用'}</Button><Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void deleteSkill(skill.id) }}>删除</Button></div></div><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{skill.body}</p></div>)}
    </Card>

    <Card className="space-y-4 p-5"><h3 className="font-medium">MCP 服务</h3>
      <form className="space-y-2" onSubmit={(event) => { void addServer(event) }}>
        <label className="block space-y-2 text-sm"><span>名称</span><input className={field} value={serverName} onChange={(event) => setServerName(event.target.value)} maxLength={80} required disabled={!!busy} /></label>
        <label className="block space-y-2 text-sm"><span>启动命令</span><input className={field} value={serverCommand} onChange={(event) => setServerCommand(event.target.value)} maxLength={500} required disabled={!!busy} placeholder="node" /></label>
        <label className="block space-y-2 text-sm"><span>参数（空格分隔）</span><input className={field} value={serverArgs} onChange={(event) => setServerArgs(event.target.value)} disabled={!!busy} /></label>
        <Button type="submit" disabled={!!busy} className="min-h-11">添加服务</Button>
      </form>
      {servers === undefined ? <p role="status" className="text-sm text-muted-foreground">正在读取 MCP 服务…</p> : !servers.length ? <p className="text-sm text-muted-foreground">还没有 MCP 服务。</p> : servers.map((server) => <div key={server.id} className="space-y-2 rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><p className="break-words font-medium">{server.name} <Badge tone={server.state === 'ready' ? 'success' : 'neutral'}>{server.state}</Badge></p><p className="break-words text-xs text-muted-foreground">{server.command} {server.args.join(' ')}</p>{server.last_error && <p className="text-xs text-destructive">{server.last_error}</p>}</div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void refreshServer(server.id) }}>发现工具</Button><Button variant="outline" size="sm" className="min-h-11" onClick={() => { void loadTools(server.id) }}>工具列表</Button><Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void bindServer(server) }}>{server.profile_ids.includes(profile.id) ? '取消绑定当前人格' : '绑定当前人格'}</Button></div></div>
        {(tools[server.id] ?? []).map((tool) => <label key={tool.name} className="flex items-center gap-2 rounded-md bg-muted p-2 text-sm"><input type="checkbox" checked={tool.enabled} disabled={!!busy} onChange={() => { void toggleTool(server.id, tool) }} /><span className="break-words">{tool.name} · {tool.description}</span></label>)}
      </div>)}
    </Card>

    <Card className="space-y-4 p-5"><h3 className="font-medium">具名连接器</h3>
      <div className="grid gap-2 sm:grid-cols-2">{connectors?.map((connector) => <div key={connector.provider} className="rounded-md border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{connector.label}</span><Badge tone={connector.configured ? 'success' : 'neutral'}>{connector.configured ? '已配置' : '未配置'}</Badge></div><p className="mt-1 break-words text-xs text-muted-foreground">{connector.detail}</p></div>)}</div>
      {connectors === undefined ? <p className="text-sm text-muted-foreground">正在读取连接器状态…</p> : !connectors.length ? <p className="text-sm text-muted-foreground">没有可用连接器。</p> : null}
      <form className="space-y-2" onSubmit={(event) => { void readConnector(event) }}>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block space-y-2 text-sm"><span>供应商</span><select className={field} value={provider} onChange={(event) => setProvider(event.target.value)} required>{connectors?.map((connector) => <option key={connector.provider} value={connector.provider}>{connector.label}</option>)}</select></label>
          <label className="block space-y-2 text-sm"><span>操作</span><input className={field} value={operation} onChange={(event) => setOperation(event.target.value)} placeholder="search / channels / inbox / events / video" required /></label>
        </div>
        <label className="block space-y-2 text-sm"><span>参数 JSON</span><textarea className={field} rows={3} value={params} onChange={(event) => setParams(event.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><Button type="submit" className="min-h-11" disabled={!!busy || !provider}>读取</Button><Button variant="outline" className="min-h-11" disabled={!!busy || !provider} onClick={(event) => { void proposeConnectorAction(event) }}>提交写动作（需审批）</Button></div>
        {connectorResult && <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{connectorResult}</pre>}
        {actionResult && <p className="break-words text-sm text-muted-foreground">{actionResult}；到「活动与审批」确认后才会外发。</p>}
      </form>
    </Card>

    <Card className="space-y-4 p-5"><h3 className="font-medium">语音留言</h3>
      <p className="text-sm text-muted-foreground">{voiceStatus ? `转写：${voiceStatus.stt ? '可用' : '未配置'} · 合成：${voiceStatus.tts ? '可用' : '未配置'}` : '正在读取语音状态…'}</p>
      <form className="space-y-2" onSubmit={(event) => { void speak(event) }}>
        <label className="block space-y-2 text-sm"><span>合成文本</span><textarea className={field} rows={2} value={voiceText} onChange={(event) => setVoiceText(event.target.value)} maxLength={4000} required disabled={!!busy || !voiceStatus?.tts} /></label>
        <Button type="submit" className="min-h-11" disabled={!!busy || !voiceStatus?.tts}>生成语音</Button>
        {voiceArtifact && <a className="block text-sm underline underline-offset-4" href={`/api/artifacts/${voiceArtifact.id}/download`}>下载语音 {voiceArtifact.name}</a>}
      </form>
      <label className="block space-y-2 text-sm"><span>上传音频转写</span><input type="file" accept="audio/*" className={field} disabled={!!busy || !voiceStatus?.stt} onChange={(event) => { const file = event.target.files?.[0]; if (file) void transcribe(file) }} /></label>
      {transcript && <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{transcript}</p>}
    </Card>

    <Card className="space-y-4 p-5"><h3 className="font-medium">浏览器</h3>
      <p className="text-sm text-muted-foreground">{surface ? `${surface.state} · ${surface.lease_holder === 'human' ? '人工接管' : 'agent 控制'} · ${surface.current_url ?? '未打开'}` : '尚未打开。'}{surface?.last_error ? ` · ${surface.last_error}` : ''}</p>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void browserAction('open', { url: browserUrl }) }}>
        <label className="min-w-0 flex-1"><span className="sr-only">网址</span><input className={field} value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} maxLength={2000} placeholder="https://example.com" required /></label>
        <Button type="submit" className="min-h-11" disabled={busy === 'browser:open'}>打开</Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="min-h-11" disabled={busy === 'browser:snapshot'} onClick={() => { void browserAction('snapshot') }}>读取快照</Button>
        <Button variant="outline" size="sm" className="min-h-11" disabled={busy === 'browser:screenshot'} onClick={() => { void browserAction('screenshot') }}>截图</Button>
        <Button variant="outline" size="sm" className="min-h-11" disabled={busy === 'browser:lease'} onClick={() => { void browserAction('lease', { holder: surface?.lease_holder === 'human' ? 'agent' : 'human' }) }}>{surface?.lease_holder === 'human' ? '交还 agent' : '人工接管'}</Button>
        <Button variant="outline" size="sm" className="min-h-11" disabled={busy === 'browser:close'} onClick={() => { void browserAction('close') }}>关闭浏览器</Button>
      </div>
      {shot && <p className="text-sm"><a className="underline underline-offset-4" href={`/api/artifacts/${shot.id}/download`}>下载截图 {shot.name}</a></p>}
      {snapshot && <div className="space-y-2 border-t pt-3">
        <p className="text-sm text-muted-foreground">{snapshot.title} · {snapshot.url}</p>
        <div className="flex flex-wrap gap-2">{snapshot.elements.map((element) => <Button key={element.ref} variant="outline" size="sm" className="min-h-11" disabled={element.disabled || surface?.lease_holder === 'human'} onClick={() => { void browserAction('click', { ref: element.ref }) }}>{element.ref} · {element.name.slice(0, 30)}</Button>)}</div>
        <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void browserAction('type', { ref: browserRef, text: browserText }) }}>
          <label className="w-24"><span className="sr-only">元素引用</span><input className={field} value={browserRef} onChange={(event) => setBrowserRef(event.target.value)} placeholder="e1" maxLength={20} required /></label>
          <label className="min-w-0 flex-1"><span className="sr-only">输入内容</span><input className={field} value={browserText} onChange={(event) => setBrowserText(event.target.value)} maxLength={4000} placeholder="输入到选定元素" required /></label>
          <Button type="submit" className="min-h-11" disabled={surface?.lease_holder === 'human'}>输入</Button>
        </form>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{snapshot.aria}</pre>
      </div>}
    </Card>

    <Card className="space-y-4 p-5"><h3 className="font-medium">远程执行</h3>
      <form className="space-y-2" onSubmit={(event) => { void submitExecution(event) }}>
        <label className="block space-y-2 text-sm"><span>命令（在独立工作区执行）</span><textarea className={field} rows={2} value={command} onChange={(event) => setCommand(event.target.value)} maxLength={4000} required disabled={!!busy} /></label>
        <Button type="submit" disabled={!!busy} className="min-h-11">提交任务</Button>
      </form>
      {executions === undefined ? <p role="status" className="text-sm text-muted-foreground">正在读取执行任务…</p> : !executions.length ? <p className="text-sm text-muted-foreground">还没有执行任务。</p> : executions.map((execution) => <div key={execution.id} className="space-y-2 rounded-md border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-words">{execution.command}</span><Badge tone={execution.status === 'done' ? 'success' : execution.status === 'failed' ? 'danger' : 'neutral'}>{execution.status}</Badge></div>{execution.output && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{execution.output}</pre>}{execution.error && <p className="break-words text-destructive">{execution.error}</p>}<div className="flex flex-wrap gap-2">{(execution.status === 'running' || execution.status === 'queued') && <Button variant="outline" size="sm" className="min-h-11" disabled={!!busy} onClick={() => { void cancelExecution(execution.id) }}>取消</Button>}<Button variant="outline" size="sm" className="min-h-11" onClick={() => { void loadArtifacts(execution.id) }}>产物</Button></div>{(artifacts[execution.id] ?? []).map((artifact) => <a key={artifact.id} className="block underline underline-offset-4" href={`/api/artifacts/${artifact.id}/download`}>{artifact.name} · {artifact.size} 字节</a>)}</div>)}
    </Card>
  </div>
}
