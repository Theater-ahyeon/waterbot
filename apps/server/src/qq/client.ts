import { randomUUID } from 'node:crypto'

export interface OneBotHandlers {
  onEvent(event: unknown): void
  onUp(): void
  onDown(reason: string): void
}

const MAX_BACKOFF_MS = 30_000

/** OneBot v11 正向 WebSocket 客户端：掉线自动重连，调用超时只报失败，不重试。 */
export class OneBotClient {
  private socket: WebSocket | undefined
  private closed = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly handlers: OneBotHandlers,
    private readonly options: { callTimeoutMs?: number; baseBackoffMs?: number } = {},
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  start(): void {
    this.connect()
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.socket?.close()
    this.failPending('连接已关闭')
  }

  /** 超时后结果未知：调用方必须按 unknown 处理，不能补发。 */
  call(action: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OneBot 未连接'))
    const echo = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error('OneBot 调用超时'))
      }, this.options.callTimeoutMs ?? 15_000)
      this.pending.set(echo, { resolve, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }))
    })
  }

  private connect(): void {
    if (this.closed) return
    const url = new URL(this.url)
    if (this.token) url.searchParams.set('access_token', this.token)
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener('open', () => {
      this.attempt = 0
      this.handlers.onUp()
    })
    socket.addEventListener('message', (event) => { this.receive(event.data) })
    socket.addEventListener('close', () => {
      this.failPending('连接已断开')
      if (this.closed) return
      this.handlers.onDown('connection_closed')
      const delay = Math.min((this.options.baseBackoffMs ?? 1000) * 2 ** this.attempt++, MAX_BACKOFF_MS)
      this.timer = setTimeout(() => { this.connect() }, delay)
    })
    // error 之后必有 close，重连统一在 close 处理；这里注册是为了不成为未处理事件。
    socket.addEventListener('error', () => undefined)
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      return
    }
    const echo = (value as { echo?: unknown } | null)?.echo
    const waiting = typeof echo === 'string' ? this.pending.get(echo) : undefined
    if (!waiting) {
      this.handlers.onEvent(value)
      return
    }
    this.pending.delete(echo as string)
    clearTimeout(waiting.timer)
    const reply = value as { status?: unknown; retcode?: unknown; data?: unknown }
    if (reply.status === 'ok' && reply.retcode === 0) waiting.resolve(reply.data)
    else waiting.reject(new Error(`OneBot 返回失败：${String(reply.retcode)}`))
  }

  private failPending(reason: string): void {
    for (const [echo, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(reason))
      this.pending.delete(echo)
    }
  }
}
