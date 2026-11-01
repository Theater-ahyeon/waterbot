import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSnapshot, Profile } from './api/client'
import { Workbench } from './Workbench'

const profiles: Profile[] = [
  { id: 'a', name: '日常伙伴', instructions: '温和', revision: 1 },
  { id: 'b', name: '研究助手', instructions: '严谨', revision: 1 },
]

class FakeStream {
  static instances: FakeStream[] = []
  closed = false
  onerror: (() => void) | null = null
  listeners = new Map<string, (event: MessageEvent<string>) => void>()
  constructor(readonly url: string) { FakeStream.instances.push(this) }
  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(name, listener) }
  close() { this.closed = true }
  emit(profile: Profile, text = '') {
    const snapshot: ChatSnapshot = { profile, messages: text ? [{ id: '1', role: 'user', text }] : [], pending: 0, failed: false, mode: 'demo' }
    this.listeners.get('snapshot')?.(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }))
  }
}

const ok = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function fakeApi(owner = true, post?: (path: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    if (init.method === 'POST' && post) return post(path, init)
    if (path === '/api/session') return ok({ authenticated: owner })
    if (path === '/api/profiles') return ok({ profiles })
    if (path === '/api/login') return ok({ authenticated: true })
    if (path === '/api/health') return ok({ status: 'ok', service: 'waterbot-server', version: '0.1.0', uptimeSeconds: 2, checkedAt: new Date().toISOString() })
    return ok({ error: 'unexpected request' }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function ownerView() {
  render(<Workbench />)
  await screen.findByRole('button', { name: /日常伙伴/ })
  await waitFor(() => expect(FakeStream.instances.length).toBe(1))
  const first = FakeStream.instances[0]!
  act(() => first.emit(profiles[0]!))
  return first
}

beforeEach(() => {
  FakeStream.instances = []
  vi.stubGlobal('EventSource', FakeStream)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('工作台人格切换', () => {
  it('首次访问要求登录，访问码不留在登录后的界面', async () => {
    const fetchMock = fakeApi(false)
    render(<Workbench />)
    const input = await screen.findByLabelText('本机访问码')
    fireEvent.change(input, { target: { value: 'test-local-key' } })
    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }))
    await screen.findByRole('button', { name: /日常伙伴/ })
    expect(screen.queryByLabelText('本机访问码')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/login', expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('切换时隐藏旧人格历史，草稿分别保留，旧连接的迟到更新无效', async () => {
    fakeApi()
    const aStream = await ownerView()
    act(() => aStream.emit(profiles[0]!, 'A 的私密记录'))
    fireEvent.change(screen.getByLabelText('发给日常伙伴的消息'), { target: { value: '给 A 的草稿' } })
    fireEvent.click(screen.getByRole('button', { name: /研究助手/ }))
    expect(screen.queryByText('A 的私密记录')).toBeNull()
    expect(screen.getByLabelText('发给研究助手的消息')).toHaveProperty('value', '')
    expect(aStream.closed).toBe(true)
    act(() => aStream.emit(profiles[0]!, '迟到的 A 记录'))
    expect(screen.queryByText('迟到的 A 记录')).toBeNull()
    fireEvent.change(screen.getByLabelText('发给研究助手的消息'), { target: { value: '给 B 的草稿' } })
    fireEvent.click(screen.getByRole('button', { name: /日常伙伴/ }))
    expect(screen.getByLabelText('发给日常伙伴的消息')).toHaveProperty('value', '给 A 的草稿')
  })

  it('网络失败后重试沿用同一请求 ID，不丢输入', async () => {
    const nonces: string[] = []
    fakeApi(true, async (path, init) => {
      expect(path).toBe('/api/profiles/a/messages')
      nonces.push((JSON.parse(String(init.body)) as { clientRequestId: string }).clientRequestId)
      if (nonces.length === 1) throw new TypeError('offline')
      return ok({ requestId: 'accepted' }, 202)
    })
    await ownerView()
    fireEvent.change(screen.getByLabelText('发给日常伙伴的消息'), { target: { value: '只发一次' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await screen.findByText('offline')
    expect(screen.getByLabelText('发给日常伙伴的消息')).toHaveProperty('value', '只发一次')
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(screen.getByLabelText('发给日常伙伴的消息')).toHaveProperty('value', ''))
    expect(nonces).toHaveLength(2)
    expect(nonces[0]).toBe(nonces[1])
  })

  it('A 的发送回执到达时不会清空刚输入的 B 草稿', async () => {
    let finish: ((response: Response) => void) | undefined
    fakeApi(true, async () => new Promise<Response>((resolve) => { finish = resolve }))
    await ownerView()
    fireEvent.change(screen.getByLabelText('发给日常伙伴的消息'), { target: { value: 'A 的消息' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    fireEvent.click(screen.getByRole('button', { name: /研究助手/ }))
    fireEvent.change(screen.getByLabelText('发给研究助手的消息'), { target: { value: 'B 的新草稿' } })
    await act(async () => { finish?.(ok({ requestId: 'accepted' }, 202)); await Promise.resolve() })
    expect(screen.getByLabelText('发给研究助手的消息')).toHaveProperty('value', 'B 的新草稿')
  })
})
