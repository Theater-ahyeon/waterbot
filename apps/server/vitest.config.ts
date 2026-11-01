import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 集成测试需要真实 PostgreSQL，只在 test:integration 里跑
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.integration.test.ts'],
    // 恢复测试要起子进程与真实 server，钩子清理留足时间
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
