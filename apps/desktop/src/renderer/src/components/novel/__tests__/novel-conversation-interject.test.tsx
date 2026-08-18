import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ChapterChatMessage, NovelUserMessageEvent } from '@repo/shared/novel'
import { NovelConversationPanel } from '../novel-conversation-panel'
import { applyUserMessageEvent, type InterjectMessage } from '@/hooks/use-novel-creation-flow'

// 隔离 api client：检查点决策/插话端点均 mock，不发真实网络请求
const api = vi.hoisted(() => ({
  submitCheckpointDecision: vi.fn(),
  persistChapterChat: vi.fn(),
  sendFlowMessage: vi.fn(),
}))

vi.mock('@/api/novel-client', () => api)

// 隔离 toast store：命令拦截/未知命令提示走 toast，这里只断言调用
const toasts = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('@/hooks/use-toast', () => toasts)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// 注意：与 novel-conversation-panel.test.tsx 不同，这里渲染**真实的**
// shared/conversation 组件（CheckpointMessage / MessageBubble / ConversationInput），
// 验证检查点卡片、插话徽标与输入框的真实 DOM 行为。

function makePanelProps(
  overrides?: Partial<ComponentProps<typeof NovelConversationPanel>>,
): ComponentProps<typeof NovelConversationPanel> {
  return {
    phase: 'checkpoint_review',
    isRunning: true,
    chapterContent: '当前正文',
    agentOutputs: [],
    currentCheckpoint: null,
    checkpointHistory: [],
    result: null,
    error: null,
    onSubmitCheckpoint: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onDiscard: vi.fn(),
    flowType: 'workflow',
    onFlowTypeChange: vi.fn(),
    onStartFlow: vi.fn(),
    onCancelFlow: vi.fn(),
    ...overrides,
  }
}

describe('NovelConversationPanel 检查点对话化卡片', () => {
  it('检查点卡片渲染正文与修改意见输入，确认按钮触发既有 decision 端点调用', () => {
    api.submitCheckpointDecision.mockResolvedValue({ ok: true })
    // 模拟 workspace → hook 链路：panel 回调把（含修改意见的）决策转交既有 decision API
    const onSubmitCheckpoint = vi.fn((decision: string, comment?: string) => {
      void api.submitCheckpointDecision('project-1', 'ck-review-1', decision, comment ? [comment] : [])
    })
    const props = makePanelProps({
      onSubmitCheckpoint,
      currentCheckpoint: {
        type: 'review',
        phase: 'checkpoint_review',
        data: { review: '整体节奏偏平，建议强化高潮段落' },
        options: ['approve', 'revise'],
        checkpointId: 'ck-review-1',
      },
    })

    render(<NovelConversationPanel {...props} />)

    // 卡片正文与选项可见
    expect(screen.getByText('验收确认')).toBeTruthy()
    expect(screen.getByText(/整体节奏偏平/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /接受这一版/ })).toBeTruthy()

    // 填写修改意见后确认：comment 随决策一并提交既有 decision 端点
    fireEvent.change(screen.getByLabelText('检查点修改意见'), {
      target: { value: '高潮段落请加长打斗描写' },
    })
    fireEvent.click(screen.getByRole('button', { name: /接受这一版/ }))

    expect(onSubmitCheckpoint).toHaveBeenCalledWith('approve', '高潮段落请加长打斗描写')
    expect(api.submitCheckpointDecision).toHaveBeenCalledWith(
      'project-1',
      'ck-review-1',
      'approve',
      ['高潮段落请加长打斗描写'],
    )
  })

  it('无修改意见时决策调用不带 comment', () => {
    const onSubmitCheckpoint = vi.fn()
    const props = makePanelProps({
      onSubmitCheckpoint,
      currentCheckpoint: {
        type: 'review',
        phase: 'checkpoint_review',
        data: { review: '审稿通过' },
        options: ['approve'],
        checkpointId: 'ck-review-2',
      },
    })

    render(<NovelConversationPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /接受这一版/ }))

    expect(onSubmitCheckpoint).toHaveBeenCalledWith('approve', undefined)
  })

  it('已决策的检查点卡片显示决策结果且不可再操作', () => {
    const props = makePanelProps({
      phase: 'writing',
      currentCheckpoint: null,
      checkpointHistory: [
        {
          type: 'review',
          phase: 'checkpoint_review',
          data: { review: '历史检查点' },
          options: ['approve'],
          checkpointId: 'ck-done-1',
          decision: 'approve',
          createdAt: 1,
          resolvedAt: 2,
        },
      ],
    })

    render(<NovelConversationPanel {...props} />)

    expect(screen.getByText('已决策')).toBeTruthy()
    expect(screen.queryByLabelText('检查点修改意见')).toBeNull()
    const button = screen.getByRole('button', { name: /接受这一版/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('等待检查点时输入框保持可用且发送分流到插话通道', () => {
    const onSendInterject = vi.fn()
    const onSendMessage = vi.fn()
    const props = makePanelProps({
      onSendInterject,
      onSendMessage,
      currentCheckpoint: {
        type: 'review',
        phase: 'checkpoint_review',
        data: { review: '等待确认' },
        options: ['approve'],
        checkpointId: 'ck-wait-1',
      },
    })

    render(<NovelConversationPanel {...props} />)

    const input = screen.getByLabelText('消息输入') as HTMLTextAreaElement
    expect(input.disabled).toBe(false)
    expect(input.placeholder).toBe('可先反馈再确认检查点')

    // 运行中发送 → 插话端点（onSendInterject），不走旧的本地暂存 onSendMessage
    fireEvent.change(input, { target: { value: '打斗戏改用棍' } })
    fireEvent.click(screen.getByLabelText('发送'))

    expect(onSendInterject).toHaveBeenCalledWith('打斗戏改用棍')
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('工作流运行中可选择 Memory，并把定向 Agent 随插话发送', async () => {
    const onSendInterject = vi.fn()
    render(<NovelConversationPanel {...makePanelProps({ onSendInterject })} />)

    const targetSelect = screen.getByRole('combobox', { name: '插话目标 Agent' })
    fireEvent.keyDown(targetSelect, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: '记忆' }))

    const input = screen.getByLabelText('消息输入')
    fireEvent.change(input, { target: { value: '核对旧案伏笔' } })
    fireEvent.click(screen.getByLabelText('发送'))

    expect(onSendInterject).toHaveBeenCalledWith('核对旧案伏笔', 'memory')
  })

  it('群聊运行中不显示定向 Agent 选择器', () => {
    render(<NovelConversationPanel {...makePanelProps({ flowType: 'discussion' })} />)
    expect(screen.queryByRole('combobox', { name: '插话目标 Agent' })).toBeNull()
  })
})

describe('NovelConversationPanel 插话消息徽标', () => {
  it('渲染 queued / injected / dropped 三种状态徽标', () => {
    const interjectMessages: InterjectMessage[] = [
      { messageId: 'm-queued', content: '打斗戏改用棍', status: 'queued', timestamp: 1 },
      { messageId: 'm-injected', content: '注意角色口癖', status: 'injected', agentType: 'director', timestamp: 2 },
      { messageId: 'm-dropped', content: '过时的意见', status: 'dropped', timestamp: 3 },
    ]
    const props = makePanelProps({ interjectMessages })

    render(<NovelConversationPanel {...props} />)

    expect(screen.getByText('打斗戏改用棍')).toBeTruthy()
    expect(screen.getByText('已排队')).toBeTruthy()
    expect(screen.getByText('已注入·导演')).toBeTruthy()
    expect(screen.getByText('已丢弃')).toBeTruthy()
  })

  it('SSE novel:user-message 事件驱动状态从 queued 更新为 injected', () => {
    // 与 use-novel-creation-flow 的 novel:user-message case 使用同一归并函数，
    // 这里模拟事件序列驱动插话消息状态流转，再验证徽标随 props 更新
    const queuedEvent: NovelUserMessageEvent = {
      flowId: '11',
      messageId: 'm-sse-1',
      content: '打斗戏改用棍',
      status: 'queued',
      timestamp: 1,
    }
    const afterQueued = applyUserMessageEvent([], queuedEvent)
    expect(afterQueued).toHaveLength(1)
    expect(afterQueued[0].status).toBe('queued')

    const props = makePanelProps({ interjectMessages: afterQueued })
    const { rerender } = render(<NovelConversationPanel {...props} />)
    expect(screen.getByText('已排队')).toBeTruthy()

    // injected 事件（被 Writer 消费）→ 同一 messageId 原位更新，不新增气泡
    const injectedEvent: NovelUserMessageEvent = {
      ...queuedEvent,
      status: 'injected',
      agentType: 'writer',
      timestamp: 2,
    }
    const afterInjected = applyUserMessageEvent(afterQueued, injectedEvent)
    expect(afterInjected).toHaveLength(1)

    rerender(<NovelConversationPanel {...makePanelProps({ interjectMessages: afterInjected })} />)
    expect(screen.getByText('已注入·写作')).toBeTruthy()
    expect(screen.queryByText('已排队')).toBeNull()
  })

  it('迟到的 queued 回显不得把 injected/dropped 回退成 queued', () => {
    const base: NovelUserMessageEvent = {
      flowId: '11',
      messageId: 'm-late-1',
      content: '打斗戏改用棍',
      status: 'queued',
      timestamp: 1,
    }
    // queued → injected 正常前进
    const afterInjected = applyUserMessageEvent(
      applyUserMessageEvent([], base),
      { ...base, status: 'injected', agentType: 'writer', timestamp: 2 },
    )
    expect(afterInjected[0].status).toBe('injected')

    // 迟到的 queued 回显：状态不回退、原记录保持 injected
    const stillInjected = applyUserMessageEvent(afterInjected, { ...base, timestamp: 3 })
    expect(stillInjected).toBe(afterInjected)
    expect(stillInjected[0].status).toBe('injected')

    // dropped 同理不被 queued 回退
    const afterDropped = applyUserMessageEvent(
      applyUserMessageEvent([], base),
      { ...base, status: 'dropped', timestamp: 2 },
    )
    const stillDropped = applyUserMessageEvent(afterDropped, { ...base, timestamp: 3 })
    expect(stillDropped).toBe(afterDropped)
    expect(stillDropped[0].status).toBe('dropped')
  })
})

describe('NovelConversationPanel 群聊（discussion）行为修复', () => {
  function makeDiscussionHistoryMessage(overrides?: Partial<ChapterChatMessage>): ChapterChatMessage {
    return {
      id: 'hist-1',
      projectId: 'project-1',
      chapterNumber: 11,
      role: 'user',
      fromId: 'user',
      fromName: '用户',
      content: '打斗戏改用棍',
      phase: 'discussion',
      metadata: { flowMode: 'discussion', interject: true },
      createdAt: 1,
      ...overrides,
    }
  }

  it('discussion 检查点卡片不渲染修改意见输入（decision 端点群聊分支会丢弃意见）', () => {
    const props = makePanelProps({
      flowType: 'discussion',
      currentCheckpoint: {
        type: 'review',
        phase: 'checkpoint_review',
        data: { review: '群聊验收意见' },
        options: ['approve'],
        checkpointId: 'ck-disc-1',
      },
    })

    render(<NovelConversationPanel {...props} />)

    // 卡片本身正常渲染（正文 + 可操作选项），仅隐藏修改意见输入
    expect(screen.getByText('验收确认')).toBeTruthy()
    expect(screen.getByRole('button', { name: /接受这一版/ })).toBeTruthy()
    expect(screen.queryByLabelText('检查点修改意见')).toBeNull()
  })

  it('有本地实时插话状态时跳过 discussion 历史插话条目（防同一条渲染两条）', () => {
    const props = makePanelProps({
      flowType: 'discussion',
      chapterChatMessages: [makeDiscussionHistoryMessage()],
      // 本地实时态：同一条插话已被 Writer 消费
      interjectMessages: [
        { messageId: 'live-1', content: '打斗戏改用棍', status: 'injected', agentType: 'writer', timestamp: 2 },
      ],
    })

    render(<NovelConversationPanel {...props} />)

    // 历史插话被守卫跳过：内容只渲染一次（实时气泡），徽标为实时态而非历史 queued
    expect(screen.getAllByText('打斗戏改用棍')).toHaveLength(1)
    expect(screen.getByText('已注入·写作')).toBeTruthy()
    expect(screen.queryByText('已排队')).toBeNull()
  })

  it('无本地实时插话状态时 discussion 历史插话仍渲染（切回复盘场景）', () => {
    const props = makePanelProps({
      flowType: 'discussion',
      chapterChatMessages: [makeDiscussionHistoryMessage()],
    })

    render(<NovelConversationPanel {...props} />)

    // 无实时态时历史插话按设计渲染，维持受理时的 queued
    expect(screen.getByText('打斗戏改用棍')).toBeTruthy()
    expect(screen.getByText('已排队')).toBeTruthy()
  })
})

describe('NovelConversationPanel 检查点提交 in-flight 防抖', () => {
  it('提交进行中禁用全部选项与修改意见输入，promise 完成后恢复且不重复提交', async () => {
    let resolveSubmit!: () => void
    const onSubmitCheckpoint = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveSubmit = resolve
      }),
    )
    const props = makePanelProps({
      onSubmitCheckpoint,
      currentCheckpoint: {
        type: 'review',
        phase: 'checkpoint_review',
        data: { review: '等待确认' },
        options: ['approve', 'revise'],
        checkpointId: 'ck-inflight-1',
      },
    })

    render(<NovelConversationPanel {...props} />)

    const approveBtn = screen.getByRole('button', { name: /接受这一版/ }) as HTMLButtonElement
    const reviseBtn = screen.getByRole('button', { name: /交给 Reviser 修订/ }) as HTMLButtonElement
    const commentInput = screen.getByLabelText('检查点修改意见') as HTMLInputElement

    fireEvent.click(approveBtn)

    // in-flight：全部选项按钮 + 修改意见输入禁用
    expect(approveBtn.disabled).toBe(true)
    expect(reviseBtn.disabled).toBe(true)
    expect(commentInput.disabled).toBe(true)

    // in-flight 期间重复点击不再触发提交
    fireEvent.click(reviseBtn)
    expect(onSubmitCheckpoint).toHaveBeenCalledTimes(1)
    expect(onSubmitCheckpoint).toHaveBeenCalledWith('approve', undefined)

    // 提交完成后解锁（决策未被确认前可重新操作，失败可重试）
    resolveSubmit()
    await waitFor(() => expect(approveBtn.disabled).toBe(false))
    expect(reviseBtn.disabled).toBe(false)
    expect(commentInput.disabled).toBe(false)
  })
})

describe('NovelConversationPanel 输入框命令解析与分流', () => {
  function makeIdleProps(
    overrides?: Partial<ComponentProps<typeof NovelConversationPanel>>,
  ): ComponentProps<typeof NovelConversationPanel> {
    return makePanelProps({
      phase: 'idle',
      isRunning: false,
      ...overrides,
    })
  }

  /** 在真实 ConversationInput 中输入命令并按 Enter（走 handleSend 分流） */
  function submitCommand(command: string) {
    const input = screen.getByLabelText('消息输入') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: command } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    return input
  }

  it('空闲态 /写 N 解析命中：启动函数收到正确章节号，命令文本不进消息流', () => {
    const onStartFlowCommand = vi.fn()
    const onStartFlow = vi.fn()
    render(<NovelConversationPanel {...makeIdleProps({ onStartFlowCommand, onStartFlow })} />)

    submitCommand('/写 12')

    expect(onStartFlowCommand).toHaveBeenCalledWith('write', 12, null)
    // 不走通用「开始」（那是 playhead 章节路径，章节号会错）
    expect(onStartFlow).not.toHaveBeenCalled()
    // 命令本身不写入消息流
    expect(screen.queryByText('/写 12')).toBeNull()
    // 发送后输入框清空
    expect((screen.getByLabelText('消息输入') as HTMLTextAreaElement).value).toBe('')
  })

  it('空闲态 /重写 N、/群聊 N 分别路由到 rewrite / discuss', () => {
    const onStartFlowCommand = vi.fn()
    const { unmount } = render(
      <NovelConversationPanel {...makeIdleProps({ onStartFlowCommand })} />,
    )
    submitCommand('/重写 3')
    expect(onStartFlowCommand).toHaveBeenCalledWith('rewrite', 3, null)
    unmount()

    render(<NovelConversationPanel {...makeIdleProps({ onStartFlowCommand })} />)
    submitCommand('/群聊 5')
    expect(onStartFlowCommand).toHaveBeenCalledWith('discuss', 5, null)
  })

  it('空闲态 /继续：可恢复的群聊走既有 onResumeDiscussion 入口', () => {
    const onResumeDiscussion = vi.fn()
    const props = makeIdleProps({
      phase: 'error',
      error: '群聊中断',
      result: { status: 'error', canResume: true, discussionRunId: 'run-1' },
      onResumeDiscussion,
    })
    render(<NovelConversationPanel {...props} />)

    submitCommand('/继续')

    expect(onResumeDiscussion).toHaveBeenCalledWith('run-1')
  })

  it('空闲态 /继续 无可恢复流程：不触发任何启动回调，toast 提示', () => {
    const onResumeDiscussion = vi.fn()
    const onRetry = vi.fn()
    const onStartFlowCommand = vi.fn()
    const props = makeIdleProps({ onResumeDiscussion, onRetry, onStartFlowCommand })
    render(<NovelConversationPanel {...props} />)

    submitCommand('/继续')

    expect(onResumeDiscussion).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
    expect(onStartFlowCommand).not.toHaveBeenCalled()
    expect(toasts.toastInfo).toHaveBeenCalledWith('暂无可恢复的流程', expect.any(String))
  })

  it('空闲态未知命令：toast 提示支持列表，不触发启动', () => {
    const onStartFlowCommand = vi.fn()
    render(<NovelConversationPanel {...makeIdleProps({ onStartFlowCommand })} />)

    submitCommand('/foo')

    expect(onStartFlowCommand).not.toHaveBeenCalled()
    expect(toasts.toastError).toHaveBeenCalledWith(
      '未知命令：/foo',
      '支持 /写 N、/继续、/重写 N、/群聊 N',
    )
  })

  it('运行中 /写 1 被拦截：不作为插话注入（避免误导 Agent）', () => {
    const onSendInterject = vi.fn()
    const onSendMessage = vi.fn()
    // 运行中默认 props（makePanelProps：isRunning=true）
    render(<NovelConversationPanel {...makePanelProps({ onSendInterject, onSendMessage })} />)

    submitCommand('/写 1')

    expect(onSendInterject).not.toHaveBeenCalled()
    expect(onSendMessage).not.toHaveBeenCalled()
    expect(toasts.toastWarning).toHaveBeenCalledWith(
      '流程运行中命令不可用',
      expect.any(String),
    )
  })

  it('运行中普通文本仍走插话（现状回归）', () => {
    const onSendInterject = vi.fn()
    render(<NovelConversationPanel {...makePanelProps({ onSendInterject })} />)

    submitCommand('打斗戏改用棍')

    expect(onSendInterject).toHaveBeenCalledWith('打斗戏改用棍')
  })

  it('空闲态普通文本：进入统一章节聊天通道', () => {
    const onStartFlowCommand = vi.fn()
    const onSendInterject = vi.fn()
    const onSendMessage = vi.fn()
    const onStartFlow = vi.fn()
    const onSendChapterChat = vi.fn()
    render(
      <NovelConversationPanel
        {...makeIdleProps({ onStartFlowCommand, onSendInterject, onSendMessage, onStartFlow, onSendChapterChat })}
      />,
    )

    submitCommand('随便聊聊')

    expect(onStartFlowCommand).not.toHaveBeenCalled()
    expect(onSendInterject).not.toHaveBeenCalled()
    expect(onSendMessage).not.toHaveBeenCalled()
    expect(onStartFlow).not.toHaveBeenCalled()
    expect(onSendChapterChat).toHaveBeenCalledWith(
      '随便聊聊',
      [],
      null,
      ['style-sample-01', 'style-sample-02', 'style-sample-03', 'style-sample-04'],
    )
  })

  it('空闲态越界命令（/写 0、/写 10000）：toast 提示章节号范围，不启动', () => {
    const onStartFlowCommand = vi.fn()
    render(<NovelConversationPanel {...makeIdleProps({ onStartFlowCommand })} />)

    submitCommand('/写 0')
    submitCommand('/写 10000')

    expect(onStartFlowCommand).not.toHaveBeenCalled()
    expect(toasts.toastWarning).toHaveBeenCalledWith('章节号需在 1-9999 之间', '/写 0')
    expect(toasts.toastWarning).toHaveBeenCalledWith('章节号需在 1-9999 之间', '/写 10000')
  })

  it('空闲态输入为空按 Enter 仍直接开始（旧快捷路径不回归）', () => {
    const onStartFlow = vi.fn()
    render(<NovelConversationPanel {...makeIdleProps({ onStartFlow })} />)

    const input = screen.getByLabelText('消息输入')
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    expect(onStartFlow).toHaveBeenCalledOnce()
  })
})
