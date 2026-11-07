import { dirname, resolve } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

import { createApp } from './app'
import { loadConfig, loadQqConfig } from './config'
import { loadProjectEnvFile } from './env'
import { PROJECT_ROOT } from './paths'
import { resolveDatabaseConfig } from './pg/config'
import { createPool } from './pg/connection'
import { OwnerAuth } from './auth'
import { Profiles } from './profiles'
import { Chats } from './chat'
import { Actions, simulatedSend } from './actions'
import { QQ_SEND, QqBridge } from './qq/bridge'
import { GroupArchive } from './archive'
import { createBingSearcher, createTavilySearcher, createWebSearchTool, DEFAULT_DAILY_LIMIT } from './search'
import { Memories } from './memory'
import { MemoryExtractor } from './memory-extraction'
import { Usage } from './usage'
import { Status } from './status'
import { createContextExtension } from './memory-context'
import { BotCollaboration, createBotMessageTool } from './collaboration'
import { createMcpTool, McpService } from './mcp'
import { Skills } from './skills'
import { Routines } from './routines'
import { Documents } from './documents'
import { BrowserService, createBrowserTools } from './browser'
import { createGithubTools, GithubService } from './github'
import { createConnectorTools, createConnectors } from './connectors'
import { VoiceService } from './voice'
import { createPageTool, Pages } from './pages'
import { Settings } from './settings'
import { WorkbenchSearch } from './workbench-search'
import { QzoneService } from './qzone'
import { ExecutionService } from './execution'
import {
  createEchoTool,
  createFileNoteTool,
  createRemoteModels,
  FAUX_MODEL,
  loadRemoteModelConfig,
  openRuntime,
  type AgentRuntime,
} from './runtime'

const envFile = loadProjectEnvFile()
const config = loadConfig(process.env)
const qqConfig = loadQqConfig(process.env)
const remoteModel = loadRemoteModelConfig(process.env)
const remote = remoteModel ? createRemoteModels(remoteModel) : undefined
const runtimeModel = remote?.model ?? FAUX_MODEL
const runtimeModelRoute = `${runtimeModel.provider}/${runtimeModel.modelId}`

const dataDirectory = config.dataDirectory
  ? resolve(PROJECT_ROOT, config.dataDirectory)
  : resolve(PROJECT_ROOT, 'apps/server/data')
const databasePath =
  config.runtimeDatabasePath ??
  resolve(dataDirectory, 'runtime.sqlite')
const notesDirectory =
  config.runtimeNotesDirectory ??
  resolve(dataDirectory, 'notes')
const documentsDirectory = resolve(dataDirectory, 'documents')
const browserProfilesDirectory = resolve(dataDirectory, 'browser-profiles')
const browserShotsDirectory = resolve(dataDirectory, 'browser-shots')
const voiceDirectory = resolve(dataDirectory, 'voice')

// 产品业务库：连不上就不带病启动。业务表由 npm run db:migrate 建。
const database = await resolveDatabaseConfig()
const pool = createPool(database.connectionString, 4)

let migrationCount = 0
try {
  await pool.query('select 1')
  const applied = await pool.query<{ count: string }>(
    "select count(*)::text as count from information_schema.tables where table_name = 'schema_migrations'",
  )
  if (applied.rows[0]?.count !== '0') {
    const rows = await pool.query<{ count: string }>(
      'select count(*)::text as count from schema_migrations',
    )
    migrationCount = Number(rows.rows[0]?.count ?? 0)
  }
} catch (error) {
  console.error('[server] postgres 连接失败:', error)
  throw error
}

console.log(
  `[server] postgres ready: ${database.description} migrations=${migrationCount}`,
)

// 一个 server 进程持有一个 Harness 和一个 SQLite 路径；打不开就不带病启动。
const tavilyKey = process.env.TAVILY_API_KEY?.trim()
const searchLimit = Number(process.env.SEARCH_DAILY_LIMIT?.trim() || DEFAULT_DAILY_LIMIT)
if (!Number.isInteger(searchLimit) || searchLimit < 1) throw new Error('SEARCH_DAILY_LIMIT 必须是正整数')
const searcher = tavilyKey ? createTavilySearcher(tavilyKey) : createBingSearcher()
const searchTools = process.env.SEARCH_DISABLED?.trim() === '1' ? [] : [createWebSearchTool(pool, searcher, searchLimit)]
const archive = new GroupArchive(pool)
const memories = new Memories(pool, archive)
const usage = new Usage(pool)
const mcpService = new McpService(pool)
await mcpService.start()
const mcpTool = createMcpTool(() => mcpService)
const skills = new Skills(pool)
const pages = new Pages(pool)
const browser = new BrowserService(pool, browserProfilesDirectory, browserShotsDirectory, {
  channel: process.env.BROWSER_CHANNEL?.trim() || 'msedge',
})
const github = new GithubService({
  ...(process.env.GITHUB_TOKEN?.trim() ? { token: process.env.GITHUB_TOKEN.trim() } : {}),
  ...(process.env.GITHUB_API_BASE?.trim() ? { baseUrl: process.env.GITHUB_API_BASE.trim() } : {}),
})
const connectors = createConnectors(process.env)
const voiceKey = process.env.VOICE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
const voice = new VoiceService(pool, voiceDirectory, {
  ...(process.env.VOICE_STT_URL?.trim() ? { sttUrl: process.env.VOICE_STT_URL.trim() } : {}),
  ...(process.env.VOICE_STT_MODEL?.trim() ? { sttModel: process.env.VOICE_STT_MODEL.trim() } : {}),
  ...(process.env.VOICE_TTS_URL?.trim() ? { ttsUrl: process.env.VOICE_TTS_URL.trim() } : {}),
  ...(process.env.VOICE_TTS_MODEL?.trim() ? { ttsModel: process.env.VOICE_TTS_MODEL.trim() } : {}),
  ...(process.env.VOICE_TTS_VOICE?.trim() ? { ttsVoice: process.env.VOICE_TTS_VOICE.trim() } : {}),
  ...(voiceKey ? { apiKey: voiceKey } : {}),
})
const extractor = qqConfig && remote
  ? new MemoryExtractor(pool, archive, memories, remote.models, remote.modelInfo, qqConfig.dailyTokenLimit)
  : undefined
if (extractor) await extractor.start()
const collaborationRef: { current?: BotCollaboration } = {}
const botTool = createBotMessageTool(() => collaborationRef.current)
let runtime: AgentRuntime
try {
  runtime = await openRuntime({
    databasePath,
    tools: [createEchoTool(), createFileNoteTool({ directory: notesDirectory })],
    demo: !remote,
    ...(remote ? { models: remote.models, model: remote.model } : {}),
    extensions: [createContextExtension(memories, runtimeModelRoute, archive, [
      ...searchTools, botTool, mcpTool, createPageTool(pages), ...createBrowserTools(browser), ...createGithubTools(github), createConnectorTools(connectors),
    ])],
    onReport: (error, info) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[server] runtime report ${info.type}: ${message}`)
    },
  })
} catch (error) {
  console.error('[server] runtime 初始化失败:', error)
  throw error
}

// 启动恢复：主动调度上次进程遗留的任务，不等外部提交触发。
runtime.resume()
console.log('[server] runtime resumed')

void runtime.harness
  .waitForIdle(BACKGROUND_CONTEXT)
  .then(() => {
    console.log('[server] runtime recovery settled')
  })
  .catch((error: unknown) => {
    console.error('[server] runtime 恢复等待失败:', error)
  })

const auth = await OwnerAuth.open(pool, resolve(dirname(databasePath), 'owner-key'), {
  secure: config.publicOrigin?.startsWith('https://') ?? false,
})
const profiles = new Profiles(pool, runtime, skills)
await profiles.seed()
collaborationRef.current = new BotCollaboration(pool, runtime, profiles)
collaborationRef.current.start()
const chats = new Chats(pool, runtime, profiles)
chats.start()
let qq: QqBridge | undefined
let qzoneService: QzoneService | undefined
const actions = new Actions(pool, (action) => {
  if (action.kind === 'qzone.comment') {
    if (!qzoneService) return Promise.reject(new Error('QQ 空间未启用'))
    return qzoneService.comment(action)
  }
  if (connectors.supports(action.account_id)) return connectors.deliver(action)
  if (action.kind !== QQ_SEND) return simulatedSend(action)
  if (!qq) return Promise.reject(new Error('QQ 未启用'))
  return qq.deliver(action)
})
if (qqConfig) qq = new QqBridge(pool, runtime, profiles, actions, archive, memories, qqConfig, extractor)
const activeQq = qq
if (activeQq && qqConfig) {
  const allowWrite = process.env.QZONE_ALLOW_WRITE?.trim() === '1'
  qzoneService = new QzoneService(pool, activeQq.account, qqConfig.botId, (action, params) => activeQq.call(action, params), allowWrite)
}
await actions.start()
qq?.start()
if (qqConfig) console.log(`[server] qq enabled: allowSend=${qqConfig.allowSend}`)
const execution = new ExecutionService(
  pool,
  resolve(dataDirectory, 'workspaces'),
  resolve(PROJECT_ROOT, 'apps/server/src/execution-worker.mjs'),
  [documentsDirectory, browserShotsDirectory, voiceDirectory],
)
const documents = new Documents(pool, documentsDirectory)
const settings = new Settings(pool)
const search = new WorkbenchSearch(pool)
await execution.start()
const routines = new Routines(pool, profiles, runtime, qqConfig
  ? { qq: { account: `onebot:${qqConfig.botId}`, ownerId: qqConfig.ownerId, allowSend: qqConfig.allowSend } }
  : {})
routines.start()
const status = new Status(pool, runtime, usage, extractor, qq)
const server = createApp({
  ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
  services: {
    auth, profiles, chats, actions, memories, usage, status, execution, mcp: mcpService, skills, routines,
    documents, pages, settings, search, browser, github, connectors, voice,
    collaboration: collaborationRef.current,
    ...(qzoneService ? { qzone: qzoneService } : {}), ...(qq ? { qq } : {}),
  },
})

let failing = false

async function failStart(error: NodeJS.ErrnoException): Promise<void> {
  if (failing) {
    return
  }
  failing = true

  if (error.code === 'EADDRINUSE') {
    console.error(
      `[server] port ${config.port} 已被占用，请设置 PORT 或释放该端口后重试`,
    )
  } else {
    console.error('[server] failed to start:', error)
  }

  // 已经打开的 Harness / SQLite / PG 连接必须关掉，否则进程带着句柄退出、库文件被占用。
  try {
    await qq?.close()
    await extractor?.close()
    await collaborationRef.current?.close()
    await routines.close()
    await browser.close()
    await execution.close()
    await mcpService.close()
    await chats.close()
    await actions.close()
    await runtime.close()
    await pool.end()
    console.error('[server] runtime and postgres closed after failed start')
  } catch (closeError) {
    console.error('[server] 资源关闭失败:', closeError)
  }

  process.exit(1)
}

server.listen(config.port, config.host, () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port

  console.log(
    `[server] listening on http://${config.host}:${port} (health: /api/health)`,
  )
  console.log(
    `[server] runtime ready: provider=${runtime.model.provider}/${runtime.model.modelId} sqlite=${runtime.databasePath}`,
  )
  if (envFile) {
    console.log(`[server] loaded env file: ${envFile}`)
  }
})

server.on('error', (error: NodeJS.ErrnoException) => {
  void failStart(error)
})

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  console.log(`[server] received ${signal}, closing`)

  await new Promise<void>((resolveClose) => {
    server.close(() => {
      resolveClose()
    })
    server.closeAllConnections()
  })

  try {
    await qq?.close()
    await extractor?.close()
    await collaborationRef.current?.close()
    await routines.close()
    await browser.close()
    await execution.close()
    await mcpService.close()
    await chats.close()
    await actions.close()
    await runtime.close()
    await pool.end()
  } catch (error) {
    console.error('[server] 资源关闭失败:', error)
    process.exit(1)
  }

  console.log('[server] closed')
  process.exit(0)
}

process.on('SIGINT', (signal) => {
  void shutdown(signal)
})
process.on('SIGTERM', (signal) => {
  void shutdown(signal)
})


