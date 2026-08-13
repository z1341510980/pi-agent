import { describe, expect, it, vi } from 'vitest'
import { NovelEngine } from '../core/novel-engine.js'
import { hashChapterContent } from '../core/stores/chapter-store.js'

function createStore(targetWords: number) {
  return {
    listConstraints: () => [],
    listForeshadowing: () => [],
    listCharacters: () => [],
    getProject: () => ({ targetWords }),
  } as any
}

describe('NovelEngine chapter word budget', () => {
  it('does not compound climax and high-pressure multipliers（单链：定位默认 0%、节奏不参与 → 3000）', () => {
    const engine = new NovelEngine(createStore(3000))

    const constraints = engine.buildChapterConstraints(
      'project-1',
      undefined,
      { rhythm: 'climax' } as any,
      'high_pressure',
    )

    // 2026-08-12 逻辑统一：统一走 WordBudgetResolver，定位默认 0% → 3000
    expect(constraints.wordBudget).toEqual({
      min: 2550,
      max: 3450,
      target: 3000,
    })
  })

  it('uses rhythm as the fallback when positioning is not specified', () => {
    const engine = new NovelEngine(createStore(3000))

    const constraints = engine.buildChapterConstraints(
      'project-1',
      undefined,
      { rhythm: 'climax' } as any,
    )

    expect(constraints.wordBudget).toBeNull()
  })
})

describe('NovelEngine publish lifecycle', () => {
  it('rejects publishing when the accepted review belongs to older content', async () => {
    const chapter = {
      id: 'chapter-1', projectId: 'project-1', chapterNumber: 1,
      status: 'review', content: '当前正文', wordCount: 4,
    }
    const updateChapter = vi.fn()
    const engine = new NovelEngine({
      getChapterById: () => chapter,
      getAcceptedChapterReviewForContent: () => undefined,
      getCurrentContentRevision: () => ({ id: 'rev-current', content: chapter.content }),
      listChapters: () => [chapter],
      updateChapter,
    } as any)

    await expect(engine.publishChapter(chapter.id)).rejects.toThrow(/当前正文.*审稿/)
    expect(updateChapter).not.toHaveBeenCalled()
  })

  it('publishes reviewed non-empty content and advances project progress', async () => {
    const chapter = {
      id: 'chapter-1', projectId: 'project-1', chapterNumber: 2,
      status: 'review', content: '当前正文', wordCount: 4,
    }
    const updateProject = vi.fn()
    const store = {
      getChapterById: () => chapter,
      getAcceptedChapterReviewForContent: (_chapterId: string, contentHash: string) => (
        contentHash === hashChapterContent(chapter.content)
          ? { verdict: 'accept', contentHash, contentRevisionId: 'rev-current' }
          : undefined
      ),
      getCurrentContentRevision: () => ({ id: 'rev-current', content: chapter.content }),
      listChapters: () => [{ ...chapter, chapterNumber: 1, status: 'published' }, chapter],
      publishReviewedChapter: vi.fn(() => ({ ...chapter, status: 'published' })),
      getProject: () => ({ id: 'project-1', currentChapter: 1 }),
      updateProject,
    }
    const engine = new NovelEngine(store as any)

    await expect(engine.publishChapter(chapter.id)).resolves.toMatchObject({ status: 'published' })
    expect(updateProject).toHaveBeenCalledWith('project-1', { currentChapter: 2 })
  })

  it('rejects publishing when an earlier chapter is not published', async () => {
    const chapter = {
      id: 'chapter-2', projectId: 'project-1', chapterNumber: 2,
      status: 'review', content: '当前正文', wordCount: 4,
    }
    const engine = new NovelEngine({
      getChapterById: () => chapter,
      getAcceptedChapterReviewForContent: () => ({
        verdict: 'accept', contentRevisionId: 'rev-current',
      }),
      getCurrentContentRevision: () => ({ id: 'rev-current', content: chapter.content }),
      listChapters: () => [{ ...chapter, id: 'chapter-1', chapterNumber: 1, status: 'review' }, chapter],
      updateChapter: vi.fn(),
    } as any)

    await expect(engine.publishChapter(chapter.id)).rejects.toThrow(/前序章节/)
  })
})
