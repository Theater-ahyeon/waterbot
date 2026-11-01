import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    // 真实数据库：单文件串行，避免并发建库互相干扰
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
})
