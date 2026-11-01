import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { loadEnv, type UserConfig } from 'vite'
import { defineConfig } from 'vitest/config'

/** apps/web */
export const WEB_ROOT = dirname(fileURLToPath(import.meta.url))
/** 仓库根，与 apps/server/src/paths.ts 的 PROJECT_ROOT 指向同一目录 */
export const PROJECT_ROOT = resolve(WEB_ROOT, '../..')

export const SERVER_ORIGIN_KEY = 'VITE_SERVER_ORIGIN'
export const DEFAULT_SERVER_ORIGIN = 'http://127.0.0.1:8787'

export interface ServerOriginOptions {
  mode: string
  /** 默认仓库根，测试可指向临时目录 */
  envDir?: string
  shellEnv?: NodeJS.ProcessEnv
}

/**
 * 只从 envDir（默认项目根）的 .env 取 `VITE_SERVER_ORIGIN` 一个值。
 *
 * loadEnv 的第三个参数是前缀过滤，返回值里只有匹配的键，其他配置
 * （数据库地址、密钥等）不会进入返回对象。这里也不设置 Vite 的
 * `envDir`，所以根 .env 不会被注入到客户端 `import.meta.env`。
 */
export function readProjectEnv(options: ServerOriginOptions): Record<string, string> {
  const { mode, envDir = PROJECT_ROOT } = options
  return loadEnv(mode, envDir, SERVER_ORIGIN_KEY)
}

/** 进程环境优先，其次项目根 .env，最后回落到本地默认地址。 */
export function resolveServerOrigin(options: ServerOriginOptions): string {
  const shellValue = options.shellEnv?.[SERVER_ORIGIN_KEY]?.trim()
  if (shellValue) {
    return shellValue
  }

  const fileValue = readProjectEnv(options)[SERVER_ORIGIN_KEY]?.trim()
  return fileValue || DEFAULT_SERVER_ORIGIN
}

export function createConfig(options: ServerOriginOptions): UserConfig {
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // 开发期由 Vite 代理 /api，页面与 server 同源，不需要放开 CORS。
      proxy: {
        '/api': { target: resolveServerOrigin(options) },
      },
    },
  }
}

export default defineConfig(({ mode }) => ({
  ...createConfig({ mode }),
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.ts'],
  },
}))
