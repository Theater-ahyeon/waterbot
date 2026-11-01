import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 项目根目录的唯一定义。
 *
 * src/index.ts（tsx 开发）与 dist/index.js（tsup 构建产物）都位于
 * `apps/server/<某一层>/`，因此从本文件位置上溯三层就是项目根，
 * 开发与构建 / 启动两种运行方式得到同一个路径。
 *
 * 这里只做固定路径推算，不向上查找、不扫描任何目录，
 * 避免读到项目之外其他仓库的 .env。
 */
export const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
)

/** 本项目唯一的环境文件路径（不存在即视为没有配置）。 */
export const PROJECT_ENV_FILE = resolve(PROJECT_ROOT, '.env')
