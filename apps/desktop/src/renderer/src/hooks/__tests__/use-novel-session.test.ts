import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../use-novel-creation-flow', () => ({
  useNovelCreationFlow: () => ({
    phase: 'idle',
    isRunning: false,
    result: null,
  })
}))

vi.mock('../use-chapter-chat', () => ({
  useChapterChat: () => ({
    isRunning: false,
    agentOutputs: [],
  })
}))

describe('useNovelSession', () => {
  it('returns an idle session when no runner is active', async () => {
    const { useNovelSession } = await import('../use-novel-session')
    const { result } = renderHook(() => useNovelSession())
    expect(result.current.activeRun).toEqual({ kind: 'idle', isRunning: false })
  })

  it('exposes stable cross-run actions without changing the underlying runners', async () => {
    const { useNovelSession } = await import('../use-novel-session')
    const { result } = renderHook(() => useNovelSession())

    expect(typeof result.current.startWorkflow).toBe('function')
    expect(typeof result.current.startDiscussion).toBe('function')
    expect(typeof result.current.resumeWorkflow).toBe('function')
    expect(typeof result.current.resumeDiscussion).toBe('function')
    expect(typeof result.current.sendChat).toBe('function')
    expect(typeof result.current.abortChat).toBe('function')
    expect(typeof result.current.sendInterject).toBe('function')
  })
})
