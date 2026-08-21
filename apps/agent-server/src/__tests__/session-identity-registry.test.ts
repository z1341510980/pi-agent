/**
 * 会话身份索引 P0（§9.4）测试：
 * - SqliteSessionIdentityRegistry 持久化 CRUD；
 * - PiSessionStore：getSessionFilePath 内存 miss 回退注册表；
 * - PiSessionStore：chat 线程按注册表路径恢复（resumePath 传给工厂），plugin:* 不恢复；
 * - 会话创建成功后异步持久化 threadId → sessionPath。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../core/db/migrations.js'
import { SqliteSessionIdentityRegistry } from '../core/agent/session-identity-registry.js'
import { PiSessionStore } from '../core/agent/session-store.js'

describe('SqliteSessionIdentityRegistry', () => {
  let db: Database.Database

  beforeAll(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterAll(() => db.close())

  it('put/get 持久化并支持覆盖更新', () => {
    const registry = new SqliteSessionIdentityRegistry(db)
    expect(registry.get('thread-1')).toBeNull()

    registry.put('thread-1', '/sessions/a.jsonl')
    expect(registry.get('thread-1')).toBe('/sessions/a.jsonl')

    registry.put('thread-1', '/sessions/a-v2.jsonl')
    expect(registry.get('thread-1')).toBe('/sessions/a-v2.jsonl')
  })
})

describe('PiSessionStore 会话身份恢复（§9.4）', () => {
  let db: Database.Database
  let registry: SqliteSessionIdentityRegistry

  beforeAll(() => {
    db = new Database(':memory:')
    runMigrations(db)
    registry = new SqliteSessionIdentityRegistry(db)
  })

  afterAll(() => db.close())

  it('getSessionFilePath：内存 miss 时回退注册表', async () => {
    const store = new PiSessionStore()
    store.setIdentityRegistry(registry)
    registry.put('evicted-thread', '/sessions/evicted.jsonl')

    // 无内存会话（模拟 LRU 淘汰/重启）→ 仍能拿到路径
    expect(await store.getSessionFilePath('evicted-thread')).toBe('/sessions/evicted.jsonl')
    expect(await store.getSessionFilePath('unknown-thread')).toBeNull()
    store.dispose()
  })

  it('chat 线程命中注册表时把 resumePath 传给工厂；plugin:* 线程不恢复', async () => {
    registry.put('chat-thread', '/sessions/chat.jsonl')

    // mock 与真实 AgentSession 形态一致：路径暴露为 sessionFile getter
    const factory = vi.fn(async (threadId: string, ctx?: { resumePath?: string }) => ({
      threadId,
      get sessionFile() {
        return `/sessions/${threadId}.jsonl`
      },
    }))
    const store = new PiSessionStore()
    store.setIdentityRegistry(registry)
    store.setSessionFactory(factory)

    await store.getOrCreate('chat-thread')
    expect(factory).toHaveBeenCalledWith('chat-thread', { resumePath: '/sessions/chat.jsonl' })

    await store.getOrCreate('plugin:novel:new')
    const pluginCall = factory.mock.calls.find(([id]) => id === 'plugin:novel:new')
    expect(pluginCall?.[1]).toBeUndefined()
    store.dispose()
  })

  it('会话创建成功后异步持久化 threadId → sessionPath', async () => {
    const store = new PiSessionStore()
    store.setIdentityRegistry(registry)
    store.setSessionFactory(async (threadId: string) => ({
      threadId,
      get sessionFile() {
        return `/sessions/${threadId}.jsonl`
      },
    }))

    await store.getOrCreate('fresh-chat-thread')
    // persistSessionIdentity 是 fire-and-forget；vi.waitFor 默认只等 1s，
    // 全量并行时 worker 被抢占会让它饿过预算（表现为 expected null）。
    // 这里给显式宽裕预算，只放宽等待，不改变断言。
    await vi.waitFor(
      () => {
        expect(registry.get('fresh-chat-thread')).toBe('/sessions/fresh-chat-thread.jsonl')
      },
      { timeout: 15_000, interval: 50 }
    )
    store.dispose()
  })

  it('plugin:* 线程不写入注册表', async () => {
    const store = new PiSessionStore()
    store.setIdentityRegistry(registry)
    store.setSessionFactory(async (threadId: string) => ({
      threadId,
      get sessionFile() {
        return `/sessions/${threadId}.jsonl`
      },
    }))

    await store.getOrCreate('plugin:novel:one-shot')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(registry.get('plugin:novel:one-shot')).toBeNull()
    store.dispose()
  })
})
