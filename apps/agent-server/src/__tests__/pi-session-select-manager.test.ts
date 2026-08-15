/**
 * selectSessionManager 单元测试（§9.4 会话恢复的 SessionManager 选择分支）。
 */
import { describe, expect, it, vi } from 'vitest'
import { selectSessionManager } from '../core/agent/pi-session.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

const shared = { shared: true } as unknown as SessionManager
const created = { created: true } as unknown as SessionManager
const opened = { opened: true } as unknown as SessionManager

function input(overrides: Partial<Parameters<typeof selectSessionManager>[0]>) {
  return {
    isPluginThread: false,
    cwd: '/cwd',
    sessionDir: '/sessions',
    sharedSessionManager: shared,
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

  it('chat 线程无 resumePath：复用共享 SessionManager', () => {
    const ctx = input({})
    expect(selectSessionManager(ctx)).toBe(shared)
    expect(ctx.createManager).not.toHaveBeenCalled()
    expect(ctx.openManager).not.toHaveBeenCalled()
  })
})
