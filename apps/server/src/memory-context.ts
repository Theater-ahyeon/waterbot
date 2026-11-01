import type { Message } from '@earendil-works/pi-ai'
import { defineExtension, GenerationTask, hook, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'

import { createHistoryTool, type GroupArchive } from './archive'
import type { ContextRequest } from './memory'

export const MEMORY_UNAVAILABLE = '<memory_context>\n长期记忆暂时不可用。不要声称“没有记录”；涉及过往的问题直接说明现在查不到。\n</memory_context>'

type UserMessage = Extract<Message, { role: 'user' }>

function textOf(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

function withBlock(messages: readonly Message[], index: number, message: UserMessage, block: string): Message[] {
  const content: UserMessage['content'] = typeof message.content === 'string'
    ? `${block}\n\n${message.content}`
    : [{ type: 'text', text: block }, ...message.content]
  return messages.map((item, position) => (position === index ? { ...message, content } : item))
}

/**
 * beforeRequest 的结果只用于当次请求，不写入 Pi transcript：
 * 恢复重试时重新编译，所以纠正和忘记不会被旧内容带回来。
 */
export function createContextExtension(
  memories: { compile(request: ContextRequest): Promise<string | undefined> },
  modelRoute: string,
  archive?: GroupArchive,
  extraTools: readonly ToolRegistration[] = [],
): Extension {
  return defineExtension({
    name: 'app.context',
    tools: [...(archive ? [createHistoryTool(archive)] : []), ...extraTools],
    hooks: [hook(GenerationTask, {
      beforeRequest: async ({ messages }, api) => {
        const index = messages.findLastIndex((message) => message.role === 'user')
        const message = messages[index]
        if (message?.role !== 'user') return undefined
        let block: string | undefined
        try {
          block = await memories.compile({
            piConversationId: String(api.conversationId),
            piTaskId: String(api.taskId),
            query: textOf(message),
            modelRoute,
          })
        } catch (error) {
          console.error('[memory] 上下文编译失败:', error instanceof Error ? error.message : String(error))
          block = MEMORY_UNAVAILABLE
        }
        return block ? { messages: withBlock(messages, index, message, block) } : undefined
      },
    })],
  })
}
