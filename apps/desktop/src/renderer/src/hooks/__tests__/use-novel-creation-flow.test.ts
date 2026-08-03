import { act, cleanup, renderHook } from '@testing-library/react'
import type { BaseEvent } from '@repo/protocol/events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { parseSseStreamMock, fetchMock, submitCheckpointDecisionMock } = vi.hoisted(() => ({
  parseSseStreamMock: vi.fn(),
  fetchMock: vi.fn(),
  submitCheckpointDecisionMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/agui-client', () => ({
  parseSseStream: parseSseStreamMock,
}))

vi.mock('@/api/novel-client', () => ({
  submitCheckpointDecision: submitCheckpointDecisionMock,
  persistChapterChat: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@repo/config/browser', () => ({
  browserConfig: { apiBaseUrl: 'http://test.local' },
}))

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  parseSseStreamMock.mockImplementation(async (
    _body: unknown,
    onEvent: (event: BaseEvent) => void,
  ) => {
    onEvent({
      type: 'CUSTOM',
      name: 'novel:progress',
      value: {
        timestamp: 1,
        type: 'phase_change',
        phase: 'directing',
        data: {
          message: '导演 Agent 正在等待 LLM 响应...（已等待 10s）',
          type: 'phase_change',
        },
      },
    } as unknown as BaseEvent)
    onEvent({
      type: 'CUSTOM',
      name: 'novel:progress',
      value: {
        timestamp: 2,
        type: 'phase_change',
        phase: 'directing',
        data: {
          message: '导演 Agent 正在等待 LLM 响应...（已等待 20s）',
          type: 'phase_change',
        },
      },
    } as unknown as BaseEvent)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useNovelCreationFlow progress', () => {
  it.each([
    ['create-flow', 'startCreation'],
    ['群聊', 'startDiscussion'],
  ] as const)('%s 的 phase_change 只覆盖单条进度，不追加对话', async (_label, method) => {
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current[method]('project-1', 1)
    })

    expect(result.current.progressMessage).toBe('导演 Agent 正在等待 LLM 响应...（已等待 20s）')
    expect(result.current.agentOutputs).toHaveLength(0)
    expect(result.current.events).toHaveLength(2)
  })

  it('提交决策后保留已处理的检查点和选择', async () => {
    parseSseStreamMock.mockImplementationOnce(async (
      _body: unknown,
      onEvent: (event: BaseEvent) => void,
    ) => {
      onEvent({
        type: 'CUSTOM',
        name: 'novel:checkpoint',
        value: {
          type: 'post_write_guard',
          phase: 'rewriting',
          checkpointId: 'checkpoint-1',
          createdAt: 123,
          data: { reason: '正文过短', details: '实际 1200 字' },
        },
      } as unknown as BaseEvent)
    })
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })
    await act(async () => {
      await result.current.submitCheckpoint('revise')
    })

    expect(submitCheckpointDecisionMock).toHaveBeenCalledWith(
      'project-1', 'checkpoint-1', 'revise', [],
    )
    expect(result.current.currentCheckpoint).toBeNull()
    expect(result.current.checkpointHistory).toEqual([
      expect.objectContaining({
        checkpointId: 'checkpoint-1',
        createdAt: 123,
        decision: 'revise',
        resolvedAt: expect.any(Number),
      }),
    ])
  })

  it('Reviser 的工具回执不清空或覆盖 Writer 已流出的正文', async () => {
    parseSseStreamMock.mockImplementationOnce(async (
      _body: unknown,
      onEvent: (event: BaseEvent) => void,
    ) => {
      const progress = (messageId: string, agentType: 'writer' | 'reviser', agentName: string) => {
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: Date.now(),
            type: 'agent_start',
            phase: agentType === 'writer' ? 'writing' : 'revising',
            data: { type: 'agent_start', messageId, agentType, agentName },
          },
        } as unknown as BaseEvent)
      }
      const text = (messageId: string, delta: string) => {
        onEvent({ type: 'TEXT_MESSAGE_START', messageId } as unknown as BaseEvent)
        onEvent({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta } as unknown as BaseEvent)
        onEvent({ type: 'TEXT_MESSAGE_END', messageId } as unknown as BaseEvent)
      }

      progress('writer-message', 'writer', '写作')
      text('writer-message', '这是原始正文。')
      progress('reviser-message', 'reviser', '修订')
      text('reviser-message', '已应用 2 处修订。')
    })
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    expect(result.current.chapterContent).toBe('这是原始正文。')
    expect(result.current.agentOutputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentType: 'reviser',
        content: '已应用 2 处修订。',
        preview: '已应用 2 处修订。',
        streaming: false,
      }),
    ]))
  })

  it('Reviser 只有工具调用时显示明确完成文案并结束 streaming', async () => {
    parseSseStreamMock.mockImplementationOnce(async (
      _body: unknown,
      onEvent: (event: BaseEvent) => void,
    ) => {
      onEvent({
        type: 'CUSTOM',
        name: 'novel:progress',
        value: {
          timestamp: 123,
          type: 'agent_start',
          phase: 'revising',
          data: {
            type: 'agent_start',
            messageId: 'reviser-tool-only',
            agentType: 'reviser',
            agentName: '修订',
            message: '修订 Agent 已启动...',
          },
        },
      } as unknown as BaseEvent)
      onEvent({ type: 'TEXT_MESSAGE_START', messageId: 'reviser-tool-only' } as unknown as BaseEvent)
      onEvent({ type: 'TEXT_MESSAGE_END', messageId: 'reviser-tool-only' } as unknown as BaseEvent)
    })
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    expect(result.current.agentOutputs).toEqual([
      expect.objectContaining({
        messageId: 'reviser-tool-only',
        agentType: 'reviser',
        content: '修订已完成，正文已更新。',
        preview: '修订已完成，正文已更新。',
        streaming: false,
      }),
    ])
  })
})
