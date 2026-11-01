import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Activity } from './Activity'

const profile = { id: 'p1', name: '日常伙伴', instructions: '', revision: 1 }
const baseAction = { id: 'action-1', target_ref: '项目讨论组', payload: { message: '拟发送的消息' }, payload_hash: 'hash-1', revision: 1, status: 'awaiting_approval', reason: '需要主人确认' }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals() })

describe('审批界面', () => {
  it('批准提交当前动作的版本和内容指纹，不能仅发送一个允许标记', async () => {
    let current = { ...baseAction }
    let body: unknown
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      if (init.method === 'POST') {
        expect(path).toBe('/api/actions/action-1/decision')
        body = JSON.parse(String(init.body))
        current = { ...current, status: 'confirmed', reason: '本地模拟执行已确认' }
        return response(current)
      }
      return response(path.endsWith('/policies') ? { policies: [] } : { actions: [current] })
    }))
    render(<Activity profile={profile} />)
    fireEvent.click(await screen.findByRole('button', { name: '允许一次' }))
    await screen.findByText('模拟已确认')
    expect(body).toEqual({ revision: 1, payloadHash: 'hash-1', decision: 'approved' })
  })

  it('编辑期间远端版本更新时仍提交原编辑版本，冲突后保留草稿', async () => {
    let current = { ...baseAction }
    let body: unknown
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'PATCH') {
        body = JSON.parse(String(init.body))
        return response({ error: '动作已变化，不能修改' }, 409)
      }
      return response(String(input).endsWith('/policies') ? { policies: [] } : { actions: [current] })
    }))
    render(<Activity profile={profile} />)
    fireEvent.click(await screen.findByRole('button', { name: '修改内容' }))
    fireEvent.change(screen.getByLabelText('修改后重新确认'), { target: { value: '尚未保存的草稿' } })
    current = { ...current, revision: 2, payload_hash: 'hash-2', payload: { message: '远端更新后的消息' } }
    await screen.findByText('远端更新后的消息', {}, { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: '保存并重新审查' }))
    await screen.findByText('动作已变化，不能修改')
    expect(body).toEqual({ message: '尚未保存的草稿', revision: 1 })
    expect(screen.getByLabelText('修改后重新确认')).toHaveProperty('value', '尚未保存的草稿')
  })

  it('结果不明时不展示重新发送或批准入口，规则可明确撤销', async () => {
    let policies = [{ id: 'rule-1', target_ref: '项目讨论组', hourly_limit: 5, active: true }]
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'DELETE') { policies = []; return response({ revoked: true }) }
      return response(String(input).endsWith('/policies') ? { policies } : { actions: [{ ...baseAction, status: 'unknown' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<Activity profile={profile} />)
    await screen.findByText('结果待核对')
    expect(screen.queryByRole('button', { name: '允许一次' })).toBeNull()
    expect(screen.queryByRole('button', { name: '重新发送' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '撤销规则' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '撤销规则' })).toBeNull())
    expect(fetchMock).toHaveBeenCalledWith('/api/policies/rule-1', expect.objectContaining({ method: 'DELETE' }))
  })
})
