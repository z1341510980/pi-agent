import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { NovelProject, NovelChapter, NovelVolume } from '@/api/novel-client'

// ── mock store：用 vi.hoisted 保证 mock 对象在 vi.mock factory 中可访问 ──

const { mockStore } = vi.hoisted(() => ({
  mockStore: {
    selectedNodeId: null as string | null,
    playheadChapter: 1,
    expandedVolumes: [] as string[],
    selectNode: vi.fn(),
    setPlayheadChapter: vi.fn(),
    setMatrixScrollTarget: vi.fn(),
    toggleExpandedVolume: vi.fn(),
    upsertProject: vi.fn(),
    upsertChapter: vi.fn(),
    upsertVolume: vi.fn(),
  },
}))

vi.mock('@/stores/novel-store', () => ({
  useNovelStore: (sel: (s: typeof mockStore) => unknown) => sel(mockStore),
}))

// ── mock api：避免组件中网络调用真实后端 ──

vi.mock('@/api/novel-client', async () => {
  const actual = await vi.importActual<typeof import('@/api/novel-client')>('@/api/novel-client')
  return {
    ...actual,
    updateProject: vi.fn().mockResolvedValue({}),
    updateChapter: vi.fn().mockResolvedValue({}),
    createVolume: vi.fn().mockResolvedValue({ id: 'v-new' }),
    updateVolume: vi.fn().mockResolvedValue({}),
  }
})

// ── 测试夹具 ──

const project: NovelProject = {
  id: 'p1',
  title: '测试书',
  genre: '玄幻',
  synopsis: '',
  outline: '全书大纲',
  targetWords: 0,
  currentVolume: 1,
  currentChapter: 1,
  currentStage: 'setup',
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
}

const volume: NovelVolume = {
  id: 'v1',
  projectId: 'p1',
  volumeNumber: 1,
  title: '起卷',
  outline: '卷纲',
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
}

const chapter: NovelChapter = {
  id: 'c1',
  projectId: 'p1',
  volume: 1,
  chapterNumber: 1,
  title: '第一章',
  content: '',
  wordCount: 0,
  status: 'planned',
  narrativeTask: '',
  outline: '章纲内容',
  volumeId: 'v1',
  acceptanceResult: null,
  createdAt: 0,
  updatedAt: 0,
}

// 延迟 import 让 vi.mock 先生效
async function renderTree(overrides?: {
  chapters?: NovelChapter[]
  onManualArrange?: (chapter: NovelChapter) => void
  onAiArrange?: (chapter: NovelChapter) => void
}): Promise<void> {
  const { OutlineTree } = await import('../outline-tree')
  const tree: ReactElement = (
    <OutlineTree
      project={project}
      volumes={[volume]}
      chapters={overrides?.chapters ?? [chapter]}
      onManualArrange={overrides?.onManualArrange ?? vi.fn<(chapter: NovelChapter) => void>()}
      onAiArrange={overrides?.onAiArrange ?? vi.fn<(chapter: NovelChapter) => void>()}
    />
  )
  render(tree)
}

describe('OutlineTree', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    mockStore.selectedNodeId = null
    mockStore.playheadChapter = 1
    mockStore.expandedVolumes = ['v1']
    mockStore.selectNode.mockClear()
    mockStore.setPlayheadChapter.mockClear()
    mockStore.setMatrixScrollTarget.mockClear()
    mockStore.upsertProject.mockClear()
    mockStore.upsertChapter.mockClear()
    mockStore.upsertVolume.mockClear()
  })

  it('渲染全书大纲、卷、章节点', async () => {
    await renderTree()
    expect(screen.getByText('全书大纲')).toBeTruthy()
    expect(screen.getByText('起卷')).toBeTruthy()
    expect(screen.getByText(/第一章/)).toBeTruthy()
  })

  it('点击章节点触发选中 + playhead + 滚动', async () => {
    await renderTree()
    fireEvent.click(screen.getByText(/第一章/))
    expect(mockStore.selectNode).toHaveBeenCalledWith('c1', 'chapter')
    expect(mockStore.setPlayheadChapter).toHaveBeenCalledWith(1)
    expect(mockStore.setMatrixScrollTarget).toHaveBeenCalled()
  })

  it('当前 playhead 章高亮', async () => {
    mockStore.selectedNodeId = 'c1'
    await renderTree()
    const chapterItem = screen.getByText(/第一章/).closest('button')
    expect(chapterItem).toBeTruthy()
    expect(chapterItem?.className).toContain('bg-primary')
  })

  it('AI编排按钮在章纲为空时禁用', async () => {
    const emptyChapter: NovelChapter = { ...chapter, outline: '' }
    await renderTree({ chapters: [emptyChapter] })
    const aiBtn = screen.getByTitle('AI编排') as HTMLButtonElement
    expect(aiBtn).toBeTruthy()
    expect(aiBtn.disabled).toBe(true)
  })

  it('AI编排按钮在章纲非空时可用', async () => {
    await renderTree()
    const aiBtn = screen.getByTitle('AI编排') as HTMLButtonElement
    expect(aiBtn.disabled).toBe(false)
  })
})
