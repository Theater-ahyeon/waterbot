import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineDoc,
  defineExtension,
  Harness,
  type Conversation,
  type Extension,
  type ModelRef,
  type ReportInfo,
  type SettledSubmissionRecord,
  type Submission,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { createDemoModels, createFauxModels, FAUX_MODEL } from './model'

/** 本进程打开的 Pi Harness（上游类型别名，避免把实现写成本地副本）。 */
export type HarnessInstance = Awaited<ReturnType<typeof Harness.open>>

/** 本包唯一的扩展名：显式注册有限工具，不默认放开全部能力。 */
export const EXTENSION_NAME = 'app.minimal'

/** 单会话阶段的默认业务会话键（P1 落 conversation_binding 后按 profile 生成）。 */
export const DEFAULT_CONVERSATION_KEY = 'owner:default'

// 旧版本仅有默认会话；新会话在创建事务内绑定，重开时不允许更名复用旧历史。
export const RuntimeBinding = defineDoc<{ conversationKey: string }>({
  kind: 'app.runtime-binding',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ conversationKey: DEFAULT_CONVERSATION_KEY }),
  checkpointWhen: () => true,
})

export interface RuntimeOptions {
  /** runtime.sqlite 的路径；父目录不存在时自动创建 */
  databasePath: string
  /** 显式注册的工具；为空视为配置错误 */
  tools: readonly ToolRegistration[]
  /** faux provider 的确定性应答脚本，按顺序消费 */
  responses?: readonly FauxResponseStep[]
  /** 本机演示模式，不连接任何外部模型；脚本测试保持默认关闭。 */
  demo?: boolean
  /** 默认 faux，不需要任何平台凭据 */
  model?: ModelRef
  /** 这个 runtime 绑定的业务会话键；一个 runtime 只服务一个目标 */
  conversationKey?: string
  /** 业务扩展：注册到运行库，由每个业务会话显式选择 */
  extensions?: readonly Extension[]
  /** 非致命失败（任务失败、会话失败）的上报出口，由宿主决定是否记录 */
  onReport?: (error: unknown, info: ReportInfo) => void
}

export interface AgentRuntime {
  readonly harness: HarnessInstance
  readonly conversation: Conversation
  readonly databasePath: string
  readonly model: ModelRef
  readonly extensions: readonly Extension[]
  /** 这个 runtime 服务的业务会话键，派发前必须与 outbox 的目标一致 */
  readonly conversationKey: string
  /** 启动任务调度：恢复上次进程留下的未完成工作 */
  resume(): void
  /** 提交一条输入并等待结算（done / unanswered） */
  submit(input: { content: string; requestId: string }): Promise<SettledSubmissionRecord>
  /**
   * 只做持久受理：拿到 Submission 就返回，不等模型 / 工具跑完。
   * 派发链路必须用这个，否则受理与执行被混在一起。
   */
  accept(input: {
    content: string
    requestId: string
    whenBusy?: 'steer' | 'followUp' | 'reject'
  }): Promise<Submission>
  /** 关闭 Harness 与 SQLite；幂等 */
  close(): Promise<void>
}

/**
 * 打开一个 server 进程独享的 runtime：一个 SQLite 文件、一个 Harness、一个根会话。
 * 同一路径不能被两个进程同时打开（上游没有跨进程锁），调用方负责生命周期。
 */
export async function openRuntime(options: RuntimeOptions): Promise<AgentRuntime> {
  if (options.tools.length === 0) {
    throw new Error('runtime 需要至少一个显式注册的工具')
  }

  const model = options.model ?? FAUX_MODEL
  const conversationKey = options.conversationKey ?? DEFAULT_CONVERSATION_KEY
  if (!conversationKey.trim()) {
    throw new Error('会话绑定不能为空')
  }
  await mkdir(dirname(options.databasePath), { recursive: true })

  const { models } = createFauxModels(options.responses)
  const registry = createRegistry()
  registry.install(
    defineExtension({ name: EXTENSION_NAME, tools: [...options.tools] }),
  )
  const extensions = options.extensions ?? []
  for (const extension of extensions) registry.install(extension)

  const storage = await openNodeSqliteStorage(options.databasePath)

  let harness: HarnessInstance
  try {
    harness = await Harness.open(
      storage,
      {
        models: options.demo ? createDemoModels : models,
        registry,
        ...(options.onReport ? { onReport: options.onReport } : {}),
      },
      BACKGROUND_CONTEXT,
    )
  } catch (error) {
    await storage.close(BACKGROUND_CONTEXT)
    throw error
  }

  let conversation: Conversation
  try {
    conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model, tools: [...options.tools] },
      init: async (tx, id) => {
        const binding = await tx.doc(RuntimeBinding, id)
        binding.conversationKey = conversationKey
      },
    })
    await conversation.commit(async (tx) => {
      const binding = await tx.doc(RuntimeBinding, conversation.id)
      if (binding.conversationKey !== conversationKey) {
        throw new Error(`会话绑定不一致：数据库属于 ${binding.conversationKey}，拒绝改绑为 ${conversationKey}`)
      }
    }, BACKGROUND_CONTEXT)
  } catch (error) {
    await harness.close(BACKGROUND_CONTEXT)
    throw error
  }

  let closed = false

  return {
    harness,
    conversation,
    databasePath: options.databasePath,
    model,
    extensions,
    conversationKey,
    resume() {
      harness.resume()
    },
    async submit(input) {
      const submission = await conversation.submit(
        { type: 'input', content: input.content, requestId: input.requestId },
        BACKGROUND_CONTEXT,
      )
      return submission.wait(BACKGROUND_CONTEXT)
    },
    async accept(input) {
      return conversation.submit(
        {
          type: 'input',
          content: input.content,
          requestId: input.requestId,
          whenBusy: input.whenBusy ?? 'reject',
        },
        BACKGROUND_CONTEXT,
      )
    },
    async close() {
      if (closed) {
        return
      }
      closed = true
      await harness.close(BACKGROUND_CONTEXT)
    },
  }
}
