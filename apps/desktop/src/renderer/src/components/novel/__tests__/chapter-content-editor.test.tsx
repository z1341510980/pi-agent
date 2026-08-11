import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { editor, dataStore, uiStore, queryClient } = vi.hoisted(() => {
  const editor = {
    commands: { setContent: vi.fn() },
    setEditable: vi.fn(),
    isActive: vi.fn(() => false),
    can: vi.fn(() => ({
      toggleBold: () => true,
      toggleItalic: () => true,
      undo: () => true,
      redo: () => true,
    })),
  }

  return {
    editor,
    dataStore: {
      currentProjectId: 'project-1',
      chapters: [{
        id: 'chapter-1',
        projectId: 'project-1',
        volume: 1,
        chapterNumber: 1,
        title: '第一章',
        content: '章节正文',
        wordCount: 4,
        status: 'completed',
        createdAt: 0,
        updatedAt: 0,
      }],
      upsertChapter: vi.fn(),
    },
    uiStore: {
      playheadChapter: 1,
      setPlayheadChapter: vi.fn(),
    },
    queryClient: { invalidateQueries: vi.fn() },
  }
})

vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => editor),
  EditorContent: () => <div data-testid="tiptap-editor" />,
}))

vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('tiptap-markdown', () => ({ Markdown: {} }))

vi.mock('@/stores/novel-data-store', () => ({
  useNovelDataStore: (selector: (state: typeof dataStore) => unknown) => selector(dataStore),
}))

vi.mock('@/stores/novel-ui-store', () => ({
  useNovelUiStore: (selector: (state: typeof uiStore) => unknown) => selector(uiStore),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => queryClient,
}))

vi.mock('@/api/novel-client', () => ({
  updateChapter: vi.fn(),
  reverseArrangeFlow: vi.fn(),
}))

vi.mock('@/hooks/use-toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('../chapter-version-panel', () => ({
  ChapterVersionPanel: () => null,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChapterContentEditor', () => {
  it('首次渲染时不会在 editor 初始化前读取 editor', async () => {
    const { ChapterContentEditor } = await import('../chapter-content-editor')

    expect(() => render(<ChapterContentEditor isCreationActive={false} />)).not.toThrow()
    expect(screen.getByTestId('tiptap-editor')).not.toBeNull()
    expect(editor.commands.setContent).toHaveBeenCalledWith('章节正文', { emitUpdate: false })
  })

  it('空正文章节（content=""）渲染可编辑编辑器，而不是"无章节"提示', async () => {
    const { ChapterContentEditor } = await import('../chapter-content-editor')
    dataStore.chapters[0] = { ...dataStore.chapters[0], content: '' }

    render(<ChapterContentEditor isCreationActive={false} />)

    // 章节存在但正文为空 → 必须走 EditorContent 路径（可输入），不显示 cce-empty
    expect(screen.getByTestId('tiptap-editor')).not.toBeNull()
    expect(screen.queryByText('无章节，请先创建章节')).toBeNull()
    // 空内容也正常 setContent('') 并保持可编辑
    expect(editor.commands.setContent).toHaveBeenCalledWith('', { emitUpdate: false })
    expect(editor.setEditable).toHaveBeenCalledWith(true)
  })

  it('创作流程激活时（isCreationActive=true）编辑器进入只读模式', async () => {
    const { ChapterContentEditor } = await import('../chapter-content-editor')

    render(<ChapterContentEditor isCreationActive={true} />)

    // isCreationActive=true → useEffect 调用 editor.setEditable(false)
    expect(editor.setEditable).toHaveBeenCalledWith(false)
  })

  it('编辑器初始化失败（useEditor 返回 null）时组件不崩溃', async () => {
    // 临时让 useEditor 返回 null，模拟初始化失败
    const { useEditor } = await import('@tiptap/react')
    vi.mocked(useEditor).mockReturnValueOnce(null as unknown as ReturnType<typeof useEditor>)

    const { ChapterContentEditor } = await import('../chapter-content-editor')

    // 不应抛出异常，仍能正常渲染
    expect(() => render(<ChapterContentEditor isCreationActive={false} />)).not.toThrow()
  })

})
