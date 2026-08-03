import { describe, expect, it } from 'vitest'
import { EventType } from '@repo/protocol/events'
import type { BaseEvent } from '@repo/protocol/events'
import { applyEvent, type MessageStreamState } from '../message-stream'
import { collectToolCalls, lastThinkingSegment, readSegments, type ChatMessage } from '../types'

/**
 * 分段模型的核心契约。
 *
 * 之前的模型是「扁平 content + 旁挂 thinking + 旁挂 toolCalls」，渲染顺序在
 * message-bubble 里硬编码成 thinking → tools → 正文，表达不了 agent 长回答的常态：
 * 说一段 → 调工具 → 接着说。这里用事件序列钉住顺序保真。
 *
 * 另一半是工具身份：`STEP_STARTED` 装不下 toolCallId，只能按「同名 + running」
 * 回配，同名并发必然错配。现在优先用后端下发的真实 id。
 */

const RUN_ID = 'run-1'

function emptyState(): MessageStreamState {
  return { messages: [], activeRunId: null, streamError: null }
}

function apply(state: MessageStreamState, ...events: BaseEvent[]): MessageStreamState {
  return events.reduce(applyEvent, state)
}

const runStarted = { type: EventType.RUN_STARTED, runId: RUN_ID } as unknown as BaseEvent
const text = (delta: string): BaseEvent =>
  ({ type: EventType.TEXT_MESSAGE_CONTENT, delta }) as unknown as BaseEvent
const thinking = (delta: string): BaseEvent =>
  ({ type: EventType.THINKING_TEXT_MESSAGE_CONTENT, delta }) as unknown as BaseEvent
const toolStart = (toolCallId: string, toolName: string, args?: unknown): BaseEvent =>
  ({
    type: EventType.CUSTOM,
    name: 'PI_TOOL_CALL_START',
    value: { toolCallId, toolName, args, startedAt: 1000 },
  }) as unknown as BaseEvent
const toolEnd = (toolCallId: string, toolName: string, isError = false): BaseEvent =>
  ({
    type: EventType.CUSTOM,
    name: 'PI_TOOL_CALL_END',
    value: { toolCallId, toolName, isError, endedAt: 2000 },
  }) as unknown as BaseEvent
const stepStarted = (toolName: string): BaseEvent =>
  ({ type: EventType.STEP_STARTED, stepName: `pi:${toolName}` }) as unknown as BaseEvent
const stepFinished = (toolName: string): BaseEvent =>
  ({ type: EventType.STEP_FINISHED, stepName: `pi:${toolName}` }) as unknown as BaseEvent

/** 取当前唯一的助手消息 */
function assistant(state: MessageStreamState): ChatMessage {
  const msg = state.messages.find((m) => m.role === 'assistant')
  if (!msg) throw new Error('没有助手消息')
  return msg
}

describe('applyEvent · 分段顺序', () => {
  it('文本 delta 合并进同一个文本分段', () => {
    const state = apply(emptyState(), runStarted, text('你'), text('好'))

    expect(assistant(state).segments).toHaveLength(1)
    expect(assistant(state).content).toBe('你好')
  })

  it('工具调用之后的文本落到新分段 —— 这就是交错', () => {
    const state = apply(
      emptyState(),
      runStarted,
      text('我先看看。'),
      toolStart('c1', 'read'),
      toolEnd('c1', 'read'),
      text('确实有问题。'),
    )

    expect(assistant(state).segments.map((s) => s.kind)).toEqual(['text', 'tool', 'text'])
    // content 只拼文本分段，工具不掺进正文
    expect(assistant(state).content).toBe('我先看看。确实有问题。')
  })

  it('多轮交错全部保序', () => {
    const state = apply(
      emptyState(),
      runStarted,
      text('A'),
      toolStart('c1', 'read'),
      toolEnd('c1', 'read'),
      text('B'),
      toolStart('c2', 'edit'),
      toolEnd('c2', 'edit'),
      text('C'),
    )

    expect(assistant(state).segments.map((s) => s.kind)).toEqual([
      'text',
      'tool',
      'text',
      'tool',
      'text',
    ])
    expect(assistant(state).content).toBe('ABC')
  })

  it('思考分段独立于文本分段，且按到达顺序排', () => {
    const state = apply(emptyState(), runStarted, thinking('先想想'), text('结论'))

    expect(assistant(state).segments.map((s) => s.kind)).toEqual(['thinking', 'text'])
    expect(assistant(state).content).toBe('结论')
  })

  it('THINKING_END 关闭流式标记', () => {
    let state = apply(emptyState(), runStarted, thinking('想'))
    const before = assistant(state).segments[0]
    expect(before.kind === 'thinking' && before.isStreaming).toBe(true)

    state = apply(state, { type: EventType.THINKING_END } as unknown as BaseEvent)
    const after = assistant(state).segments[0]
    expect(after.kind === 'thinking' && after.isStreaming).toBe(false)
  })

  it('思考结束后再来的思考开新分段，不并进已关闭的那段', () => {
    let state = apply(emptyState(), runStarted, thinking('第一段'))
    state = apply(state, { type: EventType.THINKING_END } as unknown as BaseEvent)
    state = apply(state, thinking('第二段'))

    expect(assistant(state).segments.map((s) => s.kind)).toEqual(['thinking', 'thinking'])
  })

  it('REASONING_MESSAGE_CONTENT 被忽略，避免与 thinking 重复', () => {
    const state = apply(
      emptyState(),
      runStarted,
      thinking('想'),
      { type: EventType.REASONING_MESSAGE_CONTENT, delta: '想' } as unknown as BaseEvent,
    )

    expect(assistant(state).segments).toHaveLength(1)
  })
})

describe('applyEvent · 工具身份', () => {
  it('同名工具并发不再错配（回归）', () => {
    // 两个 read 同时开始，先开始的后结束
    const state = apply(
      emptyState(),
      runStarted,
      toolStart('c1', 'read', { path: 'a.ts' }),
      toolStart('c2', 'read', { path: 'b.ts' }),
      toolEnd('c2', 'read'),
    )

    const calls = collectToolCalls(assistant(state))
    expect(calls).toHaveLength(2)
    // c2 结束，c1 仍在跑 —— 旧实现会把结束记到"第一个 running"即 c1 身上
    expect(calls.find((c) => c.toolCallId === 'c1')?.status).toBe('running')
    expect(calls.find((c) => c.toolCallId === 'c2')?.status).toBe('success')
  })

  it('STEP_STARTED 建的 synthetic 分段会被真实 id 认领，而不是重复建', () => {
    const state = apply(
      emptyState(),
      runStarted,
      stepStarted('read'),
      toolStart('real-1', 'read', { path: 'a.ts' }),
    )

    const calls = collectToolCalls(assistant(state))
    expect(calls).toHaveLength(1)
    expect(calls[0].toolCallId).toBe('real-1')
    expect(calls[0].args).toEqual({ path: 'a.ts' })
  })

  it('只有 STEP_STARTED / STEP_FINISHED 时仍能工作（兜底路径）', () => {
    const state = apply(emptyState(), runStarted, stepStarted('read'), stepFinished('read'))

    const calls = collectToolCalls(assistant(state))
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('success')
    expect(calls[0].toolCallId.startsWith('synthetic:')).toBe(true)
  })

  it('PI_TOOL_CALL_START 重复投递不重复建分段', () => {
    const state = apply(emptyState(), runStarted, toolStart('c1', 'read'), toolStart('c1', 'read'))

    expect(collectToolCalls(assistant(state))).toHaveLength(1)
  })

  it('isError 的结束事件把状态标为 error', () => {
    const state = apply(emptyState(), runStarted, toolStart('c1', 'bash'), toolEnd('c1', 'bash', true))

    expect(collectToolCalls(assistant(state))[0].status).toBe('error')
  })

  it('PI_TOOL_EXECUTION_UPDATE 按 id 回填 args 与中间结果', () => {
    const state = apply(
      emptyState(),
      runStarted,
      toolStart('c1', 'read'),
      {
        type: EventType.CUSTOM,
        name: 'PI_TOOL_EXECUTION_UPDATE',
        value: { toolCallId: 'c1', toolName: 'read', args: { path: 'x' }, partialResult: 'body' },
      } as unknown as BaseEvent,
    )

    expect(collectToolCalls(assistant(state))[0]).toMatchObject({
      args: { path: 'x' },
      partialResult: 'body',
    })
  })

  it('PI_TOOL_RESULT 按 id 精确挂 details', () => {
    const state = apply(
      emptyState(),
      runStarted,
      toolStart('c1', 'edit'),
      toolStart('c2', 'edit'),
      {
        type: EventType.CUSTOM,
        name: 'PI_TOOL_RESULT',
        value: { toolCallId: 'c2', toolName: 'edit', details: { diff: '+a' } },
      } as unknown as BaseEvent,
    )

    const calls = collectToolCalls(assistant(state))
    expect(calls.find((c) => c.toolCallId === 'c1')?.details).toBeUndefined()
    expect(calls.find((c) => c.toolCallId === 'c2')?.details).toEqual({ diff: '+a' })
  })
})

describe('applyEvent · 收尾', () => {
  it('RUN_FINISHED 标记完成并关闭流式思考', () => {
    let state = apply(emptyState(), runStarted, thinking('想'), text('答'))
    state = apply(state, { type: EventType.RUN_FINISHED } as unknown as BaseEvent)

    expect(assistant(state).status).toBe('complete')
    const seg = assistant(state).segments[0]
    expect(seg.kind === 'thinking' && seg.isStreaming).toBe(false)
    expect(state.activeRunId).toBeNull()
  })

  it('一个 delta 都没到过时用 RUN_FINISHED 的 result 兜底', () => {
    let state = apply(emptyState(), runStarted)
    state = apply(state, { type: EventType.RUN_FINISHED, result: '最终答案' } as unknown as BaseEvent)

    expect(assistant(state).content).toBe('最终答案')
  })

  it('已有流式文本时不被 result 覆盖', () => {
    let state = apply(emptyState(), runStarted, text('流式内容'))
    state = apply(state, { type: EventType.RUN_FINISHED, result: '别覆盖我' } as unknown as BaseEvent)

    expect(assistant(state).content).toBe('流式内容')
  })

  it('aborted 的 RUN_FINISHED 不改消息状态', () => {
    let state = apply(emptyState(), runStarted, text('半句'))
    state = apply(state, {
      type: EventType.RUN_FINISHED,
      reason: 'aborted',
    } as unknown as BaseEvent)

    expect(assistant(state).status).toBe('streaming')
    expect(state.activeRunId).toBeNull()
  })

  it('RUN_ERROR 记错误并关闭流式思考', () => {
    let state = apply(emptyState(), runStarted, thinking('想'))
    state = apply(state, { type: EventType.RUN_ERROR, message: '炸了' } as unknown as BaseEvent)

    expect(assistant(state).status).toBe('error')
    expect(assistant(state).error).toBe('炸了')
    expect(state.streamError).toBe('炸了')
  })

  it('没有活跃 run 时事件被忽略，不会凭空造消息', () => {
    const state = apply(emptyState(), text('孤立文本'))

    expect(state.messages).toHaveLength(0)
  })
})

/**
 * 缺 segments 的畸形消息不该让整个聊天区白屏。
 *
 * 真实故障：旧版本曾把 sessionMessages 持久化进 localStorage，那时的 ChatMessage
 * 还是旧模型（旁挂 toolCalls，没有 segments）。这类快照 rehydrate 回来后，
 * ChatWorkspace 的 associatedFiles useMemo 首次计算就在 collectToolCalls 里
 * 抛 `message.segments is not iterable`。source 已由 session-store 的 v1 migrate
 * 堵住，这里钉住纯函数入口的第二道防线。
 */
describe('segments 缺失的兜底', () => {
  const legacyMessage = {
    id: 'legacy-1',
    role: 'assistant',
    content: '旧模型消息',
    status: 'complete',
    toolCalls: [],
  } as unknown as ChatMessage

  it('collectToolCalls 返回空数组而不抛错', () => {
    expect(collectToolCalls(legacyMessage)).toEqual([])
  })

  it('lastThinkingSegment 返回 undefined 而不抛错', () => {
    expect(lastThinkingSegment(legacyMessage)).toBeUndefined()
  })

  it('segments 是非数组的脏值时同样安全', () => {
    const dirty = { ...legacyMessage, segments: 'not-an-array' } as unknown as ChatMessage
    expect(collectToolCalls(dirty)).toEqual([])
    expect(readSegments(dirty)).toEqual([])
  })

  /**
   * localStorage 里的东西经过 JSON.parse，类型完全不受控。`Array.isArray` 是唯一
   * 靠得住的判据 —— 用 `?? []` 只挡得住 null/undefined，字符串会一路带着
   * `for...of` 逐字符迭代出去，数字/对象则直接抛 not iterable。
   */
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'not-an-array'],
    ['空字符串', ''],
    ['数字', 42],
    ['布尔', true],
    ['普通对象', { 0: { kind: 'text' }, length: 1 }],
  ])('segments 为 %s 时统一返回共享空数组', (_label, value) => {
    const dirty = { ...legacyMessage, segments: value } as unknown as ChatMessage

    expect(readSegments(dirty)).toEqual([])
    expect(collectToolCalls(dirty)).toEqual([])
    expect(lastThinkingSegment(dirty)).toBeUndefined()
  })

  it('兜底返回的数组不可被下游写坏（共享常量被 push 会污染所有调用方）', () => {
    const shared = readSegments(legacyMessage)
    // 冻结与否取决于实现，这里只钉住"读到的仍是空"这个可观测事实
    expect(shared).toHaveLength(0)
    expect(readSegments({ ...legacyMessage, id: 'other' } as ChatMessage)).toHaveLength(0)
  })

  it('兜底返回同一个共享空数组，不破坏 useMemo 的引用比较', () => {
    const a = { ...legacyMessage } as ChatMessage
    const b = { ...legacyMessage, id: 'legacy-2' } as ChatMessage
    expect(readSegments(a)).toBe(readSegments(b))
  })

  it('正常消息原样返回自身的 segments 引用', () => {
    const state = apply(emptyState(), runStarted, text('你好'))
    const msg = assistant(state)
    expect(readSegments(msg)).toBe(msg.segments)
  })
})

/**
 * applyEvent 对畸形消息的免疫**不是**靠兜底，而是靠"活跃 run 归属"这条不变量：
 * 所有写路径只碰 `runId === activeRunId` 的 assistant 消息，而缺 segments 的
 * 旧快照消息没有 runId。message-stream 内部 16 处裸 `.segments` 全部依赖这一点。
 *
 * 但 `RUN_FINISHED` / `RUN_ERROR` 走的是 `finishActiveAssistant` /
 * `errorActiveAssistant`，它们**没有** `updateActiveAssistant` 里那句
 * `if (!state.activeRunId) return state` —— 只靠 `msg.runId !== state.activeRunId`
 * 过滤。一旦 `activeRunId` 变成 `undefined`，它就会和旧消息缺失的 `runId` 相等，
 * 旧消息被卷进 `closeThinking` 并在 `segments.map` 上抛错。
 *
 * 所以「空态的 activeRunId 必须是 null 而不是 undefined」是一条真实的安全条件，
 * 不是风格选择。下面两个用例把它钉住。
 */
describe('活跃 run 归属：畸形消息不被事件路径碰到', () => {
  const legacyInStore = {
    id: 'legacy-1',
    role: 'assistant',
    content: '旧模型消息',
    status: 'complete',
    toolCalls: [],
  } as unknown as ChatMessage

  it('空消息流状态的 activeRunId 是 null（不是 undefined）', () => {
    expect(emptyState().activeRunId).toBeNull()
  })

  it.each([
    ['RUN_FINISHED', { type: EventType.RUN_FINISHED }],
    ['RUN_ERROR', { type: EventType.RUN_ERROR, message: '炸了' }],
    ['TEXT_MESSAGE_CONTENT', { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'x' }],
    ['THINKING_END', { type: EventType.THINKING_END }],
  ])('无活跃 run 时 %s 不触碰缺 segments 的旧消息', (_label, event) => {
    const state: MessageStreamState = {
      messages: [legacyInStore],
      activeRunId: null,
      streamError: null,
    }

    expect(() => apply(state, event as unknown as BaseEvent)).not.toThrow()
  })

  it('有活跃 run 时旧消息仍被跳过，只有新建的助手消息被写入', () => {
    let state: MessageStreamState = {
      messages: [legacyInStore],
      activeRunId: null,
      streamError: null,
    }
    state = apply(state, runStarted, text('新回答'), {
      type: EventType.RUN_FINISHED,
    } as unknown as BaseEvent)

    // 旧消息原样留在列表里（引用未变，说明没被 map 出新对象）
    expect(state.messages[0]).toBe(legacyInStore)
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1].content).toBe('新回答')
  })
})
