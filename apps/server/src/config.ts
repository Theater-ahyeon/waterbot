const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787

export interface QqEnvConfig {
  url: string
  token?: string
  botId: string
  ownerId: string
  profileId?: string
  allowSend: boolean
  /** 每个 QQ 会话 24 小时模型 token 上限；0 表示不限制 */
  dailyTokenLimit: number
}

/** 三项全空视为未启用；只填一部分是配置错误，不带病启动。QQ_ALLOW_SEND=1 才允许外发。 */
export function loadQqConfig(env: NodeJS.ProcessEnv): QqEnvConfig | undefined {
  const url = env.ONEBOT_WS_URL?.trim()
  const botId = env.QQ_BOT_ID?.trim()
  const ownerId = env.QQ_OWNER_ID?.trim()
  if (!url && !botId && !ownerId) return undefined
  if (!url || !/^wss?:\/\//.test(url)) throw new Error('ONEBOT_WS_URL 必须是 ws:// 或 wss:// 地址')
  if (!botId || !/^\d+$/.test(botId) || !ownerId || !/^\d+$/.test(ownerId)) throw new Error('QQ_BOT_ID 和 QQ_OWNER_ID 必须是 QQ 号')
  if (botId === ownerId) throw new Error('QQ_BOT_ID 不能与 QQ_OWNER_ID 相同：Bot 使用专用小号')
  const token = env.ONEBOT_ACCESS_TOKEN?.trim()
  const profileId = env.QQ_PROFILE_ID?.trim()
  const rawLimit = env.QQ_DAILY_TOKEN_LIMIT?.trim()
  const dailyTokenLimit = rawLimit ? Number(rawLimit) : 0
  if (!Number.isInteger(dailyTokenLimit) || dailyTokenLimit < 0) throw new Error('QQ_DAILY_TOKEN_LIMIT 必须是非负整数')
  return {
    url, botId, ownerId, allowSend: env.QQ_ALLOW_SEND?.trim() === '1', dailyTokenLimit,
    ...(token ? { token } : {}), ...(profileId ? { profileId } : {}),
  }
}

export interface ServerConfig {
  host: string
  port: number
  /** 覆盖 runtime.sqlite 路径；未设置时由启动入口用项目内默认路径 */
  runtimeDatabasePath?: string
  /** 覆盖本地工具副作用目录；未设置时由启动入口用项目内默认路径 */
  runtimeNotesDirectory?: string
  /** 覆盖运行数据根目录；未设置时为 apps/server/data */
  dataDirectory?: string
  /** 反向代理对外地址；设置后允许该 Host / Origin，server 仍只监听回环 */
  publicOrigin?: string
}

/**
 * server 只允许监听本机回环地址。配置成 0.0.0.0 之类会直接失败，
 * 避免把未认证的工作台接口暴露到局域网。
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const host = env.HOST?.trim() || DEFAULT_HOST

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `HOST 必须是回环地址（127.0.0.1 / localhost / ::1），当前为 "${host}"`,
    )
  }

  const runtimeDatabasePath = env.RUNTIME_SQLITE_PATH?.trim()
  const runtimeNotesDirectory = env.RUNTIME_NOTES_DIR?.trim()
  const dataDirectory = env.WATERBOT_DATA_DIR?.trim()
  const rawPublicOrigin = env.PUBLIC_ORIGIN?.trim()
  let publicOrigin: string | undefined
  if (rawPublicOrigin) {
    let parsed: URL
    try {
      parsed = new URL(rawPublicOrigin)
    } catch {
      throw new Error('PUBLIC_ORIGIN 必须是 http:// 或 https:// 地址')
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('PUBLIC_ORIGIN 只能包含协议和主机')
    }
    publicOrigin = parsed.origin
  }
  const runtimePaths = {
    ...(runtimeDatabasePath ? { runtimeDatabasePath } : {}),
    ...(runtimeNotesDirectory ? { runtimeNotesDirectory } : {}),
    ...(dataDirectory ? { dataDirectory } : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
  }

  const rawPort = env.PORT?.trim()
  if (!rawPort) {
    return {
      host,
      port: DEFAULT_PORT,
      ...runtimePaths,
    }
  }

  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT 必须是 0-65535 的整数，当前为 "${rawPort}"`)
  }

  return {
    host,
    port,
    ...runtimePaths,
  }
}
