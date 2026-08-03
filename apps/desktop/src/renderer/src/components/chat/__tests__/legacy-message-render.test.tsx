import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../message-bubble'
import { StreamingIndicator } from '../streaming-indicator'
import type { ChatMessage } from '../types'

/**
 * 畸形消息（缺 / 脏 `segments`）在**渲染层**不能白屏。
 *
 * 真实故障：旧版本把 `sessionMessages` 持久化进 localStorage，当时的 ChatMessage
 * 是旧模型（旁挂 toolCalls，没有 segments）。这类快照 rehydrate 回来后
 * `collectToolCalls` 抛 `message.segments is not iterable`，整页白屏。
 *
 * session-store 的 v1 migrate 是第一道防线、`readSegments` 是第二道，
 * 这里钉住第三个事实：**即使两道防线都被绕过**（比如手工塞进 store 的脏数据、
 * 未来又有人加了新的持久化路径），组件自身也只是少渲染内容而不是抛异常。
 * 纯函数测试测不出这一层 —— buildRenderGroups / derivePhase 各自还要访问
 * 分段内部字段，任何一处漏了兜底都在组件挂载时才暴露。
 */

afterEach(cleanup)

/** v0 旧模型消息：没有 segments，旁挂 toolCalls */
function legacyAssistant(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'legacy-1',
    role: 'assistant',
    content: '旧模型的正文',
    createdAt: 1_700_000_000_000,
    status: 'complete',
    toolCalls: [{ toolCallId: 'c1', toolName: 'read', status: 'success' }],
    thinking: { content: '旧思考', isStreaming: false },
    ...patch,
  } as unknown as ChatMessage
}

/** 各种非数组脏值 —— JSON 反序列化后什么都可能出现 */
const DIRTY_SEGMENTS: ReadonlyArray<[label: string, value: unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['字符串', 'not-an-array'],
  ['数字', 42],
  ['布尔', true],
  ['普通对象', { 0: { kind: 'text', id: 't', text: 'x' }, length: 1 }],
]

describe('MessageBubble · 畸形 segments', () => {
  it.each(DIRTY_SEGMENTS)('segments 为 %s 的助手消息可渲染且不抛错', (_label, value) => {
    const message = legacyAssistant({ segments: value as never })

    expect(() => render(<MessageBubble message={message} />)).not.toThrow()
    // 分段渲染不出内容，但 content 仍能撑起 hover 行 —— 消息没有凭空消失
    expect(screen.getByRole('article')).not.toBeNull()
  })

  it('缺 segments 的用户消息仍显示正文（用户气泡走 content 而非分段）', () => {
    const message = legacyAssistant({ role: 'user', content: '我发的话' })

    render(<MessageBubble message={message} />)
    expect(screen.getByText('我发的话')).not.toBeNull()
  })

  it('缺 segments 时不渲染任何工具卡 —— 旁挂 toolCalls 不再是事实来源', () => {
    render(<MessageBubble message={legacyAssistant()} />)

    // 工具卡的展开按钮以工具名作为无障碍名，旧模型的 read 不该出现
    expect(screen.queryByText('read')).toBeNull()
  })

  it('缺 segments 的错误消息仍显示错误文案', () => {
    const message = legacyAssistant({ status: 'error', error: '模型调用失败' })

    render(<MessageBubble message={message} />)
    expect(screen.getByText('模型调用失败')).not.toBeNull()
  })

  it('分段正常时按顺序渲染 —— 兜底没有顺带压掉正常路径', () => {
    const message = legacyAssistant({
      segments: [
        { kind: 'text', id: 't1', text: '先看一下文件' },
        {
          kind: 'tool',
          id: 'g1',
          call: { toolCallId: 'c1', toolName: 'read', status: 'success' },
        },
        { kind: 'text', id: 't2', text: '确实有问题' },
      ] as never,
    })

    render(<MessageBubble message={message} />)
    expect(screen.getByText('先看一下文件')).not.toBeNull()
    expect(screen.getByText('确实有问题')).not.toBeNull()
  })
})

describe('StreamingIndicator · 畸形 segments', () => {
  it.each(DIRTY_SEGMENTS)('activeMessage 的 segments 为 %s 时退回等待态', (_label, value) => {
    const message = legacyAssistant({ status: 'streaming', segments: value as never })

    expect(() => render(<StreamingIndicator activeMessage={message} />)).not.toThrow()
    // derivePhase 读不到分段 → idle → 「等待响应」
    expect(screen.getByText('等待响应')).not.toBeNull()
  })

  it('没有 activeMessage 时同样是等待态', () => {
    render(<StreamingIndicator />)
    expect(screen.getByText('等待响应')).not.toBeNull()
  })

  it('正常流式消息仍能推断出阶段（兜底没有把正常路径也压成 idle）', () => {
    const message = legacyAssistant({
      status: 'streaming',
      segments: [{ kind: 'thinking', id: 'th1', content: '想', isStreaming: true }] as never,
    })

    render(<StreamingIndicator activeMessage={message} onCancel={vi.fn()} />)
    expect(screen.getByText('思考中')).not.toBeNull()
  })
})
