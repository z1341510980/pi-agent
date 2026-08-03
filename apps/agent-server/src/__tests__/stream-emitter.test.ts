import { EventType, type BaseEvent } from '@ag-ui/core'
import { describe, expect, it, vi } from 'vitest'
import { StreamEmitter } from '../core/agent/stream-emitter.js'

function createReasoningPipelineStub() {
  return {
    ensureReasoningTargetMessage: vi.fn(),
    emitNativeReasoningStart: vi.fn(),
    ensureNativeReasoningStart: vi.fn(() => 'reasoning-1'),
    emitReasoningCompatEvent: vi.fn(),
    emitNativeReasoningEnd: vi.fn(),
  } as any
}

describe('StreamEmitter', () => {
  it('emitTextChunk 发出 TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.emitTextChunk('你好')

    expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START)
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT)
    expect((events[1] as any).delta).toBe('你好')
  })

  it('finishTextMessage 发出 TEXT_MESSAGE_END', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.emitTextChunk('hello')
    emitter.finishTextMessage()

    const endEvent = events.find((e) => e.type === EventType.TEXT_MESSAGE_END)
    expect(endEvent).toBeDefined()
  })

  it('没有文本但结束时仍关闭工具型 Agent 的占位消息', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-tool-only',
      createReasoningPipelineStub(),
    )

    emitter.finishTextMessage()

    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_END,
    ])
    expect((events[0] as any).messageId).toBe('msg-tool-only')
    expect((events[1] as any).messageId).toBe('msg-tool-only')
  })

  it('handleSessionEvent 处理 tool_execution_start', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.handleSessionEvent({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'tc-1',
    } as any)

    expect(events.some((e) => e.type === EventType.STEP_STARTED)).toBe(true)
    expect(events.some((e) => e.type === EventType.ACTIVITY_SNAPSHOT)).toBe(true)
  })

  it('handleSessionEvent 处理 tool_execution_end', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.handleSessionEvent({
      type: 'tool_execution_end',
      toolName: 'read',
      toolCallId: 'tc-1',
    } as any)

    expect(events.some((e) => e.type === EventType.STEP_FINISHED)).toBe(true)
  })

  it('handleSessionEvent 处理 message_update text_delta', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.handleSessionEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: '世界',
      },
    } as any)

    const contentEvents = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    )
    expect(contentEvents.length).toBeGreaterThan(0)
  })

  it('handleSessionEvent 处理 tool_execution_update 发出 CUSTOM 事件', () => {
    const events: BaseEvent[] = []
    const emitter = new StreamEmitter(
      (event) => events.push(event),
      'msg-1',
      createReasoningPipelineStub(),
    )

    emitter.handleSessionEvent({
      type: 'tool_execution_update',
      toolName: 'bash',
      toolCallId: 'tc-2',
      args: { command: 'ls' },
      partialResult: 'file1.txt\nfile2.txt',
    } as any)

    const customEvent = events.find(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as any).name === 'PI_TOOL_EXECUTION_UPDATE',
    )
    expect(customEvent).toBeDefined()
  })

  describe('tool_result 转发结构化 details', () => {
    function emitToolResult(details: unknown, extra: Record<string, unknown> = {}) {
      const events: BaseEvent[] = []
      const emitter = new StreamEmitter(
        (event) => events.push(event),
        'msg-1',
        createReasoningPipelineStub(),
        { emitRaw: false },
      )
      emitter.handleSessionEvent({
        type: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'edit',
        details,
        ...extra,
      })
      return events.find((e) => (e as any).name === 'PI_TOOL_RESULT') as any
    }

    it('转发 diff / patch 等字段', () => {
      const event = emitToolResult({ diff: '+a\n-b', patch: '@@ -1 +1 @@', firstChangedLine: 12 })

      expect(event).toBeDefined()
      expect(event.value.toolCallId).toBe('call-1')
      expect(event.value.details.diff).toBe('+a\n-b')
      expect(event.value.details.firstChangedLine).toBe(12)
      expect(event.value.isError).toBe(false)
    })

    it('details 为空时不发事件（多数工具没有结构化结果）', () => {
      expect(emitToolResult(undefined)).toBeUndefined()
      expect(emitToolResult(null)).toBeUndefined()
    })

    it('isError 透传', () => {
      const event = emitToolResult({ diff: '+a' }, { isError: true })
      expect(event.value.isError).toBe(true)
    })

    it('超长字符串被截断并打标记', () => {
      const huge = 'x'.repeat(70_000)
      const event = emitToolResult({ diff: huge })

      expect(event.value.details.diff.length).toBe(64_000)
      expect(event.value.details.diffTruncated).toBe(true)
    })

    it('未超长的字段不打截断标记', () => {
      const event = emitToolResult({ diff: 'short' })
      expect(event.value.details.diffTruncated).toBeUndefined()
    })
  })
})
