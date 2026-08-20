/**
 * novel-workspace 输入框斜杠命令层测试
 *
 * 覆盖两条路径：
 * 1. ensureChapterExists（模块级导出，依赖注入）直测：建章成功/失败的契约；
 * 2. NovelWorkspace 渲染测试：渲染真实 workspace + 真实 NovelConversationPanel，
 *    从输入框键入 /写 N、/重写 N，验证 workspace 的 handleStartFlowCommand 分发
 *    （建章 → 启动 / toastError / 互斥锁拦截）。重型子组件（矩阵、画布、编辑器等）
 *    与数据 hook 一律 mock 隔离，隔离方式与 novel-conversation-interject.test.tsx 一致。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { NovelChapter, NovelProject } from '@repo/shared/novel'
import { NovelWorkspace, ensureChapterExists } from '../novel-workspace'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelWorkspaceLayoutStore } from '@/stores/novel-workspace-layout-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'

// ── mock：api client（不发真实网络请求）──

const api = vi.hoisted(() => ({
  listCharacters: vi.fn(),
  listChapters: vi.fn(),
  listConflicts: vi.fn(),
  listForeshadowing: vi.fn(),
  listRelationships: vi.fn(),
  listClues: vi.fn(),
  listWorldRules: vi.fn(),
  listStyleGuides: vi.fn(),
  listConstraints: vi.fn(),
  listInfoLayers: vi.fn(),
  listFactions: vi.fn(),
  listLocations: vi.fn(),
  listWorldElements: vi.fn(),
  listItems: vi.fn(),
  listNarratives: vi.fn(),
  listEdges: vi.fn(),
  listVolumes: vi.fn(),
  listProjectCharacterHistory: vi.fn(),
  getChapterArrangedEntities: vi.fn(),
  createChapter: vi.fn(),
  completeChapter: vi.fn(),
  getTimelineRebuildPreview: vi.fn(),
  getTimelineRebuildJob: vi.fn(),
  startTimelineRebuild: vi.fn(),
  getWritingStyleProfile: vi.fn().mockResolvedValue(null),
  listWritingStyleExperts: vi.fn().mockResolvedValue([]),
  saveWritingStyleProfile: vi.fn(),
}))

vi.mock('@/api/novel-client', () => api)

// ── mock：toast（只断言调用）──

const toasts = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('@/hooks/use-toast', () => toasts)

// ── mock：创作流程 hook（可变对象，测试内改 isRunning 后 rerender 生效）──

const flow = vi.hoisted(() => ({
  phase: 'idle' as 'idle',
  isRunning: false,
  progressMessage: null as string | null,
  chapterContent: '',
  agentOutputs: [] as unknown[],
  currentCheckpoint: null,
  checkpointHistory: [] as unknown[],
  result: null,
  error: null as string | null,
  userMessages: [] as unknown[],
  interjectMessages: [] as unknown[],
  submitCheckpoint: vi.fn(),
  reset: vi.fn(),
  cancel: vi.fn(),
  sendMessage: vi.fn(),
  sendInterject: vi.fn(),
  startCreation: vi.fn(),
  startDiscussion: vi.fn(),
  aiArrange: vi.fn(),
  reverseArrange: vi.fn(),
  resumeDiscussion: vi.fn(),
  resumeWorkflow: vi.fn(),
  reRevise: vi.fn(),
  keepDraft: vi.fn(),
  takeArrangedCharacterFunctions: vi.fn(),
}))

vi.mock('@/hooks/use-novel-creation-flow', () => ({
  useNovelCreationFlow: () => flow,
  // NovelConversationPanel 也从这里引入 formatDetailBubble（渲染检查点卡片用，本测试不触发）
  formatDetailBubble: () => ({ content: '' }),
}))

// ── mock：其余数据 hook ──

const chapterChat = vi.hoisted(() => ({
  messages: [] as unknown[],
  agentOutputs: [] as unknown[],
  isRunning: false,
  error: null as string | null,
  sendMessage: vi.fn(),
  abort: vi.fn(),
  loadHistory: vi.fn(),
}))

vi.mock('@/hooks/use-chapter-chat', () => ({ useChapterChat: () => chapterChat }))

vi.mock('@/hooks/use-novel-session', () => ({
  useNovelSession: () => ({
    creationFlow: flow,
    chapterChat,
    activeRun: { kind: 'idle', isRunning: false },
    chatAgentOutputs: chapterChat.agentOutputs,
    startWorkflow: flow.startCreation,
    startDiscussion: flow.startDiscussion,
    resumeWorkflow: flow.resumeWorkflow,
    resumeDiscussion: flow.resumeDiscussion,
    sendChat: chapterChat.sendMessage,
    abortChat: chapterChat.abort,
    sendInterject: flow.sendInterject,
  }),
}))

const similarityScan = vi.hoisted(() => ({
  phase: 'idle' as 'idle',
  report: null,
  error: null,
  isScanning: false,
  isMerging: false,
  startScan: vi.fn(),
  cancel: vi.fn(),
  mergeSelected: vi.fn(),
  reset: vi.fn(),
}))

vi.mock('@/hooks/use-novel-similarity-scan', () => ({ useNovelSimilarityScan: () => similarityScan }))

vi.mock('@/hooks/use-shortcut', () => ({ useShortcut: vi.fn() }))
vi.mock('@/hooks/use-novel-workspace-shortcuts', () => ({ useNovelWorkspaceShortcuts: vi.fn() }))

// ── mock：重型子组件（本测试只关心右栏创作面板与命令分发逻辑）──

vi.mock('@/components/novel/novel-sidebar', () => ({ NovelSidebar: () => null }))
vi.mock('@/components/novel/novel-toolbar', () => ({ NovelToolbar: () => null }))
vi.mock('@/components/novel/novel-canvas', () => ({ NovelCanvas: () => null }))
vi.mock('@/components/novel/novel-detail-panel', () => ({ NovelDetailPanel: () => null }))
vi.mock('@/components/novel/chat-panel', () => ({ ChatPanel: () => null }))
vi.mock('@/components/novel/settings-panel', () => ({ SettingsPanel: () => null }))
vi.mock('@/components/novel/consistency-audit-panel', () => ({ ConsistencyAuditPanel: () => null }))
vi.mock('@/components/novel/similarity-scan-panel', () => ({ SimilarityScanPanel: () => null }))
vi.mock('@/components/novel/cache-monitor-panel', () => ({ CacheMonitorPanel: () => null }))
vi.mock('@/components/novel/observability-timeline', () => ({ ObservabilityTimeline: () => null }))
vi.mock('@/components/novel/p3-context-report-panel', () => ({ P3ContextReportPanel: () => null }))
vi.mock('@/components/novel/agent-log-panel', () => ({ AgentLogPanel: () => null }))
vi.mock('@/components/novel/matrix/matrix-workspace', () => ({ MatrixWorkspace: () => null }))
vi.mock('@/components/novel/chapter-content-editor', () => ({ ChapterContentEditor: () => null }))
vi.mock('@/components/novel/writing-style-profile-editor', () => ({ WritingStyleProfileEditor: () => null }))
vi.mock('@/components/novel/reference-analysis/reference-analysis-workspace', () => ({ ReferenceAnalysisWorkspace: () => null }))

// ── fixtures 与辅助 ──

const PROJECT: NovelProject = {
  id: 'p1',
  title: '命令测试项目',
  genre: '玄幻',
  synopsis: '',
  targetWords: 3000,
  currentVolume: 1,
  currentChapter: 1,
  currentStage: 'setup',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
}

function makeChapter(chapterNumber: number): NovelChapter {
  return {
    id: `ch-${chapterNumber}`,
    projectId: PROJECT.id,
    volume: 1,
    chapterNumber,
    title: `第${chapterNumber}章`,
    content: '',
    wordCount: 0,
    status: 'drafting',
    narrativeTask: '',
    acceptanceResult: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

const DEFAULT_NARRATIVE_TASK = {
  narrativeTask: {
    description: '推进主线剧情',
    type: 'advance_mainline',
    priority: 'medium',
  },
}

const EMPTY_ARRANGED = {
  characterIds: [] as string[],
  conflictIds: [] as string[],
  foreshadowIds: [] as string[],
  clueIds: [] as string[],
  factionIds: [] as string[],
  locationIds: [] as string[],
  itemIds: [] as string[],
}

function primeApi() {
  for (const fn of [
    api.listCharacters, api.listConflicts, api.listForeshadowing, api.listRelationships,
    api.listClues, api.listWorldRules, api.listStyleGuides, api.listConstraints,
    api.listInfoLayers, api.listFactions, api.listLocations, api.listWorldElements,
    api.listItems, api.listNarratives, api.listEdges, api.listVolumes,
  ]) {
    fn.mockResolvedValue([])
  }
  api.listChapters.mockResolvedValue([])
  api.listProjectCharacterHistory.mockResolvedValue([])
  api.getChapterArrangedEntities.mockResolvedValue({
    projectId: PROJECT.id,
    chapterNumber: 0,
    source: 'entity-fields',
    arrangedEntities: EMPTY_ARRANGED,
    alternativeSource: 'ledger',
    alternative: EMPTY_ARRANGED,
    divergence: {},
  })
  api.createChapter.mockImplementation(
    async (_projectId: string, input: { chapterNumber: number }) => makeChapter(input.chapterNumber),
  )
  api.completeChapter.mockResolvedValue(makeChapter(1))
  api.getTimelineRebuildPreview.mockResolvedValue(null)
  api.getTimelineRebuildJob.mockResolvedValue(null)
  api.startTimelineRebuild.mockResolvedValue(null)
}

function resetStores() {
  useNovelDataStore.setState({
    currentProjectId: PROJECT.id,
    projects: [PROJECT],
    characters: [],
    chapters: [],
    conflicts: [],
    foreshadows: [],
    relationships: [],
    clues: [],
    worldRules: [],
    styleGuides: [],
    constraints: [],
    infoLayers: [],
    factions: [],
    locations: [],
    worldElements: [],
    items: [],
    characterHistory: [],
  })
  useNovelWorkspaceLayoutStore.setState({
    layoutMode: 'text-timeline',
    sidebarVisible: true,
    rightPanelVisible: 'open',
    rightPanelView: 'conversation',
    focusMode: false,
  })
  useNovelUiStore.setState({ playheadChapter: 1, creationMode: null })
}

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <NovelWorkspace onClose={vi.fn()} />
    </QueryClientProvider>,
  )
  return {
    view,
    rerender: () => {
      view.rerender(
        <QueryClientProvider client={client}>
          <NovelWorkspace onClose={vi.fn()} />
        </QueryClientProvider>,
      )
    },
  }
}

/** 在真实 ConversationInput 中输入命令并按 Enter（经 handleSend → handleStartFlowCommand） */
function submitCommand(command: string) {
  const input = screen.getByLabelText('消息输入') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: command } })
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
}

beforeEach(() => {
  primeApi()
  resetStores()
  flow.phase = 'idle'
  flow.isRunning = false
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ── ensureChapterExists 直测 ──

describe('ensureChapterExists（建章辅助，模块级直测）', () => {
  it('建章成功：createChapter 携带默认叙事任务字面量，写入 store 并失效项目数据缓存', async () => {
    api.createChapter.mockResolvedValue(makeChapter(5))
    const upsertChapter = vi.fn()
    const invalidateQueries = vi.fn()

    const ok = await ensureChapterExists(PROJECT.id, 5, {
      upsertChapter,
      queryClient: { invalidateQueries } as unknown as QueryClient,
    })

    expect(ok).toBe(true)
    expect(api.createChapter).toHaveBeenCalledWith(PROJECT.id, {
      chapterNumber: 5,
      ...DEFAULT_NARRATIVE_TASK,
    })
    expect(upsertChapter).toHaveBeenCalledWith(makeChapter(5))
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['novel-project-data', PROJECT.id] })
  })

  it('建章失败（网络错误/后端冲突）：返回 false 且不写本地 store', async () => {
    api.createChapter.mockRejectedValue(new Error('chapter already exists'))
    const upsertChapter = vi.fn()

    const ok = await ensureChapterExists(PROJECT.id, 5, {
      upsertChapter,
      queryClient: { invalidateQueries: vi.fn() } as unknown as QueryClient,
    })

    expect(ok).toBe(false)
    expect(upsertChapter).not.toHaveBeenCalled()
  })
})

// ── /写 N、/重写 N 命令的 workspace 分发 ──

describe('NovelWorkspace 输入框命令启动（真实面板输入 → workspace 分发）', () => {
  it('调用诊断使用单一入口打开，并可在日志、缓存、趋势页签间切换', async () => {
    renderWorkspace()

    const diagnosticsButton = screen.getByRole('button', {
      name: '调用诊断（日志 / 缓存 / 趋势）',
    })
    fireEvent.click(diagnosticsButton)

    expect(screen.getByRole('dialog').textContent).toContain('调用诊断')
    const diagnosticsTabList = screen.getByRole('tablist', { name: '调用诊断视图' })
    expect(diagnosticsTabList.parentElement?.className).toContain('flex-col')
    expect(diagnosticsTabList.className).toContain('flex')
    expect(screen.getByRole('tab', { name: '调用日志' }).getAttribute('aria-selected')).toBe('true')

    const cacheTab = screen.getByRole('tab', { name: '缓存诊断' })
    const trendTab = screen.getByRole('tab', { name: '调用趋势' })
    // 新增追踪时间线标签页
    expect(screen.getByRole('tab', { name: '追踪时间线' })).toBeDefined()
    fireEvent.mouseDown(cacheTab, { button: 0, ctrlKey: false })
    await waitFor(() => expect(cacheTab.getAttribute('aria-selected')).toBe('true'))
    fireEvent.mouseDown(trendTab, { button: 0, ctrlKey: false })
    await waitFor(() => expect(trendTab.getAttribute('aria-selected')).toBe('true'))
  })

  it('/写 N 章节不存在：ensureChapterExists 先建空章节，再启动第 N 章工作流', async () => {
    renderWorkspace()

    submitCommand('/写 5')

    await waitFor(() => {
      expect(api.createChapter).toHaveBeenCalledWith(PROJECT.id, {
        chapterNumber: 5,
        ...DEFAULT_NARRATIVE_TASK,
      })
    })
    // 建章成功后按命令章节号启动（不是 playhead 章节）
    await waitFor(() => {
      expect(flow.startCreation).toHaveBeenCalledWith(
        PROJECT.id,
        5,
        expect.objectContaining({ arrangedEntities: expect.objectContaining({ characterIds: [] }) }),
      )
    })
    // 成功 toast 在建章成功后弹出（修复 4：不先弹「已启动」）
    expect(toasts.toastSuccess).toHaveBeenCalledWith('已启动第 5 章创作', expect.any(String))
    expect(toasts.toastError).not.toHaveBeenCalled()
  })

  it('/重写 N 章节不存在：toastError 提示且不建章、不启动', () => {
    renderWorkspace()

    submitCommand('/重写 3')

    expect(toasts.toastError).toHaveBeenCalledWith('第 3 章不存在', '只能重写已有章节；新章节请用 /写 N')
    expect(api.createChapter).not.toHaveBeenCalled()
    expect(flow.startCreation).not.toHaveBeenCalled()
    expect(toasts.toastSuccess).not.toHaveBeenCalled()
  })

  it('首条命令建章请求挂起期间，第二条命令被互斥锁拦截：不重复建章、不并发启动', async () => {
    let resolveCreate!: (chapter: NovelChapter) => void
    api.createChapter.mockReturnValue(
      new Promise<NovelChapter>((resolve) => {
        resolveCreate = resolve
      }),
    )

    renderWorkspace()
    submitCommand('/写 5')
    submitCommand('/写 6')

    // 第一条已发起建章（chapterNumber=5）；第二条被 startCreationLockRef（ref 级互斥锁）拦截
    expect(api.createChapter).toHaveBeenCalledTimes(1)
    expect(api.createChapter).toHaveBeenCalledWith(
      PROJECT.id,
      expect.objectContaining({ chapterNumber: 5 }),
    )

    // 放行第一条：仅第 5 章进入启动链路
    resolveCreate(makeChapter(5))
    await waitFor(() => expect(flow.startCreation).toHaveBeenCalledTimes(1))
    expect(flow.startCreation).toHaveBeenCalledWith(PROJECT.id, 5, expect.anything())
  })

  it('流程运行中（creationFlow.isRunning）命令被拦截：不建章、不启动', () => {
    const { rerender } = renderWorkspace()
    flow.isRunning = true
    rerender()

    submitCommand('/写 5')

    expect(api.createChapter).not.toHaveBeenCalled()
    expect(flow.startCreation).not.toHaveBeenCalled()
    expect(toasts.toastSuccess).not.toHaveBeenCalled()
  })
})
