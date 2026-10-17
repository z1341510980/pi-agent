import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    maxWorkers: 2,
    minWorkers: 1,
    // 默认 5s 对本仓库偏紧：单次 run 有 58 个文件并行 transform，
    // 冷启动时若干与被测逻辑无关的用例会卡在 import 阶段而超时（表现为
    // 随机文件失败）。这里放宽的是等待预算，不改变任何断言。
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
