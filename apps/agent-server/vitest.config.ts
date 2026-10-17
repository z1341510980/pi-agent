import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // Integration tests start real Fastify/SQLite/plugin hosts. Limiting
        // worker fan-out prevents Windows file locks and hook timeouts.
        maxForks: 4,
        minForks: 1,
      },
    },
    // 集成测试每次 createApp 启动真实宿主（含 SQLite 迁移与插件加载），
    // 单个用例常态就要 15s+。全量并行时 worker 争抢会把边缘用例顶过预算，
    // 表现为随机文件超时。这里放宽的是等待预算，不改变任何断言。
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
})
