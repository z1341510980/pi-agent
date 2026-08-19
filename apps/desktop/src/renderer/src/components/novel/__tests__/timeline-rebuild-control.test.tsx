import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TimelineRebuildControl } from '../timeline-rebuild-control'
import * as novelClient from '@/api/novel-client'

// 按钮渲染回归：顶栏入口不依赖 preview 请求结果，挂载即显示。
vi.mock('@/api/novel-client', async (importOriginal) => {
  const actual = await importOriginal<typeof novelClient>()
  return {
    ...actual,
    getTimelineRebuildPreview: vi.fn().mockRejectedValue(
      Object.assign(new Error('Not Found'), { code: 'NOT_FOUND' }),
    ),
    getTimelineRebuildJob: vi.fn(),
    resumeTimelineRebuildJob: vi.fn(),
    startTimelineRebuild: vi.fn(),
    applyTimelineRebuildStep: vi.fn(),
    completeTimelineRebuildJob: vi.fn(),
  }
})

describe('TimelineRebuildControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('projectId 存在时始终渲染入口按钮，即使 preview 返回 404', () => {
    render(<TimelineRebuildControl projectId="proj-1" selectedModel={null} />)
    expect(screen.getByRole('button', { name: /检查时间线/ })).toBeTruthy()
  })

  it('projectId 为空时不渲染', () => {
    const { container } = render(<TimelineRebuildControl projectId={null} selectedModel={null} />)
    expect(container.innerHTML).toBe('')
  })
})
