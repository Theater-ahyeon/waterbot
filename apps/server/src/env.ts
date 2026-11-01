import { existsSync } from 'node:fs'

import { PROJECT_ENV_FILE } from './paths'

/**
 * 加载项目根的 .env。
 *
 * 只认一个明确的路径：文件不存在就直接返回 undefined，不会去父目录
 * 或磁盘其他位置找第二份配置。已存在的环境变量按 Node 的行为保持不变。
 */
export function loadProjectEnvFile(
  envFile: string = PROJECT_ENV_FILE,
): string | undefined {
  if (!existsSync(envFile)) {
    return undefined
  }

  process.loadEnvFile(envFile)
  return envFile
}
