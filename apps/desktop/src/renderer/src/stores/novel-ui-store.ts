import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { NovelEdgeType } from '@/api/novel-client'
import type { ThinkingLevel } from './session-store'
import { readLegacyViewMode } from './novel-legacy-view-mode'

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
  | 'narrative'

/** 小说会话输入框最近一次选择的模型。 */
export interface NovelAgentModelRef {
  provider: string
  modelId: string
  thinkingLevel?: ThinkingLevel | null
}

/** 编辑器中的未落库正文草稿，按章节绑定，避免切换播放头后写错章节。 */
export interface NovelUnsavedChapterDraft {
  chapterId: string
  chapterNumber: number
  content: string
}

// ── Store 状态 ──

export interface NovelUiState {
  // ── 选中节点 ──
  selectedNodeId: string | null
  selectedNodeType: NovelNodeType | null

  // ── 画布布局模式 ──
  // grouped：按实体类型分区（角色左、势力右、伏笔/地点/世界要素横向）
  // force：d3-force 力导向布局，相关节点自然聚类（已保存位置的节点锁定不动）
  canvasLayoutMode: 'grouped' | 'force'

  // ── 画布连线关系类型（工具栏选择，画布 onConnect 读取）──
  canvasEdgeType: NovelEdgeType

  // ── 播放头所在章节（跨组件同步，不持久化，每次进项目从 1 开始）──
  playheadChapter: number

  /** 当前未保存草稿（不持久化；编辑器卸载后仍保留在本次工作台会话内）。 */
  unsavedChapterDraft: NovelUnsavedChapterDraft | null

  // ── 当前创作模式（手动编排 / AI编排，不持久化）──
  creationMode: 'manual' | 'ai-arrange' | null

  // ── 小说会话偏好（跨右栏 Tab / 应用重启保留）──
  selectedAgentModel: NovelAgentModelRef | null

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

  // ── 矩阵视图：多选实体（dhtmlx-gantt 风格，支持 Ctrl/Cmd 多选）──
  // 不持久化，每次进项目默认清空。单选时也同步更新 selectedNodeId 以联动右面板
  selectedMatrixEntityIds: string[]

  // ── 矩阵视图：展开的实体 ID 列表（子甘特图"复合片段"展开）──
  // 可同时展开多个，各自独立 toggle；不持久化
  expandedEntityIds: string[]

  // ── 矩阵视图：左侧 sticky 列收缩状态（持久化，收缩时仅留窄条展开按钮）──
  matrixSidebarCollapsed: boolean

  // ── 加载状态 ──
  loading: boolean
  error: string | null

  // ── Actions ──
  setCanvasLayoutMode: (mode: 'grouped' | 'force') => void
  setCanvasEdgeType: (edgeType: NovelEdgeType) => void
  /** 切换播放头；存在其他章节的未保存草稿时会先提示并可取消切换。 */
  setPlayheadChapter: (chapter: number, force?: boolean) => void
  setUnsavedChapterDraft: (draft: NovelUnsavedChapterDraft) => void
  clearUnsavedChapterDraft: (chapterId?: string) => void
  setCreationMode: (mode: 'manual' | 'ai-arrange' | null) => void
  setSelectedAgentModel: (model: NovelAgentModelRef | null) => void
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
  /** 矩阵多选实体（dhtmlx-gantt 风格）
   *  - 默认：单选，清空其他，同时同步 selectedNodeId 联动右面板
   *  - multi=true（Ctrl/Cmd）：toggle 当前 id，保留其他选中
   *  - type 用于同步推导 NovelNodeType，便于右面板和键盘操作复用 */
  selectMatrixEntity: (id: string, type: NovelNodeType, opts?: { multi?: boolean }) => void
  /** 清空矩阵多选 */
  clearMatrixSelection: () => void
  /** 子甘特图展开：toggle 某实体的展开状态（各自独立，可同时展开多个） */
  toggleEntityExpand: (entityId: string) => void
  /** 收起所有已展开的实体子轨道 */
  collapseAllExpanded: () => void
  /** 切换矩阵左侧 sticky 列的收缩状态 */
  toggleMatrixSidebar: () => void
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

      // ── 矩阵多选实体（不持久化）──
      selectedMatrixEntityIds: [],

      // ── 子甘特图展开的实体（不持久化）──
      expandedEntityIds: [],

      // ── 矩阵左侧 sticky 列收缩状态（持久化）──
      matrixSidebarCollapsed: false,

      canvasLayoutMode: 'grouped',

      canvasEdgeType: 'rivalry',

      playheadChapter: 1,

      unsavedChapterDraft: null,

      creationMode: null,

      selectedAgentModel: null,

      collapsedGroups: [],

      expandedVolumes: [],

      matrixScrollTarget: null,

      highlightedNodeIds: [],
      highlightedEdgeIds: [],
      pathFindSourceId: null,

      loading: false,
      error: null,

      // ── Actions ──
      setCanvasLayoutMode: (mode) => set({ canvasLayoutMode: mode }),
      setCanvasEdgeType: (edgeType) => set({ canvasEdgeType: edgeType }),
      setPlayheadChapter: (chapter, force = false) => {
        const current = get().playheadChapter
        if (chapter === current) return

        const draft = get().unsavedChapterDraft
        if (!force && draft && draft.chapterNumber !== chapter) {
          const discard = typeof window === 'undefined'
            ? false
            : window.confirm(
              `第 ${draft.chapterNumber} 章有未保存的修改。\n\n确定丢弃这些修改并切换章节吗？\n如果要保留，请先点击编辑器中的“保存”。`,
            )
          if (!discard) return
          set({ unsavedChapterDraft: null })
        }

        set({ playheadChapter: chapter })
      },
      setUnsavedChapterDraft: (draft) => set({ unsavedChapterDraft: draft }),
      clearUnsavedChapterDraft: (chapterId) => {
        const current = get().unsavedChapterDraft
        if (!current || (chapterId && current.chapterId !== chapterId)) return
        set({ unsavedChapterDraft: null })
      },
      setCreationMode: (mode) => set({ creationMode: mode }),
      setSelectedAgentModel: (model) => set({ selectedAgentModel: model }),

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
      clearSelection: () =>
        set({ selectedNodeId: null, selectedNodeType: null, selectedMatrixEntityIds: [] }),

      // ── 矩阵多选：dhtmlx-gantt 风格 ──
      // 单选时同步 selectedNodeId/Type，联动右面板和画布；多选时仅更新 selectedMatrixEntityIds
      selectMatrixEntity: (id, type, opts) => {
        const multi = opts?.multi ?? false
        const current = get().selectedMatrixEntityIds
        if (multi) {
          // Ctrl/Cmd 多选：toggle 当前 id
          const next = current.includes(id)
            ? current.filter((x) => x !== id)
            : [...current, id]
          set({ selectedMatrixEntityIds: next })
        } else {
          // 单选：清空其他，同步 selectedNodeId
          set({
            selectedMatrixEntityIds: [id],
            selectedNodeId: id,
            selectedNodeType: type,
          })
        }
      },
      clearMatrixSelection: () => set({ selectedMatrixEntityIds: [] }),

      // ── 子甘特图展开：各自独立 toggle ──
      toggleEntityExpand: (entityId) => {
        const current = get().expandedEntityIds
        const next = current.includes(entityId)
          ? current.filter((x) => x !== entityId)
          : [...current, entityId]
        set({ expandedEntityIds: next })
      },
      collapseAllExpanded: () => set({ expandedEntityIds: [] }),
      toggleMatrixSidebar: () =>
        set((state) => ({ matrixSidebarCollapsed: !state.matrixSidebarCollapsed })),
      /** 项目切换/删除时统一清理项目相关的 UI 状态 */
      resetForProjectSwitch: () => {
        set({
          collapsedGroups: [],
          expandedVolumes: [],
          matrixScrollTarget: null,
          highlightedNodeIds: [],
          highlightedEdgeIds: [],
          pathFindSourceId: null,
          unsavedChapterDraft: null,
        })
        get().clearSelection()
        get().setPlayheadChapter(1, true)
      },
    }),
    {
      name: 'wenlang-agent-novel-ui',
      storage: createJSONStorage(() => localStorage),
      // version 0 → 1：viewMode（矩阵/画布）已与 layout store 的 mainMode 合并为
      // 单一 layoutMode，迁到 novel-workspace-layout-store。这里只负责把废弃 key
      // 从 localStorage 里删掉 —— 否则 merge 的 `...p` 会把它重新灌回运行时 state。
      // 真正的取值换算在 layout store 的 v3 migrate 里（它需要读这里的旧值）。
      version: 1,
      migrate: (persisted, version) => {
        if (version >= 1 || persisted == null || typeof persisted !== 'object') return persisted
        const next = { ...(persisted as Record<string, unknown>) }
        // 必须在 delete 之前读一次：layout store 的 v3 migrate 要用这个旧值，
        // 而两个 store 的 rehydrate 顺序由模块导入顺序决定，不可依赖。
        readLegacyViewMode()
        delete next.viewMode
        return next
      },
      // 只持久化需要跨会话保留的 UI 字段：画布布局/连线类型、折叠分组、卷展开状态
      partialize: (state) => ({
        canvasLayoutMode: state.canvasLayoutMode,
        canvasEdgeType: state.canvasEdgeType,
        collapsedGroups: state.collapsedGroups,
        expandedVolumes: state.expandedVolumes,
        matrixSidebarCollapsed: state.matrixSidebarCollapsed,
        selectedAgentModel: state.selectedAgentModel,
      }),
      // 自定义 merge：旧版本 localStorage 没有 canvasLayoutMode 字段时填回默认值 'grouped'
      // 避免从旧数据反序列化出 undefined 导致按钮 variant 判断失效
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<NovelUiState>
        return {
          ...current,
          ...p,
          canvasLayoutMode: p.canvasLayoutMode ?? 'grouped',
          matrixSidebarCollapsed: p.matrixSidebarCollapsed ?? false,
          selectedAgentModel: p.selectedAgentModel ?? current.selectedAgentModel,
        }
      },
    },
  ),
)
