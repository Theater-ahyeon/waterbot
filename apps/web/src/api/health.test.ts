import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchHealth, HealthRequestError, isHealthPayload } from './health'

const VALID_PAYLOAD = {
  status: 'ok',
  service: 'waterbot-server',
  version: '0.1.0',
  uptimeSeconds: 3.4,
  checkedAt: '2026-10-28T12:00:00.000Z',
}

function response(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    json: async () => body,
  } as unknown as Response
}

function stubFetch(impl: (input: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isHealthPayload', () => {
  it('接受合法载荷', () => {
    expect(isHealthPayload(VALID_PAYLOAD)).toBe(true)
  })

  it('拒绝缺字段、错误类型和非法时间', () => {
    expect(isHealthPayload({ ...VALID_PAYLOAD, status: 'degraded' })).toBe(false)
    expect(isHealthPayload({ ...VALID_PAYLOAD, uptimeSeconds: -1 })).toBe(false)
    expect(isHealthPayload({ ...VALID_PAYLOAD, version: undefined })).toBe(false)
    expect(isHealthPayload({ ...VALID_PAYLOAD, checkedAt: 'not-a-date' })).toBe(
      false,
    )
    expect(isHealthPayload(null)).toBe(false)
    expect(isHealthPayload([])).toBe(false)
  })
})

describe('fetchHealth', () => {
  it('请求 /api/health 并返回契约数据与延迟', async () => {
    const mock = stubFetch(async () => response(VALID_PAYLOAD))

    const result = await fetchHealth()

    expect(mock).toHaveBeenCalledTimes(1)
    expect(mock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )
    expect(result.payload).toEqual(VALID_PAYLOAD)
    expect(typeof result.latencyMs).toBe('number')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('HTTP 非 2xx 时报出状态码', async () => {
    stubFetch(async () => response({ error: 'boom' }, { ok: false, status: 503 }))

    await expect(fetchHealth()).rejects.toThrowError(
      new HealthRequestError('server 返回 HTTP 503'),
    )
  })

  it('响应不是合法 JSON 时报错', async () => {
    stubFetch(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      }) as unknown as Response,
    )

    await expect(fetchHealth()).rejects.toThrowError('健康检查响应不是合法 JSON')
  })

  it('响应结构不符合协议时报错', async () => {
    stubFetch(async () => response({ ...VALID_PAYLOAD, version: 1 }))

    await expect(fetchHealth()).rejects.toThrowError('健康检查响应不符合协议')
  })

  it('网络失败时报出连接错误', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(fetchHealth()).rejects.toThrowError('无法连接到本地 server')
  })

  it('被中止时保留 AbortError 供调用方区分', async () => {
    const controller = new AbortController()
    controller.abort()

    stubFetch(async () => {
      throw new DOMException('aborted', 'AbortError')
    })

    await expect(fetchHealth(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
