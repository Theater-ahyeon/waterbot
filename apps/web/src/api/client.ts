export interface Profile {
  id: string
  name: string
  instructions: string
  revision: number
  archived_at?: string | null
}

export interface ChatSnapshot {
  profile: Profile
  messages: { id: string; role: 'user' | 'assistant'; text: string }[]
  pending: number
  failed: boolean
  mode: 'demo'
}

export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  let value: unknown
  try { value = await response.json() } catch { throw new Error('服务返回了无法读取的内容') }
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined
    throw new Error(typeof error === 'string' ? error : `请求失败（${response.status}）`)
  }
  return value as T
}
