import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { NovelProject, NovelChapter, NovelVolume, NovelBeatPlan } from '@/api/novel-client'
import { useNovelBeatStore } from '@/stores/novel-beat-store'
import { generateChapterBeatPlan } from '@/api/novel-client'

// ── mock store：用 vi.hoisted 保证 mock 对象在 vi.mock factory 中可访问 ──

const { mockUiStore, mockDataStore } = vi.hoisted(() => ({
  mockUiStore: {
    selectedNodeId: null as string | null,
    playheadChapter: 1,
    expandedVolumes: [] as string[],
    selectNode: vi.fn(),
    setPlayheadChapter: vi.fn(),
    setMatrixScrollTarget: vi.fn(),
    toggleExpandedVolume: vi.fn(),
  },
  mockDataStore: {
    upsertProject: vi.fn(),
    upsertChapter: vi.fn(),
    upsertVolume: vi.fn(),
  },
}))

vi.mock('@/stores/novel-ui-store', () => ({
  useNovelUiStore: (sel: (s: typeof mockUiStore) => unknown) => sel(mockUiStore),
}))

vi.mock('@/stores/novel-data-store', () => ({
  useNovelDataStore: (sel: (s: typeof mockDataStore) => unknown) => sel(mockDataStore),
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
    generateChapterBeatPlan: vi.fn(),
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
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  render(<QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>)
}

describe('OutlineTree', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    mockUiStore.selectedNodeId = null
    mockUiStore.playheadChapter = 1
    mockUiStore.expandedVolumes = ['v1']
    mockUiStore.selectNode.mockClear()
    mockUiStore.setPlayheadChapter.mockClear()
    mockUiStore.setMatrixScrollTarget.mockClear()
    mockDataStore.upsertProject.mockClear()
    mockDataStore.upsertChapter.mockClear()
    mockDataStore.upsertVolume.mockClear()
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
    expect(mockUiStore.selectNode).toHaveBeenCalledWith('c1', 'chapter')
    expect(mockUiStore.setPlayheadChapter).toHaveBeenCalledWith(1)
    expect(mockUiStore.setMatrixScrollTarget).toHaveBeenCalled()
  })

  it('当前 playhead 章高亮', async () => {
    mockUiStore.selectedNodeId = 'c1'
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

describe('OutlineTree 节拍徽标（T4）', () => {
  const beat: NovelBeatPlan = {
    id: 'b1',
    projectId: 'p1',
    volumeNumber: 1,
    chapterNumber: 1,
    dramaticFunction: 'escalation',
    emotionalDebt: '上一章钩子未解',
    payoff: '',
    arcPosition: '前段',
    summary: '主角申诉被堵死。',
    status: 'planned',
    createdAt: 0,
    updatedAt: 0,
  }

  afterEach(() => {
    cleanup()
    useNovelBeatStore.setState({ loadedProjectId: null, beats: [] })
    vi.mocked(generateChapterBeatPlan).mockReset()
  })

  it('有节拍时章节行渲染戏剧功能徽标与走向', async () => {
    useNovelBeatStore.setState({ loadedProjectId: 'p1', beats: [beat] })
    await renderTree()
    expect(screen.getByText('递进加压')).toBeTruthy()
    expect(screen.getByText('主角申诉被堵死。')).toBeTruthy()
  })

  it('无节拍的未发布章显示生成入口，点击后写回共享 store', async () => {
    useNovelBeatStore.setState({ loadedProjectId: 'p1', beats: [] })
    const generated: NovelBeatPlan = { ...beat, dramaticFunction: 'climax', summary: '爆发。' }
    vi.mocked(generateChapterBeatPlan).mockResolvedValue({
      generationId: 'g1',
      chapterNumber: 1,
      beat: generated,
      promptVersion: 'beat-planner-v1'
    })
    await renderTree()
    fireEvent.click(screen.getByText('生成本章节拍'))
    // 等待异步生成完成写回 store
    await vi.waitFor(() => {
      expect(useNovelBeatStore.getState().beats).toHaveLength(1)
    })
    expect(useNovelBeatStore.getState().beats[0].dramaticFunction).toBe('climax')
  })

  it('已发布章节不显示生成入口（节拍只读）', async () => {
    const publishedChapter: NovelChapter = { ...chapter, status: 'published' }
    await renderTree({ chapters: [publishedChapter] })
    expect(screen.queryByText('生成本章节拍')).toBeNull()
  })
})
