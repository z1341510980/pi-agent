import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NovelChapter } from '@/api/novel-client'

const { upsertChapter, publishChapter, toastSuccess, toastError } = vi.hoisted(() => ({
  upsertChapter: vi.fn(),
  publishChapter: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/stores/novel-data-store', () => ({
  useNovelDataStore: (selector: (state: { upsertChapter: typeof upsertChapter }) => unknown) =>
    selector({ upsertChapter }),
}))

vi.mock('@/api/novel-client', async () => {
  const actual = await vi.importActual<typeof import('@/api/novel-client')>('@/api/novel-client')
  return {
    ...actual,
    updateChapter: vi.fn(),
    updateVolume: vi.fn(),
    publishChapter,
  }
})

vi.mock('@/hooks/use-toast', () => ({ toastSuccess, toastError }))

const reviewChapter: NovelChapter = {
  id: 'chapter-1',
  projectId: 'project-1',
  volume: 1,
  chapterNumber: 1,
  title: '第一章',
  content: '正文',
  wordCount: 2,
  status: 'review',
  narrativeTask: '推进主线',
  outline: '章纲',
  volumeId: null,
  acceptanceResult: null,
  createdAt: 0,
  updatedAt: 0,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('ChapterForm', () => {
  it('待审章节通过专用发布命令进入 published', async () => {
    const published = { ...reviewChapter, status: 'published' as const }
    publishChapter.mockResolvedValue(published)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { ChapterForm } = await import('../detail-forms/chapter-form')

    render(<ChapterForm entity={reviewChapter} />)
    fireEvent.click(screen.getByRole('button', { name: '发布章节' }))

    await waitFor(() => expect(publishChapter).toHaveBeenCalledWith('chapter-1'))
    expect(upsertChapter).toHaveBeenCalledWith(published)
    expect(toastSuccess).toHaveBeenCalledWith('章节已发布', '第 1 章已进入正式时间线')
  })

  it('非待审章节不显示发布命令', async () => {
    const { ChapterForm } = await import('../detail-forms/chapter-form')

    render(<ChapterForm entity={{ ...reviewChapter, status: 'drafting' }} />)

    expect(screen.queryByRole('button', { name: '发布章节' })).toBeNull()
  })
})
