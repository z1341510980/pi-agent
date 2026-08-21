/**
 * selectSessionManager 单元测试（§10.12-1 会话隔离 + §9.4 恢复分支）。
 *
 * 关键契约：共享 SessionManager 不再作为任何线程的会话本体。Pi 的 SessionManager
 * 持有单个 sessionId/sessionFile/leafId，多线程复用会让历史互相串扰。
 */
import { describe, expect, it, vi } from 'vitest'
import { selectSessionManager } from '../core/agent/pi-session.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

const created = { created: true } as unknown as SessionManager
const opened = { opened: true } as unknown as SessionManager

function input(overrides: Partial<Parameters<typeof selectSessionManager>[0]>) {
  return {
    isPluginThread: false,
    cwd: '/cwd',
    sessionDir: '/sessions',
    newId: () => 'fixed-id',
    createManager: vi.fn(() => created),
    openManager: vi.fn(() => opened),
    ...overrides,
  }
}

describe('selectSessionManager', () => {
  it('plugin:* 线程每次新建独立 SessionManager', () => {
    const ctx = input({ isPluginThread: true })
    expect(selectSessionManager(ctx)).toBe(created)
    expect(ctx.createManager).toHaveBeenCalledWith('/cwd', '/sessions', { id: 'fixed-id' })
    expect(ctx.openManager).not.toHaveBeenCalled()
  })

  it('chat 线程 + resumePath：用 SessionManager.open 恢复既有 JSONL', () => {
    const ctx = input({ resumePath: '/sessions/old.jsonl' })
    expect(selectSessionManager(ctx)).toBe(opened)
    expect(ctx.openManager).toHaveBeenCalledWith('/sessions/old.jsonl', '/sessions', '/cwd')
    expect(ctx.createManager).not.toHaveBeenCalled()
  })

  it('chat 线程无 resumePath：同样新建，不复用共享实例', () => {
    const ctx = input({})
    expect(selectSessionManager(ctx)).toBe(created)
    expect(ctx.createManager).toHaveBeenCalledWith('/cwd', '/sessions', { id: 'fixed-id' })
    expect(ctx.openManager).not.toHaveBeenCalled()
  })

  it('两个首次新建的 chat 线程拿到不同 SessionManager 与不同 session id', () => {
    const instances: Array<{ id: string }> = []
    const createManager = vi.fn((_cwd: string, _dir: string, meta: { id: string }) => {
      const instance = { id: meta.id }
      instances.push(instance)
      return instance as unknown as SessionManager
    })
    let counter = 0
    const newId = () => `session-${++counter}`

    const first = selectSessionManager(input({ createManager, newId }))
    const second = selectSessionManager(input({ createManager, newId }))

    expect(first).not.toBe(second)
    expect(instances.map((item) => item.id)).toEqual(['session-1', 'session-2'])
  })

  it('plugin:* 线程即使误传 resumePath 也不恢复', () => {
    const ctx = input({ isPluginThread: true, resumePath: '/sessions/old.jsonl' })
    expect(selectSessionManager(ctx)).toBe(created)
    expect(ctx.openManager).not.toHaveBeenCalled()
  })
})
