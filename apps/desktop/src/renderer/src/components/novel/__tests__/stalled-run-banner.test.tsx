/**
 * StalledRunBanner：章节视图"未完成创作"提示条测试。
 *
 * 守护行为：
 * 1. 空闲且当前章节有可续跑快照 → 展示阶段描述 + 草稿字数 + 继续/弃用按钮
 * 2. 无快照 / 非空闲（运行中）→ 不展示
 * 3. 点击弃用调用后端并使横幅消失
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { StalledRunBanner } from '../stalled-run-banner'
import type { ResumableRunInfo } from '@/api/novel-client'

const listResumableRuns = vi.fn()
const discardResumableRun = vi.fn()

vi.mock('@/api/novel-client', () => ({
  listResumableRuns: (...args: unknown[]) => listResumableRuns(...args),
  discardResumableRun: (...args: unknown[]) => discardResumableRun(...args)
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    [key: string]: unknown
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  )
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const STALLED: ResumableRunInfo = {
  runId: 'run-1',
  chapterNumber: 4,
  status: 'error',
  phase: 'reviewing',
  failedPhase: 'revising',
  writerDraftLength: 6273,
  finalContentLength: 0,
  error: '服务重启导致创作流程中断',
  updatedAt: Date.now() - 5 * 60_000
}

function renderBanner(props: Partial<ComponentProps<typeof StalledRunBanner>> = {}) {
  return render(
    <StalledRunBanner
      projectId="p-1"
      chapterNumber={4}
      visible={true}
      onResume={vi.fn()}
      {...props}
    />
  )
}

describe('StalledRunBanner', () => {
  it('当前章节有可续跑快照时展示阶段、草稿字数与操作按钮', async () => {
    listResumableRuns.mockResolvedValue([STALLED])
    renderBanner()

    await waitFor(() => {
      expect(screen.getByText(/本章有一次未完成的创作/)).toBeTruthy()
    })
    expect(screen.getByText(/草稿已成稿，停在审校阶段/)).toBeTruthy()
    expect(screen.getByText(/6,273 字草稿/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '从断点继续创作' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /弃用第 4 章/ })).toBeTruthy()
    expect(listResumableRuns).toHaveBeenCalledWith('p-1')
  })

  it('运行中（visible=false）不查询也不展示', () => {
    listResumableRuns.mockResolvedValue([STALLED])
    const { container } = renderBanner({ visible: false })

    expect(container.textContent).toBe('')
    expect(listResumableRuns).not.toHaveBeenCalled()
  })

  it('本章无中断记录时不展示', async () => {
    listResumableRuns.mockResolvedValue([])
    const { container } = renderBanner()

    await waitFor(() => expect(listResumableRuns).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('点击弃用调用端点后横幅消失', async () => {
    listResumableRuns.mockResolvedValue([STALLED])
    discardResumableRun.mockResolvedValue({ discarded: true })
    renderBanner()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /弃用第 4 章/ })).toBeTruthy()
    })
    screen.getByRole('button', { name: /弃用第 4 章/ }).click()

    await waitFor(() => {
      expect(discardResumableRun).toHaveBeenCalledWith('p-1', 4, 'run-1')
    })
    await waitFor(() => {
      expect(screen.queryByText(/本章有一次未完成的创作/)).toBeNull()
    })
  })
})
