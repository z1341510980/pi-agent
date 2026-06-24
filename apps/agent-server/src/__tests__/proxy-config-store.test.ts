import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../core/db/migrations.js'
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
  let db: Database.Database

  beforeEach(() => {
    // 使用内存数据库，每个测试独立隔离
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('空数据库时返回默认配置', () => {
    // migrations 已插入 id=1 的默认行（mode='system'）
    const store = new ProxyConfigStore(db)
    const config = store.get()
    expect(config).toEqual(defaultProxyConfig)
  })

  it('set + get 往返一致', () => {
    const store = new ProxyConfigStore(db)
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
    const store = new ProxyConfigStore(db)
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

  it('set 同步写入 SQLite', () => {
    const store = new ProxyConfigStore(db)
    store.set({
      mode: 'manual',
      host: '10.0.0.1',
      port: '8080',
      username: 'admin',
      password: 'secret',
    })
    // 直接查询数据库验证已落库
    const row = db.prepare('SELECT * FROM proxy_config WHERE id = 1').get() as {
      mode: string
      host: string
      port: string
      username: string
      password: string
    }
    expect(row.mode).toBe('manual')
    expect(row.host).toBe('10.0.0.1')
    expect(row.port).toBe('8080')
    expect(row.username).toBe('admin')
    expect(row.password).toBe('secret')
  })

  it('新实例从 SQLite 加载已持久化的配置', () => {
    // 先用第一个 store 写入配置
    const store1 = new ProxyConfigStore(db)
    const data = {
      mode: 'manual' as const,
      host: '192.168.1.1',
      port: '3128',
      username: 'proxyuser',
      password: 'proxypass',
    }
    store1.set(data)

    // 用同一个 db 创建新的 store 实例，应从 SQLite 加载
    const store2 = new ProxyConfigStore(db)
    expect(store2.get()).toEqual(data)
  })

  it('set 覆盖已有行（UPSERT）', () => {
    const store = new ProxyConfigStore(db)
    store.set({
      mode: 'manual',
      host: '1.1.1.1',
      port: '1111',
      username: 'u1',
      password: 'p1',
    })
    store.set({
      mode: 'none',
      host: '2.2.2.2',
      port: '2222',
      username: 'u2',
      password: 'p2',
    })
    expect(store.get()).toEqual({
      mode: 'none',
      host: '2.2.2.2',
      port: '2222',
      username: 'u2',
      password: 'p2',
    })
    // 确认数据库只有一行
    const count = (db.prepare('SELECT COUNT(*) as c FROM proxy_config').get() as { c: number }).c
    expect(count).toBe(1)
  })
})
