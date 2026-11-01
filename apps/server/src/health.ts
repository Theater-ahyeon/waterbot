/**
 * 健康检查协议的唯一权威定义。
 * web 端的类型守卫与此处字段保持一致；改动时两侧同时更新并有测试覆盖。
 */
export const SERVICE_NAME = 'waterbot-server'

/** 与 apps/server/package.json 的 version 同步，由 app.test.ts 校验。 */
export const SERVICE_VERSION = '0.1.0'

export interface HealthPayload {
  status: 'ok'
  service: string
  version: string
  uptimeSeconds: number
  checkedAt: string
}

export function buildHealthPayload(params: {
  startedAt: Date
  now: Date
}): HealthPayload {
  const elapsedMs = Math.max(0, params.now.getTime() - params.startedAt.getTime())

  return {
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round((elapsedMs / 1000) * 10) / 10,
    checkedAt: params.now.toISOString(),
  }
}
