import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NovelChapter } from '@repo/shared/novel'

const { editor, editorState, dataStore, uiStore, queryClient } = vi.hoisted(() => {
  const editorState: { markdown: string; onUpdate?: (event: { editor: unknown }) => void } = {
    markdown: ''
  }
  const editor = {
    storage: { markdown: { getMarkdown: () => editorState.markdown } },
    commands: {
      setContent: vi.fn((content: string) => {
        editorState.markdown = content
      })
    },
    setEditable: vi.fn(),
    isActive: vi.fn(() => false),
    can: vi.fn(() => ({
      toggleBold: () => true,
      toggleItalic: () => true,
      undo: () => true,
      redo: () => true
    }))
  }
  return {
    editor,
    editorState,
    dataStore: {
      currentProjectId: 'project-1',
      chapters: [] as Array<ReturnType<typeof makeChapter>>,
      upsertChapter: vi.fn()
    },
    uiStore: {
      playheadChapter: 1,
      setPlayheadChapter: vi.fn(),
      selectedAgentModel: null,
      unsavedChapterDraft: null as {
        chapterId: string
        chapterNumber: number
        content: string
      } | null,
      setUnsavedChapterDraft: vi.fn(),
      clearUnsavedChapterDraft: vi.fn()
    },
    queryClient: { invalidateQueries: vi.fn() }
  }
})

function makeChapter(
  id: string,
  chapterNumber: number,
  content: string,
  updatedAt = 100
): NovelChapter {
  return {
    id,
    projectId: 'project-1',
    volume: 1,
    chapterNumber,
    title: `第${chapterNumber}章`,
    content,
    wordCount: content.length,
    status: 'drafting' as const,
    narrativeTask: '',
    acceptanceResult: null,
    createdAt: 0,
    updatedAt
  }
}

vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn((options: { onUpdate?: (event: { editor: unknown }) => void }) => {
    editorState.onUpdate = options.onUpdate
    return editor
  }),
  EditorContent: () => <div data-testid="tiptap-editor" />
}))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('tiptap-markdown', () => ({ Markdown: {} }))
vi.mock('@/stores/novel-data-store', () => ({
  useNovelDataStore: Object.assign(
    (selector: (state: typeof dataStore) => unknown) => selector(dataStore),
    { getState: () => dataStore }
  )
}))
vi.mock('@/stores/novel-ui-store', () => ({
  useNovelUiStore: Object.assign(
    (selector: (state: typeof uiStore) => unknown) => selector(uiStore),
    { getState: () => uiStore }
  )
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }))
vi.mock('@/api/novel-client', () => ({
  updateChapter: vi.fn(),
  reverseArrangeFlow: vi.fn(),
  getChapter: vi.fn()
}))
vi.mock('@/hooks/use-toast', () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))
vi.mock('../chapter-version-panel', () => ({ ChapterVersionPanel: () => null }))

function resetState(): void {
  dataStore.chapters = [makeChapter('chapter-1', 1, '列表中的旧正文')]
  dataStore.upsertChapter.mockReset()
  uiStore.playheadChapter = 1
  uiStore.unsavedChapterDraft = null
  uiStore.setPlayheadChapter.mockReset()
  uiStore.setUnsavedChapterDraft.mockImplementation((draft) => {
    uiStore.unsavedChapterDraft = draft
  })
  uiStore.clearUnsavedChapterDraft.mockImplementation((chapterId?: string) => {
    if (!chapterId || uiStore.unsavedChapterDraft?.chapterId === chapterId)
      uiStore.unsavedChapterDraft = null
  })
  editorState.markdown = ''
  editorState.onUpdate = undefined
  editor.commands.setContent.mockClear()
  editor.setEditable.mockClear()
  queryClient.invalidateQueries.mockReset()
}

function emitEditorUpdate(): void {
  if (!editorState.onUpdate) throw new Error('编辑器尚未注册 onUpdate')
  editorState.onUpdate({ editor })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetState()
})
afterEach(() => {
  cleanup()
})

describe('ChapterContentEditor', () => {
  it('以单章接口正文建立初始基线，不使用章节列表正文', async () => {
    const api = await import('@/api/novel-client')
    vi.mocked(api.getChapter).mockResolvedValue(makeChapter('chapter-1', 1, '接口正文', 101))
    const { ChapterContentEditor } = await import('../chapter-content-editor')
    expect(() => render(<ChapterContentEditor isCreationActive={false} />)).not.toThrow()
    expect(screen.getByTestId('tiptap-editor')).not.toBeNull()
    await waitFor(() =>
      expect(editor.commands.setContent).toHaveBeenLastCalledWith('接口正文', { emitUpdate: false })
    )
    expect(api.getChapter).toHaveBeenCalledWith('chapter-1')
    expect(editor.commands.setContent).not.toHaveBeenCalledWith('列表中的旧正文', {
      emitUpdate: false
    })
    expect(screen.getByText('已保存')).not.toBeNull()
  })

  it('空正文章节渲染可编辑编辑器，而不是“无章节”提示', async () => {
    const api = await import('@/api/novel-client')
    dataStore.chapters = [makeChapter('chapter-1', 1, '')]
    vi.mocked(api.getChapter).mockResolvedValue(makeChapter('chapter-1', 1, ''))
    const { ChapterContentEditor } = await import('../chapter-content-editor')
    render(<ChapterContentEditor isCreationActive={false} />)
    expect(screen.getByTestId('tiptap-editor')).not.toBeNull()
    expect(screen.queryByText('无章节，请先创建章节')).toBeNull()
    await waitFor(() =>
      expect(editor.commands.setContent).toHaveBeenLastCalledWith('', { emitUpdate: false })
    )
    expect(editor.setEditable).toHaveBeenCalledWith(true)
  })

  it('快速切换时只允许最后一个单章请求回填编辑器', async () => {
    const api = await import('@/api/novel-client')
    let resolveFirst: (chapter: ReturnType<typeof makeChapter>) => void = () => undefined
    let resolveSecond: (chapter: ReturnType<typeof makeChapter>) => void = () => undefined
    const firstRequest = new Promise<ReturnType<typeof makeChapter>>((resolve) => {
      resolveFirst = resolve
    })
    const secondRequest = new Promise<ReturnType<typeof makeChapter>>((resolve) => {
      resolveSecond = resolve
    })
    dataStore.chapters = [
      makeChapter('chapter-1', 1, '列表第一章'),
      makeChapter('chapter-2', 2, '列表第二章')
    ]
    vi.mocked(api.getChapter).mockImplementation((id) =>
      id === 'chapter-1' ? firstRequest : secondRequest
    )
    const { ChapterContentEditor } = await import('../chapter-content-editor')
    const view = render(<ChapterContentEditor isCreationActive={false} />)
    await waitFor(() => expect(api.getChapter).toHaveBeenCalledWith('chapter-1'))
    editor.commands.setContent.mockClear()
    uiStore.playheadChapter = 2
    view.rerender(<ChapterContentEditor isCreationActive={false} />)
    await waitFor(() => expect(api.getChapter).toHaveBeenCalledWith('chapter-2'))
    await act(async () => {
      resolveFirst(makeChapter('chapter-1', 1, '第一章接口正文'))
    })
    expect(editor.commands.setContent).not.toHaveBeenCalledWith('第一章接口正文', {
      emitUpdate: false
    })
    await act(async () => {
      resolveSecond(makeChapter('chapter-2', 2, '第二章接口正文'))
    })
    await waitFor(() =>
      expect(editor.commands.setContent).toHaveBeenLastCalledWith('第二章接口正文', {
        emitUpdate: false
      })
    )
  })

  it('丢弃旧章节迟到的 onUpdate，只将真实修改写为当前章节草稿', async () => {
    const api = await import('@/api/novel-client')
    dataStore.chapters = [
      makeChapter('chapter-1', 1, '列表第一章'),
      makeChapter('chapter-2', 2, '列表第二章')
    ]
    vi.mocked(api.getChapter).mockImplementation(async (id) =>
      id === 'chapter-1'
        ? makeChapter('chapter-1', 1, '第一章接口正文')
        : makeChapter('chapter-2', 2, '第二章接口正文')
    )
    const { ChapterContentEditor } = await import('../chapter-content-editor')
    const view = render(<ChapterContentEditor isCreationActive={false} />)
    await waitFor(() =>
      expect(editor.commands.setContent).toHaveBeenLastCalledWith('第一章接口正文', {
        emitUpdate: false
      })
    )
    uiStore.playheadChapter = 2
    view.rerender(<ChapterContentEditor isCreationActive={false} />)
    await waitFor(() =>
      expect(editor.commands.setContent).toHaveBeenLastCalledWith('第二章接口正文', {
        emitUpdate: false
      })
    )
    await act(async () => {
      editorState.markdown = '第一章接口正文'
      emitEditorUpdate()
    })
    expect(uiStore.setUnsavedChapterDraft).not.toHaveBeenCalled()
    expect(screen.queryByText('未保存')).toBeNull()
    await act(async () => {
      editorState.markdown = '第二章接口正文'
      emitEditorUpdate()
    })
    await act(async () => {
      editorState.markdown = '第二章接口正文，用户修改'
      emitEditorUpdate()
    })
    expect(uiStore.setUnsavedChapterDraft).toHaveBeenLastCalledWith({
      chapterId: 'chapter-2',
      chapterNumber: 2,
      content: '第二章接口正文，用户修改'
    })
    expect(screen.getByText('未保存')).not.toBeNull()
  })

  it('保存成功后以接口响应更新基线并清除当前章节草稿', async () => {
    const api = await import('@/api/novel-client')
    dataStore.chapters = [makeChapter('chapter-1', 1, '列表正文', 100)]
    vi.mocked(api.getChapter).mockResolvedValue(makeChapter('chapter-1', 1, '接口正文', 101))
    vi.mocked(api.updateChapter).mockResolvedValue(
      makeChapter('chapter-1', 1, '用户修改后的正文', 202)
    )
    const { ChapterContentEditor } = await import('../chapter-content-editor')

    render(<ChapterContentEditor isCreationActive={false} />)
    await waitFor(() =>
      expect(editor.commands.setContent).toHaveBeenLastCalledWith('接口正文', { emitUpdate: false })
    )
    await act(async () => {
      editorState.markdown = '接口正文'
      emitEditorUpdate()
      editorState.markdown = '用户修改后的正文'
      emitEditorUpdate()
    })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(api.updateChapter).toHaveBeenCalledWith('chapter-1', { content: '用户修改后的正文' })
    )
    await waitFor(() => expect(screen.getByText('已保存')).not.toBeNull())
    expect(uiStore.clearUnsavedChapterDraft).toHaveBeenCalledWith('chapter-1')
  })

  it('创作流程激活时编辑器进入只读模式', async () => {
    const { ChapterContentEditor } = await import('../chapter-content-editor')
    render(<ChapterContentEditor isCreationActive />)
    expect(editor.setEditable).toHaveBeenCalledWith(false)
  })

  it('编辑器初始化失败时组件不崩溃', async () => {
    const api = await import('@/api/novel-client')
    vi.mocked(api.getChapter).mockResolvedValue(makeChapter('chapter-1', 1, '接口正文'))
    const { useEditor } = await import('@tiptap/react')
    vi.mocked(useEditor).mockReturnValueOnce(null as unknown as ReturnType<typeof useEditor>)
    const { ChapterContentEditor } = await import('../chapter-content-editor')
    expect(() => render(<ChapterContentEditor isCreationActive={false} />)).not.toThrow()
  })
})
