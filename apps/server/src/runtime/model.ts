import { createModels, type Models } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import type { ModelRef } from '@earendil-works/pi-durable'

/** 无凭据的确定性 provider：不读环境变量、不访问网络、不计费。 */
export const FAUX_MODEL: ModelRef = { provider: 'faux', modelId: 'faux-1' }

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

/** 每次模型请求使用独立脚本，多个会话不会争抢同一条 faux 应答。 */
export function createDemoModels(): Models {
  return createFauxModels([(context) => {
    const last = [...context.messages].reverse().find((message) => message.role === 'user')
    const text = (typeof last?.content === 'string'
      ? last.content
      : last?.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '')
      .replace(CONTEXT_BLOCKS, '')
    return fauxAssistantMessage(`【本地演示】收到：${text}\n\n当前使用模拟模型验证聊天与隔离，尚未连接真实模型。`)
  }]).models
}
