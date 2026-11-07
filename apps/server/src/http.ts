import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, '请使用 JSON 请求')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 32_768) throw new HttpError(413, '请求内容过长')
    chunks.push(bytes)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object required')
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'JSON 内容无效')
  }
}

export function textField(value: unknown, field: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!empty && !value.trim())) {
    throw new HttpError(400, `${field}无效或过长`)
  }
  return value
}

/** 由 Host 和可选的反向代理地址得到允许的 Origin；非本机且未配置时拒绝。 */
export function originForRequest(host: string | undefined, publicOrigin?: string): string {
  let expected: URL
  try {
    expected = new URL(`http://${host ?? ''}`)
  } catch {
    throw new HttpError(403, '请求来源无效')
  }
  const publicUrl = publicOrigin ? new URL(publicOrigin) : undefined
  if (publicUrl && expected.host === publicUrl.host) {
    return publicUrl.origin
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(expected.hostname) || expected.username || expected.password) {
    throw new HttpError(403, '只允许本机访问')
  }
  return expected.origin
}

export function requireLocalOrigin(req: IncomingMessage, write: boolean, publicOrigin?: string): void {
  const expected = originForRequest(req.headers.host, publicOrigin)
  if (write && req.headers.origin !== expected) {
    throw new HttpError(403, '请求来源不匹配')
  }
}
