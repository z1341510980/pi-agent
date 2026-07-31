/**
 * 创作进行中的时效提示
 *
 * 背景：详情 / 审计 Tab 曾在创作流程运行时被设为 disabled，而写作者最需要核对
 * 「这个角色的秘密是什么 / 这条伏笔埋在哪」的时刻，恰恰就是 Agent 正在写这一章的时刻。
 * 现在两个面板在创作中照常可用，改为用一条提示说明「看到的数据有多新」：
 *   - 详情面板：本章上下文在流程开始时已构建并跨 Agent 缓存复用，此刻改实体要下一次创作才生效
 *   - 审计面板：报告基于已入库章节计算，不含正在生成的这一章
 *
 * 这两条提示是该设计的可见契约，故单独覆盖。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { dataStore, uiStore, auditReport } = vi.hoisted(() => ({
  dataStore: {
    currentProjectId: 'project-1',
    projects: [],
    characters: [
      {
        id: 'character-1',
        projectId: 'project-1',
        name: '林越',
      },
    ],
    chapters: [],
    volumes: [],
    conflicts: [],
    clues: [],
    foreshadows: [],
    factions: [],
    locations: [],
    worldElements: [],
    infoLayers: [],
    items: [],
  },
  uiStore: {
    selectedNodeId: 'character-1',
    selectedNodeType: 'character',
    clearSelection: vi.fn(),
  },
  auditReport: {
    projectId: 'project-1',
    generatedAt: 0,
    totalChapters: 3,
    writtenChapters: 2,
    healthScore: 88,
    summary: [],
    foreshadow: {
      total: 0,
      byStatus: {},
      recoveryRate: 1,
      urgent: [],
      expired: [],
    },
    hooks: { total: 0, fulfilledRate: 1, hanging: [] },
    orphanEntities: { characters: [], factions: [], locations: [] },
    timeline: { monotonic: true, violations: [] },
  },
}))

vi.mock('@/stores/novel-data-store', () => ({
  useNovelDataStore: (selector: (state: typeof dataStore) => unknown) => selector(dataStore),
}))

vi.mock('@/stores/novel-ui-store', () => ({
  useNovelUiStore: (selector: (state: typeof uiStore) => unknown) => selector(uiStore),
}))

// 详情面板会静态导入全部 11 个实体表单；只有被选中类型的表单会渲染，
// 其余仅为拉起模块图。全部替换为轻量占位，避免把 api / toast 依赖带进来。
vi.mock('../detail-forms/shared', () => ({
  entityTitle: () => '林越',
  NODE_TYPE_LABELS: { character: '角色' },
}))
vi.mock('../detail-forms/project-form', () => ({ ProjectForm: () => null }))
vi.mock('../detail-forms/character-form', () => ({
  CharacterForm: () => <div data-testid="character-form" />,
}))
vi.mock('../detail-forms/chapter-form', () => ({
  ChapterForm: () => null,
  VolumeForm: () => null,
}))
vi.mock('../detail-forms/conflict-form', () => ({ ConflictForm: () => null }))
vi.mock('../detail-forms/clue-form', () => ({ ClueForm: () => null }))
vi.mock('../detail-forms/foreshadow-form', () => ({ ForeshadowForm: () => null }))
vi.mock('../detail-forms/info-layer-form', () => ({ InfoLayerForm: () => null }))
vi.mock('../detail-forms/faction-form', () => ({ FactionForm: () => null }))
vi.mock('../detail-forms/location-form', () => ({ LocationForm: () => null }))
vi.mock('../detail-forms/world-element-form', () => ({ WorldElementForm: () => null }))
vi.mock('../detail-forms/item-form', () => ({ ItemForm: () => null }))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: auditReport,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/api/novel-client', () => ({
  getConsistencyReport: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const DETAIL_NOTICE = /创作进行中。本章上下文已在流程开始时构建/
const AUDIT_NOTICE = /创作进行中。报告基于已入库章节计算/

describe('NovelDetailPanel 创作中时效提示', () => {
  it('创作进行中时提示改动要到下一次创作才生效，且表单仍可用', async () => {
    const { NovelDetailPanel } = await import('../novel-detail-panel')

    render(<NovelDetailPanel creationActive />)

    expect(screen.getByText(DETAIL_NOTICE)).not.toBeNull()
    // 关键：提示不等于禁用，面板照常渲染表单
    expect(screen.getByTestId('character-form')).not.toBeNull()
  })

  it('未创作时不显示提示', async () => {
    const { NovelDetailPanel } = await import('../novel-detail-panel')

    render(<NovelDetailPanel />)

    expect(screen.queryByText(DETAIL_NOTICE)).toBeNull()
    expect(screen.getByTestId('character-form')).not.toBeNull()
  })
})

describe('ConsistencyAuditPanel 创作中时效提示', () => {
  it('创作进行中时提示报告尚不含本章', async () => {
    const { ConsistencyAuditPanel } = await import('../consistency-audit-panel')

    render(<ConsistencyAuditPanel creationActive />)

    expect(screen.getByText(AUDIT_NOTICE)).not.toBeNull()
  })

  it('未创作时不显示提示', async () => {
    const { ConsistencyAuditPanel } = await import('../consistency-audit-panel')

    render(<ConsistencyAuditPanel />)

    expect(screen.queryByText(AUDIT_NOTICE)).toBeNull()
  })
})
