import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import { NovelConversationPanel } from '../novel-conversation-panel'

vi.mock('@/components/shared/conversation', () => ({
  ConversationStream: ({
    messages
  }: {
    messages: Array<{ agentType?: string; content: string; status: string; checkpointOptions?: Array<{ label: string; action: string }> }>
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
})
