import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NovelChapter } from '@/api/novel-client'

const {
  upsertChapter,
  updateChapter,
  generateChapterOutline,
  publishChapter,
  toastSuccess,
  toastError,
} = vi.hoisted(() => ({
  upsertChapter: vi.fn(),
  updateChapter: vi.fn(),
  generateChapterOutline: vi.fn(),
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
    updateChapter,
    generateChapterOutline,
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

  it('AI 生成只展示草稿，应用并保存后才更新章纲', async () => {
    const generationId = '3f0af3a7-6077-4cee-879d-a41f04f33a0a'
    generateChapterOutline.mockResolvedValue({
      generationId,
      draft: {
        version: 1,
        outlineText: '主角调查旧城区，在证词矛盾中发现幕后操纵者，结尾遭到跟踪。',
        chapterGoal: '推进失踪案调查',
        openingState: '主角只有一条不完整线索',
        progression: ['进入旧城区', '核对证词', '发现证词被篡改'],
        obstacles: ['证人拒绝配合'],
        turningPoint: '证人说出幕后人的特征',
        endingState: '主角锁定下一步方向',
        hook: '幕后人开始跟踪主角',
        sceneCountEstimate: 3,
        povSuggestions: [],
        storylines: [],
        continuityRisks: [],
      },
      base: {
        chapterId: reviewChapter.id,
        outlineHash: 'a'.repeat(64),
        contentRevisionId: 'content-revision-1',
        planRevisionId: null,
        contextFingerprint: 'fingerprint',
      },
      model: { modelId: 'test:model', promptVersion: 'outline-planner-v1' },
      warnings: [],
    })
    const updated = {
      ...reviewChapter,
      outline: '主角调查旧城区，在证词矛盾中发现幕后操纵者，结尾遭到跟踪。',
    }
    updateChapter.mockResolvedValue(updated)
    const { ChapterForm } = await import('../detail-forms/chapter-form')

    render(<ChapterForm entity={reviewChapter} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成章纲' }))

    await screen.findByText('AI 章纲草稿')
    expect(generateChapterOutline).toHaveBeenCalledWith(
      'project-1',
      1,
      expect.objectContaining({
        mode: 'rewrite',
        currentOutline: '章纲',
        expectedOutline: '章纲',
      }),
      expect.any(AbortSignal),
    )
    expect(updateChapter).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '应用到编辑器' }))
    expect(updateChapter).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox', { name: '章纲内容' }) as HTMLTextAreaElement).value)
      .toBe(updated.outline)

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(updateChapter).toHaveBeenCalledWith(
      'chapter-1',
      expect.objectContaining({
        outline: updated.outline,
        expectedOutlineHash: 'a'.repeat(64),
        expectedContentRevisionId: 'content-revision-1',
        outlineGenerationId: generationId,
      }),
    ))
    expect(upsertChapter).toHaveBeenCalledWith(updated)
  })

  it('生成预览期间章节变为已发布时清空草稿并禁止应用', async () => {
    generateChapterOutline.mockResolvedValue({
      generationId: '3f0af3a7-6077-4cee-879d-a41f04f33a0a',
      draft: {
        version: 1,
        outlineText: '这是一份尚未应用的章纲草稿，章节发布后必须立即失效。',
        chapterGoal: '推进调查',
        openingState: '线索不足',
        progression: ['调查旧城区'],
        obstacles: [],
        turningPoint: '发现证人',
        endingState: '获得线索',
        hook: '危险逼近',
        sceneCountEstimate: 2,
        povSuggestions: [],
        storylines: [],
        continuityRisks: [],
      },
      base: {
        chapterId: reviewChapter.id,
        outlineHash: 'a'.repeat(64),
        contentRevisionId: null,
        planRevisionId: null,
        contextFingerprint: 'fingerprint',
      },
      model: { modelId: 'test:model', promptVersion: 'outline-planner-v1' },
      warnings: [],
    })
    const { ChapterForm } = await import('../detail-forms/chapter-form')
    const { rerender } = render(<ChapterForm entity={reviewChapter} />)

    fireEvent.click(screen.getByRole('button', { name: 'AI 生成章纲' }))
    await screen.findByText('AI 章纲草稿')

    rerender(<ChapterForm entity={{ ...reviewChapter, status: 'published' }} />)

    await waitFor(() => expect(screen.queryByText('AI 章纲草稿')).toBeNull())
    expect((screen.getByRole('textbox', { name: '章纲内容' }) as HTMLTextAreaElement).disabled)
      .toBe(true)
    expect(screen.queryByRole('button', { name: '应用到编辑器' })).toBeNull()
  })
})
