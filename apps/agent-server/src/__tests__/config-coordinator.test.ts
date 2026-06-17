import { describe, expect, it } from 'vitest'
import { ConfigCoordinator } from '../core/config/config-coordinator.js'

describe('ConfigCoordinator', () => {
  it('合并三层配置', () => {
    const coordinator = new ConfigCoordinator({
      global: { maxTokens: 100000, model: 'gpt-4' },
      project: { maxTokens: 80000 },
      session: { temperature: 0.7 },
    })

    const config = coordinator.resolve()
    expect(config.maxTokens).toBe(80000) // project 覆盖 global
    expect(config.model).toBe('gpt-4') // global 未被覆盖
    expect(config.temperature).toBe(0.7) // session 独有
  })

  it('空配置返回空对象', () => {
    const coordinator = new ConfigCoordinator({})
    const config = coordinator.resolve()
    expect(config).toEqual({})
  })

  it('session 覆盖 project 覆盖 global', () => {
    const coordinator = new ConfigCoordinator({
      global: { model: 'gpt-4', temperature: 0.5 },
      project: { model: 'claude-3' },
      session: { model: 'gpt-4o' },
    })

    const config = coordinator.resolve()
    expect(config.model).toBe('gpt-4o') // session 优先
    expect(config.temperature).toBe(0.5) // global 保留
  })
})
