import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HealthStatus as App } from './Workbench'
import { describeHealthError } from './hooks/useHealth'

const PAYLOAD = {
  status: 'ok',
  service: 'waterbot-server',
  version: '0.1.0',
  uptimeSeconds: 42,
  checkedAt: '2026-10-28T12:00:00.000Z',
}

function okResponse() {
  return { ok: true, status: 200, json: async () => PAYLOAD } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App 连接状态', () => {
  it('加载中显示连接中，成功后显示真实健康数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))

    render(<App />)

    expect(screen.getByTestId('health-status').textContent).toBe('连接中')

    await waitFor(() => {
      expect(screen.getByTestId('health-status').textContent).toBe('已连接')
    })

    expect(screen.getByTestId('health-details').textContent).toContain(
      'waterbot-server',
    )
    expect(screen.getByTestId('health-details').textContent).toContain('42 秒')
    expect(screen.queryByTestId('health-error')).toBeNull()
  })

  it('连接失败时显示原因，重新检查后恢复成功', async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse())
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('health-status').textContent).toBe('连接失败')
    })
    expect(screen.getByTestId('health-error').textContent).toBe(
      '无法连接到本地 server',
    )

    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))

    await waitFor(() => {
      expect(screen.getByTestId('health-status').textContent).toBe('已连接')
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('describeHealthError', () => {
  it('区分超时与未知错误', () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'

    expect(describeHealthError(abortError)).toBe('连接超时（5 秒）')
    expect(describeHealthError('boom')).toBe('健康检查失败：未知错误')
  })
})
