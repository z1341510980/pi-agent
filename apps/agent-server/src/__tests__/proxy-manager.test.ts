import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ProxyManager } from '../core/config/proxy-manager.js'
import type { ProxyConfig } from '../core/config/proxy-config-store.js'

// Mock undici 模块
vi.mock('undici', () => {
  const mockAgent = vi.fn()
  const mockEnvHttpProxyAgent = vi.fn()
  const mockProxyAgent = vi.fn()
  return {
    Agent: mockAgent,
    EnvHttpProxyAgent: mockEnvHttpProxyAgent,
    ProxyAgent: mockProxyAgent,
    setGlobalDispatcher: vi.fn(),
  }
})

import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici'

describe('ProxyManager', () => {
  let manager: ProxyManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new ProxyManager()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('apply', () => {
    it('none 模式：重置为默认 Agent', () => {
      const config: ProxyConfig = {
        mode: 'none',
        host: '',
        port: '',
        username: '',
        password: '',
      }
      const result = manager.apply(config)

      expect(result.applied).toBe(true)
      expect(result.mode).toBe('none')
      expect(result.effectiveProxyUrl).toBeNull()
      expect(Agent).toHaveBeenCalledTimes(1)
      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1)
    })

    it('system 模式：使用 EnvHttpProxyAgent', () => {
      const config: ProxyConfig = {
        mode: 'system',
        host: '',
        port: '',
        username: '',
        password: '',
      }
      const result = manager.apply(config)

      expect(result.applied).toBe(true)
      expect(result.mode).toBe('system')
      expect(EnvHttpProxyAgent).toHaveBeenCalledTimes(1)
      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1)
    })

    it('system 模式：读取 HTTPS_PROXY 环境变量', () => {
      process.env.HTTPS_PROXY = 'http://env-proxy:8080'
      const config: ProxyConfig = {
        mode: 'system',
        host: '',
        port: '',
        username: '',
        password: '',
      }
      const result = manager.apply(config)

      expect(result.applied).toBe(true)
      expect(result.effectiveProxyUrl).toBe('http://env-proxy:8080')
      delete process.env.HTTPS_PROXY
    })

    it('manual 模式：构建代理 URL 并应用', () => {
      const config: ProxyConfig = {
        mode: 'manual',
        host: '127.0.0.1',
        port: '7890',
        username: '',
        password: '',
      }
      const result = manager.apply(config)

      expect(result.applied).toBe(true)
      expect(result.mode).toBe('manual')
      expect(result.effectiveProxyUrl).toBe('http://127.0.0.1:7890')
      expect(ProxyAgent).toHaveBeenCalledWith('http://127.0.0.1:7890')
      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1)
    })

    it('manual 模式：带用户名密码的代理 URL', () => {
      const config: ProxyConfig = {
        mode: 'manual',
        host: 'proxy.example.com',
        port: '3128',
        username: 'admin',
        password: 'p@ss:w0rd',
      }
      const result = manager.apply(config)

      expect(result.applied).toBe(true)
      expect(result.effectiveProxyUrl).toBe(
        'http://admin:p%40ss%3Aw0rd@proxy.example.com:3128'
      )
      expect(ProxyAgent).toHaveBeenCalledWith(
        'http://admin:p%40ss%3Aw0rd@proxy.example.com:3128'
      )
    })

    it('manual 模式：缺少 host 时返回失败', () => {
      const config: ProxyConfig = {
        mode: 'manual',
        host: '',
        port: '7890',
        username: '',
        password: '',
      }
      const result = manager.apply(config)

      expect(result.applied).toBe(false)
      expect(result.error).toBe('手动代理模式缺少 host 或 port')
    })

    it('manual 模式：缺少 port 时返回失败', () => {
      const config: ProxyConfig = {
        mode: 'manual',
        host: '127.0.0.1',
        port: '',
        username: '',
        password: '',
      }
      const result = manager.apply(config)

      expect(result.applied).toBe(false)
      expect(result.error).toBe('手动代理模式缺少 host 或 port')
    })
  })

  describe('getCurrentConfig', () => {
    it('apply 前返回 null', () => {
      expect(manager.getCurrentConfig()).toBeNull()
    })

    it('apply 后返回已应用的配置副本', () => {
      const config: ProxyConfig = {
        mode: 'manual',
        host: '127.0.0.1',
        port: '7890',
        username: 'user',
        password: 'pass',
      }
      manager.apply(config)

      const current = manager.getCurrentConfig()
      expect(current).toEqual(config)
      // 确保是副本
      if (current) {
        current.host = 'modified'
        expect(manager.getCurrentConfig()?.host).toBe('127.0.0.1')
      }
    })
  })

  describe('testConnectivity', () => {
    it('none 模式直接返回成功', async () => {
      const config: ProxyConfig = {
        mode: 'none',
        host: '',
        port: '',
        username: '',
        password: '',
      }
      const result = await manager.testConnectivity(config)
      expect(result.ok).toBe(true)
      expect(result.message).toBe('直连模式（无代理）')
    })

    it('manual 模式缺少 host/port 时返回失败', async () => {
      const config: ProxyConfig = {
        mode: 'manual',
        host: '',
        port: '',
        username: '',
        password: '',
      }
      const result = await manager.testConnectivity(config)
      expect(result.ok).toBe(false)
      expect(result.message).toBe('请填写代理主机和端口')
    })
  })
})
