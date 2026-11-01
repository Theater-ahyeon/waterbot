import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'

/**
 * 纯函数工具：返回固定前缀的文本，重复执行结果一致。
 * 声明 replay: "safe"——进程中断后可以安全重跑。
 */
export function createEchoTool(): ToolRegistration {
  return defineTool({
    name: 'echo',
    description: 'Return the provided text unchanged. Pure and deterministic.',
    parameters: Type.Object({ text: Type.String() }),
    replay: 'safe',
    execute: async (args) => ({
      output: [{ type: 'text', text: `echo:${args.text}` }],
    }),
  })
}

export interface FileNoteToolOptions {
  /** 追加写入的目录，文件名为 notes.log */
  directory: string
}

/**
 * 有真实本地副作用的工具：每次调用向 notes.log 追加一行。
 * 声明 replay: "unsafe"——中断后不许自动重跑，由上游给出 interrupted 回执，
 * 因为重跑会重复追加，无法证明只发生一次。
 */
export function createFileNoteTool(options: FileNoteToolOptions): ToolRegistration {
  const file = join(options.directory, 'notes.log')

  return defineTool({
    name: 'note_file',
    description: 'Append one line to the local notes file. Has a real local side effect.',
    parameters: Type.Object({ text: Type.String() }),
    replay: 'unsafe',
    execute: async (args) => {
      await mkdir(options.directory, { recursive: true })
      await appendFile(file, `${args.text}\n`, 'utf8')
      return { output: [{ type: 'text', text: 'note-appended' }] }
    },
  })
}
