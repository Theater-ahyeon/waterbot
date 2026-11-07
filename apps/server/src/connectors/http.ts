import { HttpError } from '../http'

/** 外部 API 统一超时和失败转换；错误正文截断，避免把凭据或大段页面带进日志。 */
export async function jsonRequest(
  provider: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new HttpError(502, `${provider} 请求失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new HttpError(502, `${provider} 返回 ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, `${provider} 返回格式无效`)
  }
}

export function stringParam(params: Record<string, unknown>, name: string, max = 200): string {
  const value = params[name]
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${name}无效`)
  return value.trim()
}

export function optionalString(params: Record<string, unknown>, name: string, max = 200): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${name}无效`)
  return value.trim() || undefined
}

export function integerParam(params: Record<string, unknown>, name: string, min: number, max: number, fallback: number): number {
  const value = params[name]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name}必须在 ${min}—${max} 之间`)
  }
  return value
}
