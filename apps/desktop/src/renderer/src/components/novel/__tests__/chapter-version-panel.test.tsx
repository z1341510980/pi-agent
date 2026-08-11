import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChapterVersion, ChapterVersionSummary } from '@repo/shared/novel'
import { ChapterVersionPanel } from '../chapter-version-panel'

const api = vi.hoisted(() => ({
  applyChapterVersion: vi.fn(),
  createChapterSnapshot: vi.fn(),
  diffChapterVersions: vi.fn(),
  getChapterVersion: vi.fn(),
  listChapterVersions: vi.fn(),
  listContentRevisions: vi.fn(),
  rollbackToContentRevision: vi.fn()
}))

vi.mock('@/api/novel-client', () => api)

vi.mock('@/hooks/use-toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

const VERSIONS: ChapterVersionSummary[] = [
  {
    id: 'version-2',
    sequence: 2,
    phase: 'manual_patch',
    agentType: null,
    trigger: '保存正文',
    wordCount: 8,
    wordCountDelta: 4,
    createdAt: Date.now(),
    isCurrent: true
  },
  {
    id: 'version-1',
    sequence: 1,
    phase: 'writer_initial',
    agentType: null,
    trigger: '生成初稿',
    wordCount: 4,
    wordCountDelta: 0,
    createdAt: Date.now() - 60_000,
    isCurrent: false
  }
]

// V2 版本链（content revision）返回形状
const REVISIONS = [
  {
    id: 'revision-2',
    chapterId: 'chapter-1',
    projectId: 'project-1',
    revision: 2,
    status: 'committed',
    phase: 'manual_patch',
    agentType: null,
    trigger: '保存正文',
    wordCount: 8,
    content: '当前版本正文',
    isCurrent: true,
    createdAt: Date.now(),
    parentRevisionId: 'revision-1'
  },
  {
    id: 'revision-1',
    chapterId: 'chapter-1',
    projectId: 'project-1',
    revision: 1,
    status: 'superseded',
    phase: 'writer_initial',
    agentType: null,
    trigger: '生成初稿',
    wordCount: 4,
    content: '第一版正文',
    isCurrent: false,
    createdAt: Date.now() - 60_000,
    parentRevisionId: null
  }
]

function versionDetail(id: string): ChapterVersion {
  const summary = VERSIONS.find((version) => version.id === id)!
  return {
    id,
    chapterId: 'chapter-1',
    projectId: 'project-1',
    content: id === 'version-2' ? '当前版本正文' : '第一版正文',
    wordCount: summary.wordCount,
    phase: summary.phase,
    agentType: summary.agentType,
    trigger: summary.trigger,
    sequence: summary.sequence,
    createdAt: summary.createdAt
  }
}

beforeEach(() => {
  api.listChapterVersions.mockResolvedValue(VERSIONS)
  api.listContentRevisions.mockResolvedValue(REVISIONS)
  api.rollbackToContentRevision.mockResolvedValue({
    content: '第一版正文',
    wordCount: 4,
    appliedRevisionId: 'revision-3'
  })
  api.getChapterVersion.mockImplementation((_chapterId: string, versionId: string) =>
    Promise.resolve(versionDetail(versionId))
  )
  api.applyChapterVersion.mockResolvedValue({
    success: true,
    savedVersionId: 'saved-current',
    currentContent: '第一版正文',
    currentWordCount: 4
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChapterVersionPanel', () => {
  it('默认展示 V2 版本链，点击版本详情 Tab 后稳定选择并加载对应详情', async () => {
    render(<ChapterVersionPanel open onOpenChange={vi.fn()} chapterId="chapter-1" />)

    // 默认 Tab 为「版本链」（P1-1 主读源切 V2）
    expect(await screen.findByText('不可变版本链（V2）')).not.toBeNull()
    // 点击「刷新」加载 V2 版本链
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(api.listContentRevisions).toHaveBeenCalledWith('chapter-1')
    })
    await screen.findByText('rev 2')

    // 切到「版本详情」Tab：默认选中最新版（version-2）
    fireEvent.mouseDown(screen.getByRole('tab', { name: '版本详情' }), { button: 0 })
    await screen.findByText('当前版本正文')
    expect(api.listChapterVersions).toHaveBeenCalledTimes(1)

    const firstVersionRow = screen.getByRole('button', { name: /第 1 版/ })
    fireEvent.click(firstVersionRow)

    await screen.findByText('第一版正文')
    expect(firstVersionRow.getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => {
      expect(api.getChapterVersion).toHaveBeenLastCalledWith('chapter-1', 'version-1')
    })
    expect(api.listChapterVersions).toHaveBeenCalledTimes(1)
  })

  it('所选历史版本经确认后应用到当前正文', async () => {
    const onBeforeApply = vi.fn().mockResolvedValue(true)
    const onApplySuccess = vi.fn()
    render(
      <ChapterVersionPanel
        open
        onOpenChange={vi.fn()}
        chapterId="chapter-1"
        onBeforeApply={onBeforeApply}
        onApplySuccess={onApplySuccess}
      />
    )

    fireEvent.mouseDown(screen.getByRole('tab', { name: '版本详情' }), { button: 0 })
    await screen.findByText('当前版本正文')
    fireEvent.click(screen.getByRole('button', { name: /第 1 版/ }))
    await screen.findByText('第一版正文')
    fireEvent.click(screen.getByRole('button', { name: '应用到正文' }))

    expect(screen.getByRole('heading', { name: '应用此版本到正文？' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '确认应用' }))

    await waitFor(() => {
      expect(onBeforeApply).toHaveBeenCalledTimes(1)
      expect(api.applyChapterVersion).toHaveBeenCalledWith('chapter-1', 'version-1')
      expect(onApplySuccess).toHaveBeenCalledWith('第一版正文', 4)
    })
  })

  it('Diff 勾选与版本详情选择使用独立点击区域', async () => {
    render(<ChapterVersionPanel open onOpenChange={vi.fn()} chapterId="chapter-1" />)

    fireEvent.mouseDown(screen.getByRole('tab', { name: '版本详情' }), { button: 0 })
    await screen.findByText('当前版本正文')
    const currentRow = screen.getByRole('button', { name: /第 2 版/ })
    const firstVersionRow = screen.getByRole('button', { name: /第 1 版/ })
    const diffCheckbox = screen.getByRole('checkbox', { name: '选择第 1 版用于对比' })

    fireEvent.click(diffCheckbox)

    expect((diffCheckbox as HTMLInputElement).checked).toBe(true)
    expect(currentRow.getAttribute('aria-pressed')).toBe('true')
    expect(firstVersionRow.getAttribute('aria-pressed')).toBe('false')
    expect(api.getChapterVersion).toHaveBeenLastCalledWith('chapter-1', 'version-2')
  })

  it('使用小说工作区弹框尺寸与分栏样式', async () => {
    render(<ChapterVersionPanel open onOpenChange={vi.fn()} chapterId="chapter-1" />)

    await screen.findByText('不可变版本链（V2）')
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('w-[min(1120px,calc(100vw-32px))]')
    expect(dialog.className).toContain('sm:max-w-none')
    expect(screen.getByText('版本记录')).not.toBeNull()
    expect(screen.getByRole('tab', { name: '版本详情' })).not.toBeNull()
  })
})
