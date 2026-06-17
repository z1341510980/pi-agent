import { describe, expect, it } from 'vitest'
import { PiSessionStore } from '../core/agent/session-store.js'

describe('PiSessionStore', () => {
  it('getOrCreate 返回会话并记录', async () => {
    const store = new PiSessionStore()
    const mockSession = { id: 'session-1' } as any
    store.setSessionFactory(() => Promise.resolve(mockSession))

    const threadSession = await store.getOrCreate('thread-1')
    expect(threadSession.threadId).toBe('thread-1')
    expect(threadSession.session).toBe(mockSession)
  })

  it('getOrCreate 相同 threadId 返回同一会话', async () => {
    const store = new PiSessionStore()
    const mockSession = { id: 'session-1' } as any
    store.setSessionFactory(() => Promise.resolve(mockSession))

    const s1 = await store.getOrCreate('thread-1')
    const s2 = await store.getOrCreate('thread-1')
    expect(s1).toBe(s2)
  })

  it('getStats 返回活跃会话数', async () => {
    const store = new PiSessionStore()
    const mockSession = { id: 'session-1' } as any
    store.setSessionFactory(() => Promise.resolve(mockSession))

    await store.getOrCreate('thread-1')
    await store.getOrCreate('thread-2')

    const stats = store.getStats()
    expect(stats.threadCount).toBe(2)
  })
})
