import { useCallback, useEffect, useState } from 'react'

import {
  fetchHealth,
  HealthRequestError,
  HEALTH_TIMEOUT_MS,
  type HealthPayload,
} from '../api/health'

export type HealthState =
  | { status: 'loading' }
  | {
      status: 'success'
      payload: HealthPayload
      latencyMs: number
      checkedAt: Date
    }
  | { status: 'error'; message: string; checkedAt: Date }

type SettledState = Extract<HealthState, { status: 'success' | 'error' }>

export function describeHealthError(error: unknown): string {
  if (error instanceof HealthRequestError) {
    return error.message
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return `连接超时（${HEALTH_TIMEOUT_MS / 1000} 秒）`
  }

  if (error instanceof Error && error.message) {
    return `健康检查失败：${error.message}`
  }

  return '健康检查失败：未知错误'
}

export interface UseHealthResult {
  state: HealthState
  refresh: () => void
}

/** 页面挂载即请求一次真实健康检查，refresh 手动重试。 */
export function useHealth(): UseHealthResult {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<{
    attempt: number
    state: SettledState
  } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    let cancelled = false

    fetchHealth(controller.signal)
      .then((result) => {
        if (cancelled) {
          return
        }
        setSettled({
          attempt,
          state: {
            status: 'success',
            payload: result.payload,
            latencyMs: result.latencyMs,
            checkedAt: new Date(),
          },
        })
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        setSettled({
          attempt,
          state: {
            status: 'error',
            message: describeHealthError(error),
            checkedAt: new Date(),
          },
        })
      })
      .finally(() => {
        clearTimeout(timer)
      })

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [attempt])

  const refresh = useCallback(() => {
    setAttempt((value) => value + 1)
  }, [])

  // 新的一轮请求还没有结果时即为加载态，不在 effect 里同步 setState。
  const state: HealthState =
    settled && settled.attempt === attempt ? settled.state : { status: 'loading' }

  return { state, refresh }
}
