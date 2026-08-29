import { act, cleanup, renderHook } from '@testing-library/react'
import type { BaseEvent } from '@repo/protocol/events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { parseSseStreamMock, fetchMock, submitCheckpointDecisionMock, sendFlowMessageMock } = vi.hoisted(() => ({
  parseSseStreamMock: vi.fn(),
  fetchMock: vi.fn(),
  submitCheckpointDecisionMock: vi.fn().mockResolvedValue(undefined),
  sendFlowMessageMock: vi.fn()
}))

vi.mock('@/api/agui-client', () => ({
  parseSseStream: parseSseStreamMock
}))

vi.mock('@/api/novel-client', () => ({
  submitCheckpointDecision: submitCheckpointDecisionMock,
  persistChapterChat: vi.fn().mockResolvedValue(undefined),
  sendFlowMessage: sendFlowMessageMock
}))

vi.mock('@repo/config/browser', () => ({
  browserConfig: { apiBaseUrl: 'http://test.local' }
}))

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))
  sendFlowMessageMock.mockResolvedValue({ messageId: 'interject-1', status: 'queued' })
  vi.stubGlobal('fetch', fetchMock)
  parseSseStreamMock.mockImplementation(
    async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
      onEvent({
        type: 'CUSTOM',
        name: 'novel:progress',
        value: {
          timestamp: 1,
          type: 'phase_change',
          phase: 'directing',
          data: {
            message: '导演 Agent 正在等待 LLM 响应...（已等待 10s）',
            type: 'phase_change'
          }
        }
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
            type: 'phase_change'
          }
        }
      } as unknown as BaseEvent)
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useNovelCreationFlow progress', () => {
  it('formats the persisted lengdu quality report with all reader gates and isolation status', async () => {
    const { formatDetailBubble } = await import('../use-novel-creation-flow')

    const result = formatDetailBubble({
      kind: 'lengdu_quality_report',
      status: 'degraded',
      calibration: 'independent',
      reader: 'self_review',
      comprehension: 'passed',
      fluency: 'needs_attention',
      appeal: 'unverified',
      revisionCount: 1,
      summary: '中段有些卡，未完成独立 Reader 复核。',
    })

    expect(result).toMatchObject({ agentType: 'lengdu', agentName: 'lengdu 读感' })
    expect(result.content).toContain('看懂：通过')
    expect(result.content).toContain('流畅：待关注')
    expect(result.content).toContain('好看：未验证')
    expect(result.content).toContain('独立校准完成；Reader 自审降级')
    expect(result.content).toContain('中段有些卡')
  })

  it('formats the lengdu reader packet report as a cold-read bubble', async () => {
    const { formatDetailBubble } = await import('../use-novel-creation-flow')

    const result = formatDetailBubble({
      kind: 'lengdu_reader_packet',
      round: 0,
      packetIndex: 2,
      packetCount: 5,
      report: '## 这段读感\n- 看懂：一眼懂\n- 流畅：卡了一下',
    })

    expect(result).toMatchObject({ agentType: 'lengdu', agentName: 'lengdu Reader' })
    expect(result.content).toContain('第 1 轮 事件包 2/5')
    expect(result.content).toContain('流畅：卡了一下')
  })

  it('create-flow 的 phase_change 只覆盖单条进度，不追加对话', async () => {
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    expect(result.current.progressMessage).toBe('导演 Agent 正在等待 LLM 响应...（已等待 20s）')
    expect(result.current.agentOutputs).toHaveLength(0)
    expect(result.current.events).toHaveLength(2)
  })

  it('群聊改消费事件 tail：agui 镜像流式事件只覆盖单条进度，不追加对话', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        // 事件 tail 的事件形如 { type, seq, payload }；agui.payload 即旧 SSE 的
        // AG-UI 事件原样（TEXT_MESSAGE_* / CUSTOM novel:progress 等），直接进 handleEvent
        onEvent({
          type: 'agui',
          payload: {
            type: 'CUSTOM',
            name: 'novel:progress',
            value: {
              timestamp: 1,
              type: 'phase_change',
              phase: 'directing',
              data: { message: '导演 Agent 正在等待 LLM 响应...（已等待 10s）', type: 'phase_change' }
            }
          }
        } as unknown as BaseEvent)
        onEvent({
          type: 'agui',
          payload: {
            type: 'CUSTOM',
            name: 'novel:progress',
            value: {
              timestamp: 2,
              type: 'phase_change',
              phase: 'directing',
              data: { message: '导演 Agent 正在等待 LLM 响应...（已等待 20s）', type: 'phase_change' }
            }
          }
        } as unknown as BaseEvent)
      }
    )
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/create-discussion')) {
        return new Response(
          JSON.stringify({ ok: true, runId: 'run-tail-1', eventsPath: '/projects/project-1/discussion-runs/run-tail-1/events' }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('ok', { status: 200 })
    })
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startDiscussion('project-1', 1)
    })

    // POST 只受理：请求体发给 create-discussion，事件流走 GET events tail
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(calledUrls.some(url => url.includes('/create-discussion'))).toBe(true)
    expect(calledUrls.some(url => url.includes('/discussion-runs/run-tail-1/events'))).toBe(true)
    expect(result.current.progressMessage).toBe('导演 Agent 正在等待 LLM 响应...（已等待 20s）')
    expect(result.current.agentOutputs).toHaveLength(0)
    expect(result.current.events).toHaveLength(2)
  })

  it('提交决策后保留已处理的检查点和选择', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        onEvent({
          type: 'CUSTOM',
          name: 'novel:checkpoint',
          value: {
            type: 'post_write_guard',
            phase: 'rewriting',
            checkpointId: 'checkpoint-1',
            createdAt: 123,
            data: { reason: '正文过短', details: '实际 1200 字' }
          }
        } as unknown as BaseEvent)
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })
    await act(async () => {
      await result.current.submitCheckpoint('revise')
    })

    expect(submitCheckpointDecisionMock).toHaveBeenCalledWith(
      'project-1',
      'checkpoint-1',
      'revise',
      []
    )
    expect(result.current.currentCheckpoint).toBeNull()
    expect(result.current.checkpointHistory).toEqual([
      expect.objectContaining({
        checkpointId: 'checkpoint-1',
        createdAt: 123,
        decision: 'revise',
        resolvedAt: expect.any(Number)
      })
    ])
  })

  it('Reviser 的工具回执不清空或覆盖 Writer 已流出的正文', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        const progress = (
          messageId: string,
          agentType: 'writer' | 'reviser',
          agentName: string
        ): void => {
          onEvent({
            type: 'CUSTOM',
            name: 'novel:progress',
            value: {
              timestamp: Date.now(),
              type: 'agent_start',
              phase: agentType === 'writer' ? 'writing' : 'revising',
              data: { type: 'agent_start', messageId, agentType, agentName }
            }
          } as unknown as BaseEvent)
        }
        const text = (messageId: string, delta: string): void => {
          onEvent({ type: 'TEXT_MESSAGE_START', messageId } as unknown as BaseEvent)
          onEvent({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta } as unknown as BaseEvent)
          onEvent({ type: 'TEXT_MESSAGE_END', messageId } as unknown as BaseEvent)
        }

        progress('writer-message', 'writer', '写作')
        text('writer-message', '这是原始正文。')
        progress('reviser-message', 'reviser', '修订')
        text('reviser-message', '已应用 2 处修订。')
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    expect(result.current.chapterContent).toBe('这是原始正文。')
    expect(result.current.agentOutputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentType: 'reviser',
          content: '已应用 2 处修订。',
          preview: '已应用 2 处修订。',
          streaming: false
        })
      ])
    )
  })

  it('Reviser 只有工具调用时显示明确完成文案并结束 streaming', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
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
              message: '修订 Agent 已启动...'
            }
          }
        } as unknown as BaseEvent)
        onEvent({
          type: 'TEXT_MESSAGE_START',
          messageId: 'reviser-tool-only'
        } as unknown as BaseEvent)
        onEvent({
          type: 'TEXT_MESSAGE_END',
          messageId: 'reviser-tool-only'
        } as unknown as BaseEvent)
      }
    )
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
        streaming: false
      })
    ])
  })

  it('没有 agent_start 映射时，按当前阶段补建其他角色的实时输出', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 10,
            type: 'phase_change',
            phase: 'writing',
            data: { type: 'phase_change', message: '写作 Agent 正在生成...' }
          }
        } as unknown as BaseEvent)
        onEvent({ type: 'TEXT_MESSAGE_START', messageId: 'writer-without-start' } as unknown as BaseEvent)
        onEvent({
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: 'writer-without-start',
          delta: '这一段正文应该立即显示。'
        } as unknown as BaseEvent)
        onEvent({ type: 'TEXT_MESSAGE_END', messageId: 'writer-without-start' } as unknown as BaseEvent)
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    expect(result.current.agentOutputs).toEqual([
      expect.objectContaining({
        messageId: 'writer-without-start',
        agentType: 'writer',
        content: '这一段正文应该立即显示。',
        streaming: false
      })
    ])
  })

  it('详情事件时间戳回退时仍排在导演启动输出之后', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 100,
            type: 'agent_start',
            phase: 'directing',
            data: {
              type: 'agent_start',
              messageId: 'director-order',
              agentType: 'director',
              agentName: '导演',
              message: '导演已启动'
            }
          }
        } as unknown as BaseEvent)
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 90,
            type: 'phase_change',
            phase: 'directing',
            data: {
              type: 'phase_change',
              message: '叙事任务已提交',
              detail: {
                kind: 'narrative_task',
                description: '推进主线',
                taskType: 'advance_mainline',
                priority: 'medium'
              }
            }
          }
        } as unknown as BaseEvent)
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    expect(result.current.agentOutputs.map((output) => output.agentName)).toEqual(['导演', '导演'])
    expect(result.current.agentOutputs[1].timestamp).toBeGreaterThan(result.current.agentOutputs[0].timestamp)
  })

  it('缺失 messageId 的导演流不会覆盖排在前面的详情气泡', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 1,
            type: 'phase_change',
            phase: 'directing',
            data: {
              type: 'phase_change',
              detail: {
                kind: 'narrative_task',
                description: '先梳理本章冲突',
                taskType: 'advance_mainline',
                priority: 'medium'
              }
            }
          }
        } as unknown as BaseEvent)
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 2,
            type: 'agent_start',
            phase: 'directing',
            data: {
              type: 'agent_start',
              messageId: 'director-missing-id',
              agentType: 'director',
              agentName: '导演',
              message: '导演已启动'
            }
          }
        } as unknown as BaseEvent)
        onEvent({ type: 'TEXT_MESSAGE_START' } as unknown as BaseEvent)
        onEvent({
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: '   ',
          delta: '导演的流式输出'
        } as unknown as BaseEvent)
        onEvent({ type: 'TEXT_MESSAGE_END' } as unknown as BaseEvent)
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    const detailOutput = result.current.agentOutputs.find((output) => !output.messageId)
    const directorOutput = result.current.agentOutputs.find(
      (output) => output.messageId === 'director-missing-id'
    )

    expect(detailOutput).toEqual(
      expect.objectContaining({ content: expect.stringContaining('先梳理本章冲突') })
    )
    expect(detailOutput?.content).not.toContain('导演的流式输出')
    expect(directorOutput).toEqual(
      expect.objectContaining({ content: '导演的流式输出', streaming: false })
    )
  })

  it('思考流式 delta 进入 thinking 字段，正文 delta 到达后取代思考', async () => {
    vi.useFakeTimers()
    try {
      parseSseStreamMock.mockImplementationOnce(
        async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
          onEvent({
            type: 'CUSTOM',
            name: 'novel:progress',
            value: {
              timestamp: 1,
              type: 'agent_start',
              phase: 'directing',
              data: {
                type: 'agent_start',
                messageId: 'dir-thinking',
                agentType: 'director',
                agentName: '导演 Agent',
                message: '导演 Agent 已启动，正在向 AI 发送请求...'
              }
            }
          } as unknown as BaseEvent)
          // 思考 delta（推理模型）：REASONING 与 THINKING 成对发射，后者为准
          onEvent({
            type: 'THINKING_TEXT_MESSAGE_CONTENT',
            messageId: 'dir-thinking',
            delta: '先梳理本章叙事任务，'
          } as unknown as BaseEvent)
          onEvent({
            type: 'REASONING_MESSAGE_CONTENT',
            messageId: 'dir-thinking',
            delta: '应被忽略的重复事件'
          } as unknown as BaseEvent)
          onEvent({
            type: 'THINKING_TEXT_MESSAGE_CONTENT',
            messageId: 'dir-thinking',
            delta: '再决定场景数量。'
          } as unknown as BaseEvent)
        }
      )
      const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
      const { result } = renderHook(() => useNovelCreationFlow())

      await act(async () => {
        await result.current.startCreation('project-1', 1)
      })
      // 触发 100ms 兜底 flush（rAF 批处理合并思考 delta）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150)
      })

      // 思考进入 thinking 字段：占位文案保留在 content，章节正文不被污染
      expect(result.current.agentOutputs).toHaveLength(1)
      expect(result.current.agentOutputs[0]).toEqual(
        expect.objectContaining({
          messageId: 'dir-thinking',
          thinking: '先梳理本章叙事任务，再决定场景数量。',
          content: '导演 Agent 已启动，正在向 AI 发送请求...'
        })
      )
      expect(result.current.chapterContent).toBe('')
      expect(result.current.progressMessage).toBe('导演 Agent 正在思考...')
    } finally {
      vi.useRealTimers()
    }
  })

  it('纯思考无正文的消息结束时保留思考供完成态展示', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 1,
            type: 'agent_start',
            phase: 'directing',
            data: {
              type: 'agent_start',
              messageId: 'dir-think-only',
              agentType: 'director',
              agentName: '导演 Agent',
              message: '导演 Agent 已启动，正在向 AI 发送请求...'
            }
          }
        } as unknown as BaseEvent)
        // 思考后直接 END（无 TEXT_MESSAGE_CONTENT）：END 同步合并残留思考
        onEvent({
          type: 'THINKING_TEXT_MESSAGE_CONTENT',
          messageId: 'dir-think-only',
          delta: '本章应聚焦主线推进。'
        } as unknown as BaseEvent)
        onEvent({ type: 'TEXT_MESSAGE_START', messageId: 'dir-think-only' } as unknown as BaseEvent)
        onEvent({ type: 'TEXT_MESSAGE_END', messageId: 'dir-think-only' } as unknown as BaseEvent)
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    expect(result.current.agentOutputs).toEqual([
      expect.objectContaining({
        messageId: 'dir-think-only',
        thinking: '本章应聚焦主线推进。',
        streaming: false
      })
    ])
  })

  it('Director 工具提交事件显示完整场景计划并覆盖启动占位', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 1,
            type: 'agent_start',
            phase: 'directing',
            data: {
              type: 'agent_start',
              messageId: 'director-tool-only',
              agentType: 'director',
              agentName: '导演',
              message: '导演已启动，正在向 AI 发送请求...'
            }
          }
        } as unknown as BaseEvent)
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 2,
            type: 'agent_output',
            phase: 'directing',
            data: {
              type: 'agent_output',
              agentType: 'director',
              agentName: '导演',
              content: '## 场景拆分计划（已通过工具提交）\n\n### 场景1：客厅对峙\n- 地点：客厅\n- 时间：傍晚\n- 冲突：父子冲突\n- 目标：展现对立\n- 情绪：警惕转震惊\n- 在场角色：赵岩'
            }
          }
        } as unknown as BaseEvent)
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    expect(result.current.agentOutputs).toEqual([
      expect.objectContaining({
        messageId: 'director-tool-only',
        agentType: 'director',
        content: expect.stringContaining('- 地点：客厅'),
        preview: expect.stringContaining('场景拆分计划'),
        streaming: false
      })
    ])
    expect(result.current.agentOutputs[0].content).toContain('- 在场角色：赵岩')
  })

  it('正文开始后到达的思考 delta 不覆盖正文', async () => {
    vi.useFakeTimers()
    try {
      parseSseStreamMock.mockImplementationOnce(
        async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
          onEvent({
            type: 'CUSTOM',
            name: 'novel:progress',
            value: {
              timestamp: 1,
              type: 'agent_start',
              phase: 'writing',
              data: {
                type: 'agent_start',
                messageId: 'writer-msg',
                agentType: 'writer',
                agentName: '写作 Agent',
                message: '写作 Agent 已启动，正在向 AI 发送请求...'
              }
            }
          } as unknown as BaseEvent)
          onEvent({ type: 'TEXT_MESSAGE_START', messageId: 'writer-msg' } as unknown as BaseEvent)
          onEvent({
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: 'writer-msg',
            delta: '夜色沉下去。'
          } as unknown as BaseEvent)
          // 正文已开始后的思考 delta：应被丢弃，不进入 thinking 也不覆盖正文
          onEvent({
            type: 'THINKING_TEXT_MESSAGE_CONTENT',
            messageId: 'writer-msg',
            delta: '迟到的思考'
          } as unknown as BaseEvent)
          onEvent({ type: 'TEXT_MESSAGE_END', messageId: 'writer-msg' } as unknown as BaseEvent)
        }
      )
      const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
      const { result } = renderHook(() => useNovelCreationFlow())

      await act(async () => {
        await result.current.startCreation('project-1', 1)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150)
      })

      expect(result.current.agentOutputs[0]).toEqual(
        expect.objectContaining({
          messageId: 'writer-msg',
          content: '夜色沉下去。',
          hasStreamedText: true,
          // 2026-08-24：迟到的思考 delta 也累积，气泡内可展开（不再丢弃）
          thinking: '迟到的思考'
        })
      )
      // 思考绝不进入章节正文
      expect(result.current.chapterContent).toBe('夜色沉下去。')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumeWorkflow 使用工作流断点续跑端点并恢复 workflow 模式', async () => {
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.resumeWorkflow('project-1', 7, 'failed-run')
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test.local/api/plugins/novel/projects/project-1/chapters/7/create-flow/failed-run/resume',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('resumeWorkflow 支持 latest 快照恢复入口', async () => {
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.resumeWorkflow('project-1', 7, 'latest')
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test.local/api/plugins/novel/projects/project-1/chapters/7/create-flow/latest/resume',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('reRevise 把当前选择的模型传给定向修订端点', async () => {
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())
    const modelId = { provider: 'selected-provider', modelId: 'selected-model', thinkingLevel: 'medium' as const }

    await act(async () => {
      await result.current.reRevise('project-1', 7, '待修订正文', { modelId })
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test.local/api/plugins/novel/projects/project-1/chapters/7/re-revise',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: '待修订正文', modelId }),
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('reverseArrange 把当前选择的模型传给反推编排端点', async () => {
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())
    const modelId = { provider: 'selected-provider', modelId: 'selected-model', thinkingLevel: 'medium' as const }

    await act(async () => {
      await result.current.reverseArrange('project-1', 7, { modelId })
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test.local/api/plugins/novel/projects/project-1/chapters/7/reverse-arrange',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ modelId }),
      }),
    )
  })

  it('定向插话把 targetAgent 传给运行级端点，并保留在本地 queued 状态', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        onEvent({ type: 'RUN_STARTED', runId: 'workflow-run-1' } as unknown as BaseEvent)
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 3)
    })
    await act(async () => {
      await result.current.sendInterject('核对旧案伏笔', 'memory')
    })

    expect(sendFlowMessageMock).toHaveBeenCalledWith('project-1', 'workflow-run-1', {
      content: '核对旧案伏笔',
      targetAgent: 'memory',
      chapterNumber: 3
    })
    expect(result.current.interjectMessages).toEqual([
      expect.objectContaining({
        messageId: 'interject-1',
        content: '核对旧案伏笔',
        targetAgent: 'memory',
        status: 'queued'
      })
    ])
  })

  it('角色工具回合覆盖启动占位气泡，公开正文与私有判断分层', async () => {
    parseSseStreamMock.mockImplementationOnce(
      async (_body: unknown, onEvent: (event: BaseEvent) => void) => {
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 1,
            type: 'agent_start',
            phase: 'acting',
            data: {
              type: 'agent_start',
              messageId: 'char-zhao-turn',
              agentType: 'character',
              agentName: '赵岩',
              message: '赵岩 已启动，正在向 AI 发送请求...'
            }
          }
        } as unknown as BaseEvent)
        // 工具主路径：没有任何 TEXT_MESSAGE_*，终答为空 stop
        onEvent({
          type: 'CUSTOM',
          name: 'novel:progress',
          value: {
            timestamp: 2,
            type: 'agent_output',
            phase: 'acting',
            data: {
              type: 'agent_output',
              agentType: 'character',
              agentName: '赵岩',
              messageId: 'msg-turn-1',
              content: '[赵岩抬手挡住门] “先别进来，外面有人。”',
              actorTurn: {
                innerThought: '他担心门外的人已经听见了。',
                conflictReading: '门外的脚步声正在逼近。',
                responsePlan: '先试探，再决定是否撤离。',
                consequence: '门外的人停了一下。'
              }
            }
          }
        } as unknown as BaseEvent)
      }
    )
    const { useNovelCreationFlow } = await import('../use-novel-creation-flow')
    const { result } = renderHook(() => useNovelCreationFlow())

    await act(async () => {
      await result.current.startCreation('project-1', 1)
    })

    // 占位被覆盖：只有一条角色气泡，且已结束 streaming
    expect(result.current.agentOutputs).toHaveLength(1)
    expect(result.current.agentOutputs[0]).toMatchObject({
      agentType: 'character',
      agentName: '赵岩',
      streaming: false
    })
    // 公开正文进气泡内容；私有判断只在 actorTurn 里，不混入 content
    expect(result.current.agentOutputs[0].content).toContain('先别进来')
    expect(result.current.agentOutputs[0].content).not.toContain('担心门外的人')
    expect(result.current.agentOutputs[0].actorTurn).toMatchObject({
      innerThought: '他担心门外的人已经听见了。',
      responsePlan: '先试探，再决定是否撤离。'
    })
    // 角色演出不得进入章节正文
    expect(result.current.chapterContent).toBe('')
  })
})
