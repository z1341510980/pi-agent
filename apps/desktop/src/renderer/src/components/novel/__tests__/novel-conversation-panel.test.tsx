import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import { NovelConversationPanel } from '../novel-conversation-panel'

vi.mock('@/components/shared/conversation', () => ({
  ConversationStream: ({
    messages,
    stickyFooter
  }: {
    messages: Array<{ agentType?: string; content: string; status: string; checkpointOptions?: Array<{ label: string; action: string }> }>
    stickyFooter?: ReactNode
  }) => (
    <div data-testid="conversation-stream">
      {messages.map((message, index) => (
        <article key={index} data-agent-type={message.agentType} data-status={message.status}>
          {message.content}
          {message.checkpointOptions?.map(option => (
            <button key={option.action}>{option.label}</button>
          ))}
        </article>
      ))}
      {/* 错误卡经 stickyFooter 吸底渲染（P0-5），mock 需透出以供断言 */}
      {stickyFooter}
    </div>
  ),
  ConversationInput: () => null,
  ConversationEmptyState: () => null
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children
}))

afterEach(cleanup)

describe('NovelConversationPanel Reviser output', () => {
  it('defaults the style expert selection to empty instead of enabling every expert', () => {
    const props: ComponentProps<typeof NovelConversationPanel> = {
      phase: 'idle',
      isRunning: false,
      chapterContent: '',
      agentOutputs: [],
      currentCheckpoint: null,
      checkpointHistory: [],
      result: null,
      error: null,
      styleExperts: [
        { id: 'expert-1', projectId: 'project-1', name: '克制留白', sourceTitle: '样本', description: 'desc', distilledPrompt: 'prompt', enabled: true, sortOrder: 0, version: 1, createdAt: 0, updatedAt: 0 }
      ],
      onSubmitCheckpoint: vi.fn(),
      onSave: vi.fn().mockResolvedValue(undefined),
      onDiscard: vi.fn(),
      flowType: 'workflow',
      onFlowTypeChange: vi.fn(),
      onStartFlow: vi.fn(),
      onCancelFlow: vi.fn()
    }

    render(<NovelConversationPanel {...props} />)
    expect(screen.queryByText('0/1')).toBeNull()
  })

  it('maps completed Reviser text into a visible conversation message', () => {
    const props: ComponentProps<typeof NovelConversationPanel> = {
      phase: 'revising',
      isRunning: true,
      chapterContent: '原正文',
      agentOutputs: [
        {
          agentType: 'reviser',
          agentName: '修订',
          content: '已应用 2 处修订。',
          preview: '已应用 2 处修订。',
          timestamp: 1,
          streaming: false,
          messageId: 'reviser-1'
        }
      ],
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
      onCancelFlow: vi.fn()
    }

    render(<NovelConversationPanel {...props} />)

    const bubble = screen.getByText('已应用 2 处修订。')
    expect(bubble.closest('article')?.dataset.agentType).toBe('reviser')
    expect(bubble.closest('article')?.dataset.status).toBe('complete')
  })

  it('omits full rewrite when the server checkpoint says the category is exhausted', () => {
    const props: ComponentProps<typeof NovelConversationPanel> = {
      phase: 'checkpoint_review',
      isRunning: true,
      chapterContent: '当前正文',
      agentOutputs: [],
      currentCheckpoint: {
        type: 'review',
        phase: 'checkpoint_review',
        data: { review: '审稿结果' },
        options: ['approve', 'revise', 'reject'],
        checkpointId: 'review-2',
      },
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
    }

    render(<NovelConversationPanel {...props} />)

    expect(screen.getByRole('button', { name: '接受这一版' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '交给 Reviser 修订' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '退回重写' })).toBeNull()
  })

  it('chapter budget no longer presents the unimplemented finish-soon action', () => {
    const props: ComponentProps<typeof NovelConversationPanel> = {
      phase: 'directing',
      isRunning: true,
      chapterContent: '',
      agentOutputs: [],
      currentCheckpoint: {
        type: 'chapter_budget',
        phase: 'directing',
        data: {},
        options: ['approve', 'reject'],
        checkpointId: 'budget-1',
      },
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
    }

    render(<NovelConversationPanel {...props} />)

    expect(screen.getByRole('button', { name: '继续创作' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '尽快收尾' })).toBeNull()
  })

  // ── 修订前告知：预计操作与消耗 ──
  it('审稿检查点携带 revisionEstimate 时，展示修订轮次上限、调用次数与预计消耗', () => {
    const props: ComponentProps<typeof NovelConversationPanel> = {
      phase: 'checkpoint_review',
      isRunning: true,
      chapterContent: '当前正文',
      agentOutputs: [],
      currentCheckpoint: {
        type: 'review',
        phase: 'checkpoint_review',
        data: {
          review: '审稿结果',
          revisionEstimate: {
            maxRounds: 2,
            callsPerRound: 1,
            estimatedTokens: 36000,
            failedItems: [
              { gateId: 'cliche-patterns', reason: 'AI 腔句式命中', details: '解释腔(3)' },
            ],
          },
        },
        options: ['revise', 'reject'],
        checkpointId: 'review-3',
      },
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
    }

    render(<NovelConversationPanel {...props} />)

    const stream = screen.getByTestId('conversation-stream')
    // 修订前必须让用户看到「要跑几轮 / 几次调用 / 大概多少 token / 处理什么」
    expect(stream.textContent).toContain('最多 2 轮')
    expect(stream.textContent).toContain('1 次')
    expect(stream.textContent).toContain('4 万 token')
    expect(stream.textContent).toContain('AI 腔句式命中')
    // 质量门强制修订时不给「接受这一版」
    expect(screen.queryByRole('button', { name: '接受这一版' })).toBeNull()
    expect(screen.getByRole('button', { name: '交给 Reviser 修订' })).toBeTruthy()
  })

  // ── 质量门修订失败：结构化失败卡（而非笼统「生成失败 / 未知来源」）──
  it('质量门修订失败时展示未通过项、修订记录与四个出口，不显示误导性重试', () => {
    const onReRevise = vi.fn()
    const onKeepDraft = vi.fn()
    const onRetry = vi.fn()
    const props: ComponentProps<typeof NovelConversationPanel> = {
      phase: 'error',
      isRunning: false,
      chapterContent: '保留下来的修订稿',
      agentOutputs: [],
      currentCheckpoint: null,
      checkpointHistory: [],
      result: {
        status: 'error',
        errorCode: 'quality_gate_revision_incomplete',
        error: '自动修订 2 轮后仍有 1 项表达问题未通过，已阻止落库',
        content: '保留下来的修订稿',
        failedItems: [
          {
            gateId: 'cliche-patterns',
            reason: 'AI 腔句式未清除',
            details: '解释腔(2)',
            patterns: ['explanation_tone'],
            excerpts: ['这意味着他别无选择'],
          },
        ],
        revisionRounds: [
          { round: 1, appliedPatches: 3, failedPatches: 1, remainingFailures: [{ gateId: 'cliche-patterns', reason: 'AI 腔句式未清除' }], contentLength: 3200 },
          { round: 2, appliedPatches: 1, failedPatches: 0, remainingFailures: [{ gateId: 'cliche-patterns', reason: 'AI 腔句式未清除' }], contentLength: 3180 },
        ],
        canReviseAgain: true,
        failedPhase: 'revising',
      },
      error: '自动修订 2 轮后仍有 1 项表达问题未通过，已阻止落库',
      onRetry,
      onReRevise,
      onKeepDraft,
      onSubmitCheckpoint: vi.fn(),
      onSave: vi.fn().mockResolvedValue(undefined),
      onDiscard: vi.fn(),
      onDismissError: vi.fn(),
      flowType: 'workflow',
      onFlowTypeChange: vi.fn(),
      onStartFlow: vi.fn(),
      onCancelFlow: vi.fn(),
    }

    render(<NovelConversationPanel {...props} />)

    // 标题说清是质量门问题，且明确内容未落库但已保留
    expect(screen.getByText('正文质量门未通过')).toBeTruthy()
    expect(screen.getByText('内容未落库')).toBeTruthy()
    // 具体未通过项 + 原文摘录
    expect(screen.getByText(/未通过项（1）/)).toBeTruthy()
    expect(screen.getByText(/AI 腔句式未清除/)).toBeTruthy()
    expect(screen.getByText(/这意味着他别无选择/)).toBeTruthy()
    // 修订记录（改了几轮、应用/失败几处）
    expect(screen.getByText(/修订记录（2 轮）/)).toBeTruthy()
    expect(screen.getByText(/第 1 轮：应用 3 处、定位失败 1 处/)).toBeTruthy()
    // 四个出口：再次修订 / 手动编辑 / 保留草稿 / 取消
    expect(screen.getByRole('button', { name: /再次修订/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /手动编辑/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /保留草稿/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /取消/ })).toBeTruthy()
    // 不显示通用「重试」：重新生成不会让确定性质量门消失，只会白烧 token
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('非质量门错误仍走通用错误卡（保留重试入口）', () => {
    const onRetry = vi.fn()
    const props: ComponentProps<typeof NovelConversationPanel> = {
      phase: 'error',
      isRunning: false,
      chapterContent: '',
      agentOutputs: [],
      currentCheckpoint: null,
      checkpointHistory: [],
      result: { status: 'error', error: 'fetch failed' },
      error: 'fetch failed',
      onRetry,
      onSubmitCheckpoint: vi.fn(),
      onSave: vi.fn().mockResolvedValue(undefined),
      onDiscard: vi.fn(),
      onDismissError: vi.fn(),
      flowType: 'workflow',
      onFlowTypeChange: vi.fn(),
      onStartFlow: vi.fn(),
      onCancelFlow: vi.fn(),
    }

    render(<NovelConversationPanel {...props} />)

    expect(screen.getByText('连不上模型服务')).toBeTruthy()
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy()
    expect(screen.queryByText('正文质量门未通过')).toBeNull()
  })
})
