export const HEALTH_ENDPOINT = '/api/health'
export const HEALTH_TIMEOUT_MS = 5000

/** 与 apps/server/src/health.ts 的 HealthPayload 保持一致。 */
export interface HealthPayload {
  status: 'ok'
  service: string
  version: string
  uptimeSeconds: number
  checkedAt: string
}

export interface HealthResult {
  payload: HealthPayload
  latencyMs: number
}

export class HealthRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HealthRequestError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isHealthPayload(value: unknown): value is HealthPayload {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.status === 'ok' &&
    typeof value.service === 'string' &&
    value.service.length > 0 &&
    typeof value.version === 'string' &&
    typeof value.uptimeSeconds === 'number' &&
    Number.isFinite(value.uptimeSeconds) &&
    value.uptimeSeconds >= 0 &&
    typeof value.checkedAt === 'string' &&
    !Number.isNaN(Date.parse(value.checkedAt))
  )
}

/**
 * 读取本机 server 的健康状态。任何协议不符都转成 HealthRequestError，
 * 调用方只需区分“成功拿到的契约数据”与“失败原因”。
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResult> {
  const startedAt = performance.now()

  let response: Response
  try {
    response = await fetch(HEALTH_ENDPOINT, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    // 主动中止（超时 / 卸载）保留原始 AbortError，交给调用方区分处理。
    if (signal?.aborted) {
      throw error
    }
    throw new HealthRequestError('无法连接到本地 server', { cause: error })
  }

  if (!response.ok) {
    throw new HealthRequestError(`server 返回 HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new HealthRequestError('健康检查响应不是合法 JSON', { cause: error })
  }

  if (!isHealthPayload(body)) {
    throw new HealthRequestError('健康检查响应不符合协议')
  }

  return { payload: body, latencyMs: Math.round(performance.now() - startedAt) }
}
