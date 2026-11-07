import {
  createModels,
  createProvider,
  type Model,
  type Models,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  fauxProvider,
  fauxAssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import type { ModelRef } from '@earendil-works/pi-durable'

/** 无凭据的确定性 provider：不读环境变量、不访问网络、不计费。 */
export const FAUX_MODEL: ModelRef = { provider: 'faux', modelId: 'faux-1' }

export interface RemoteModelConfig {
  baseUrl: string
  apiKey: string
  modelId: string
  providerId: string
}

const REMOTE_PROVIDER_ID = 'magpie'

/** 三项配置要么都为空（使用 faux），要么都填；只填一部分直接报错。 */
export function loadRemoteModelConfig(env: NodeJS.ProcessEnv): RemoteModelConfig | undefined {
  const baseUrl = env.OPENAI_BASE_URL?.trim()
  const apiKey = env.OPENAI_API_KEY?.trim()
  const modelId = (env.OPENAI_MODEL ?? env.MODEL_ID)?.trim()
  if (!baseUrl && !apiKey && !modelId) return undefined
  if (!baseUrl || !apiKey || !modelId) {
    throw new Error('OPENAI_BASE_URL、OPENAI_API_KEY 和 MODEL_ID 必须同时设置')
  }
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('OPENAI_BASE_URL 必须是 http:// 或 https:// 地址')
  return { baseUrl, apiKey, modelId, providerId: REMOTE_PROVIDER_ID }
}

/** 通用 OpenAI Completions 兼容端点；模型元数据用于上下文和费用计算。 */
export function createRemoteModels(config: RemoteModelConfig): {
  models: Models
  model: ModelRef
  modelInfo: Model<'openai-completions'>
} {
  const model: Model<'openai-completions'> = {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: config.providerId,
    baseUrl: config.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  }
  const provider = createProvider<'openai-completions'>({
    id: config.providerId,
    name: 'Magpie',
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: 'OpenAI-compatible API key',
        resolve: async () => ({ auth: { apiKey: config.apiKey }, source: 'OPENAI_API_KEY' }),
      },
    },
    models: [model],
    api: { 'openai-completions': openAICompletionsApi() },
  })
  const models = createModels()
  models.setProvider(provider)
  return { models, model: { provider: config.providerId, modelId: config.modelId }, modelInfo: model }
}

export interface FauxModels {
  models: Models
  faux: FauxProviderHandle
}

/**
 * 构造只含 faux provider 的模型集合。
 * `responses` 是本次运行预置的确定性应答脚本，按顺序消费。
 */
export function createFauxModels(responses: readonly FauxResponseStep[] = []): FauxModels {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)

  if (responses.length > 0) {
    faux.setResponses([...responses])
  }

  return { models, faux }
}

/** 回显时去掉请求级上下文，演示回复不能把记忆和群记录带出去。 */
const CONTEXT_BLOCKS = /^(?:<(memory_context|group_history)>[\s\S]*?<\/\1>\n\n)+/
/** 群消息的受信前缀只用于服务端关联来源，不能出现在回复里。 */
const GROUP_MESSAGE_HEADER = /^\[群成员 \d+ · 消息 [0-9a-f-]{36}\]\s*/

/** 每次模型请求使用独立脚本，多个会话不会争抢同一条 faux 应答。 */
export function createDemoModels(): Models {
  return createFauxModels([(context) => {
    const last = [...context.messages].reverse().find((message) => message.role === 'user')
    const text = (typeof last?.content === 'string'
      ? last.content
      : last?.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '')
      .replace(CONTEXT_BLOCKS, '')
      .replace(GROUP_MESSAGE_HEADER, '')
    return fauxAssistantMessage(`【本地演示】收到：${text}\n\n当前使用模拟模型验证聊天与隔离，尚未连接真实模型。`)
  }]).models
}
