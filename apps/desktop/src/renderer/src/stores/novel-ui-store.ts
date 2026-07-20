import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { NovelEdgeType } from '@/api/novel-client'

// ── 节点类型 ──

export type NovelNodeType =
  | 'project'
  | 'character'
  | 'chapter'
  | 'volume'
  | 'conflict'
  | 'clue'
  | 'foreshadow'
  | 'group'
  | 'faction'
  | 'location'
  | 'world_element'
  | 'info_layer'
  | 'item'

// ── Store 状态 ──

export interface NovelUiState {
  // ── 选中节点 ──
  selectedNodeId: string | null
  selectedNodeType: NovelNodeType | null

  // ── 视图模式（矩阵/画布）──
  viewMode: 'matrix' | 'canvas'

  // ── 画布布局模式 ──
  // grouped：按实体类型分区（角色左、势力右、伏笔/地点/世界要素横向）
  // force：d3-force 力导向布局，相关节点自然聚类（已保存位置的节点锁定不动）
  canvasLayoutMode: 'grouped' | 'force'

  // ── 画布连线关系类型（工具栏选择，画布 onConnect 读取）──
  canvasEdgeType: NovelEdgeType

  // ── 播放头所在章节（跨组件同步，不持久化，每次进项目从 1 开始）──
  playheadChapter: number

  // ── 当前创作模式（手动编排 / AI编排，不持久化）──
  creationMode: 'manual' | 'ai-arrange' | null

  // ── 矩阵视图折叠分组（与 NovelSidebar 共享）──
  // 用 string[] 而非 MatrixEntityKind[] 是因为 NovelSidebar 还有一个 'chapter' 分组
  collapsedGroups: string[]

  // ── 大纲树卷折叠状态（OutlineTree 共享，存已展开的 volumeId）──
  expandedVolumes: string[]

  // ── 矩阵视图滚动信号（NovelSidebar 点章节 → MatrixView 滚动到该列）──
  // ts 用于触发 effect 即使 chapter 相同；不持久化
  matrixScrollTarget: { chapter: number; ts: number } | null

  // ── 画布高亮（用于"高亮邻居"和"查找路径"交互）──
  // 高亮的节点 ID 集合（带样式前缀的 xyflow node id，如 "character:c-1"）
  highlightedNodeIds: string[]
  // 高亮的边 ID 集合（xyflow edge id）
  highlightedEdgeIds: string[]
  // 路径查找的起点节点 id（选中第一个节点后保存，选中第二个节点时触发查找）
  pathFindSourceId: string | null

  // ── 加载状态 ──
  loading: boolean
  error: string | null

  // ── Actions ──
  setViewMode: (mode: 'matrix' | 'canvas') => void
  setCanvasLayoutMode: (mode: 'grouped' | 'force') => void
  setCanvasEdgeType: (edgeType: NovelEdgeType) => void
  setPlayheadChapter: (chapter: number) => void
  setCreationMode: (mode: 'manual' | 'ai-arrange' | null) => void
  toggleCollapsedGroup: (kind: string) => void
  toggleExpandedVolume: (id: string) => void
  setMatrixScrollTarget: (target: { chapter: number; ts: number } | null) => void
  /** 设置画布高亮（节点和边） */
  setHighlight: (nodeIds: string[], edgeIds: string[]) => void
  /** 清除画布高亮 */
  clearHighlight: () => void
  /** 设置路径查找起点（传 null 清除） */
  setPathFindSource: (id: string | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  selectNode: (id: string | null, type: NovelNodeType | null) => void
  clearSelection: () => void
  /** 项目切换/删除时统一清理项目相关的 UI 状态 */
  resetForProjectSwitch: () => void
}

// ── Store ──

export const useNovelUiStore = create<NovelUiState>()(
  persist(
    (set, get): NovelUiState => ({
      // ── 初始状态 ──
      selectedNodeId: null,
      selectedNodeType: null,

      viewMode: 'matrix',

      canvasLayoutMode: 'grouped',

      canvasEdgeType: 'rivalry',

      playheadChapter: 1,

      creationMode: null,

      collapsedGroups: [],

      expandedVolumes: [],

      matrixScrollTarget: null,

      highlightedNodeIds: [],
      highlightedEdgeIds: [],
      pathFindSourceId: null,

      loading: false,
      error: null,

      // ── Actions ──
      setViewMode: (mode) => set({ viewMode: mode }),
      setCanvasLayoutMode: (mode) => set({ canvasLayoutMode: mode }),
      setCanvasEdgeType: (edgeType) => set({ canvasEdgeType: edgeType }),
      setPlayheadChapter: (chapter) => set({ playheadChapter: chapter }),
      setCreationMode: (mode) => set({ creationMode: mode }),

      toggleCollapsedGroup: (kind: string) =>
        set((state) => {
          const has = state.collapsedGroups.includes(kind)
          return {
            collapsedGroups: has
              ? state.collapsedGroups.filter((k) => k !== kind)
              : [...state.collapsedGroups, kind],
          }
        }),
      toggleExpandedVolume: (id) =>
        set((state) => {
          const exists = state.expandedVolumes.includes(id)
          return {
            expandedVolumes: exists
              ? state.expandedVolumes.filter((v) => v !== id)
              : [...state.expandedVolumes, id],
          }
        }),
      setMatrixScrollTarget: (target) => set({ matrixScrollTarget: target }),
      setHighlight: (nodeIds, edgeIds) =>
        set({ highlightedNodeIds: nodeIds, highlightedEdgeIds: edgeIds }),
      clearHighlight: () =>
        set({ highlightedNodeIds: [], highlightedEdgeIds: [] }),
      setPathFindSource: (id) => set({ pathFindSourceId: id }),

      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),

      selectNode: (id, type) => set({ selectedNodeId: id, selectedNodeType: type }),
      clearSelection: () => set({ selectedNodeId: null, selectedNodeType: null }),
      /** 项目切换/删除时统一清理项目相关的 UI 状态 */
      resetForProjectSwitch: () => {
        set({
          collapsedGroups: [],
          expandedVolumes: [],
          matrixScrollTarget: null,
          highlightedNodeIds: [],
          highlightedEdgeIds: [],
          pathFindSourceId: null,
        })
        get().clearSelection()
        get().setPlayheadChapter(1)
      },
    }),
    {
      name: 'wenlang-agent-novel-ui',
      storage: createJSONStorage(() => localStorage),
      // 只持久化需要跨会话保留的 UI 字段：视图模式、画布连线类型、折叠分组、卷展开状态
      partialize: (state) => ({
        viewMode: state.viewMode,
        canvasLayoutMode: state.canvasLayoutMode,
        canvasEdgeType: state.canvasEdgeType,
        collapsedGroups: state.collapsedGroups,
        expandedVolumes: state.expandedVolumes,
      }),
      // 自定义 merge：旧版本 localStorage 没有 canvasLayoutMode 字段时填回默认值 'grouped'
      // 避免从旧数据反序列化出 undefined 导致按钮 variant 判断失效
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<NovelUiState>
        return {
          ...current,
          ...p,
          canvasLayoutMode: p.canvasLayoutMode ?? 'grouped',
        }
      },
    },
  ),
)
