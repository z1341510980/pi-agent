import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyConfigStore, normalizeProxyConfig, defaultProxyConfig } from '../core/config/proxy-config-store.js'

describe('normalizeProxyConfig', () => {
  it('返回默认配置（输入为空）', () => {
    const result = normalizeProxyConfig(null)
    expect(result).toEqual(defaultProxyConfig)
  })

  it('返回默认配置（输入非对象）', () => {
    const result = normalizeProxyConfig('invalid')
    expect(result).toEqual(defaultProxyConfig)
  })

  it('规范化合法配置', () => {
    const result = normalizeProxyConfig({
      mode: 'manual',
      host: '127.0.0.1',
      port: '7890',
      username: 'user',
      password: 'pass',
    })
    expect(result).toEqual({
      mode: 'manual',
      host: '127.0.0.1',
      port: '7890',
      username: 'user',
      password: 'pass',
    })
  })

  it('非法 mode 回退到默认', () => {
    const result = normalizeProxyConfig({ mode: 'invalid' })
    expect(result.mode).toBe(defaultProxyConfig.mode)
  })

  it('非 string 字段回退到空字符串', () => {
    const result = normalizeProxyConfig({
      mode: 'manual',
      host: 123,
      port: true,
      username: null,
      password: undefined,
    })
    expect(result.host).toBe('')
    expect(result.port).toBe('')
    expect(result.username).toBe('')
    expect(result.password).toBe('')
  })
})

describe('ProxyConfigStore', () => {
  const tempDir = join(tmpdir(), `pi-agent-proxy-test-${Date.now()}`)
  const filePath = join(tempDir, 'proxy.json')

  beforeEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('无文件时返回默认配置', () => {
    const store = new ProxyConfigStore(filePath)
    const config = store.get()
    expect(config).toEqual(defaultProxyConfig)
  })

  it('set + get 往返一致', () => {
    const store = new ProxyConfigStore(filePath)
    const custom = {
      mode: 'manual' as const,
      host: '127.0.0.1',
      port: '7890',
      username: 'user',
      password: 'pass',
    }
    store.set(custom)
    expect(store.get()).toEqual(custom)
  })

  it('get 返回副本（修改不影响内部状态）', () => {
    const store = new ProxyConfigStore(filePath)
    store.set({
      mode: 'manual',
      host: '127.0.0.1',
      port: '7890',
      username: '',
      password: '',
    })
    const config = store.get()
    config.host = 'modified'
    expect(store.get().host).toBe('127.0.0.1')
  })

  it('persistNow 写入磁盘', () => {
    const store = new ProxyConfigStore(filePath)
    store.set({
      mode: 'manual',
      host: '10.0.0.1',
      port: '8080',
      username: 'admin',
      password: 'secret',
    })
    store.persistNow()
    expect(existsSync(filePath)).toBe(true)
  })

  it('从磁盘加载已持久化的配置', () => {
    // 先写入一个配置文件
    const data = {
      mode: 'manual',
      host: '192.168.1.1',
      port: '3128',
      username: 'proxyuser',
      password: 'proxypass',
    }
    writeFileSync(filePath, JSON.stringify(data), 'utf-8')

    // 创建新的 store 实例，应从磁盘加载
    const store = new ProxyConfigStore(filePath)
    expect(store.get()).toEqual(data)
  })

  it('磁盘文件损坏时回退到默认配置', () => {
    writeFileSync(filePath, 'invalid json {{{', 'utf-8')
    const store = new ProxyConfigStore(filePath)
    expect(store.get()).toEqual(defaultProxyConfig)
  })

  it('无 filePath 时不持久化（内存模式）', () => {
    const store = new ProxyConfigStore()
    store.set({
      mode: 'none',
      host: '',
      port: '',
      username: '',
      password: '',
    })
    // 不应抛出异常
    store.persistNow()
    expect(store.get().mode).toBe('none')
  })
})
