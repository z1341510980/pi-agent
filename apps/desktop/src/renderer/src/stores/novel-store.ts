import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { temporal } from 'zundo'
import type {
  NovelProject,
  NovelCharacter,
  NovelChapter,
  NovelConflict,
  NovelForeshadow,
  NovelRelationship,
  NovelClue,
  NovelWorldRule,
  NovelStyleGuide,
  NovelConstraint,
  NovelInformationLayer,
  NovelNodePosition,
  NovelNodeTypeName,
  NovelCharacterHistory,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
  NovelEdge,
  NovelEdgeType,
  NovelMarker,
  NovelVolume,
} from '@/api/novel-client'

// ── 节点类型 ──

export type NovelNodeType =
  | 'project'
  | 'character'
  | 'chapter'
  | 'volume'
  | 'conflict'
  | 'foreshadow'
  | 'group'
  | 'faction'
  | 'location'
  | 'world_element'

// ── Store 状态 ──

export interface NovelState {
  // ── 数据 ──
  currentProjectId: string | null
  projects: NovelProject[]
  characters: NovelCharacter[]
  chapters: NovelChapter[]
  volumes: NovelVolume[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  relationships: NovelRelationship[]
  clues: NovelClue[]
  worldRules: NovelWorldRule[]
  styleGuides: NovelStyleGuide[]
  constraints: NovelConstraint[]
  infoLayers: NovelInformationLayer[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  worldElements: NovelWorldElement[]
  nodePositions: NovelNodePosition[]
  characterHistory: NovelCharacterHistory[]
  edges: NovelEdge[]
  markers: NovelMarker[]

  // ── 选中节点 ──
  selectedNodeId: string | null
  selectedNodeType: NovelNodeType | null

  // ── 视图模式（矩阵/画布）──
  viewMode: 'matrix' | 'canvas'

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

  // ── 加载状态 ──
  loading: boolean
  error: string | null

  // ── Actions ──
  setViewMode: (mode: 'matrix' | 'canvas') => void
  setCanvasEdgeType: (edgeType: NovelEdgeType) => void
  setPlayheadChapter: (chapter: number) => void
  setCreationMode: (mode: 'manual' | 'ai-arrange' | null) => void
  setCurrentProject: (projectId: string | null) => void
  toggleCollapsedGroup: (kind: string) => void
  toggleExpandedVolume: (id: string) => void
  setMatrixScrollTarget: (target: { chapter: number; ts: number } | null) => void
  setProjects: (projects: NovelProject[]) => void
  loadProjectData: (data: {
    characters?: NovelCharacter[]
    chapters?: NovelChapter[]
    volumes?: NovelVolume[]
    conflicts?: NovelConflict[]
    foreshadows?: NovelForeshadow[]
    relationships?: NovelRelationship[]
    clues?: NovelClue[]
    worldRules?: NovelWorldRule[]
    styleGuides?: NovelStyleGuide[]
    constraints?: NovelConstraint[]
    infoLayers?: NovelInformationLayer[]
    factions?: NovelFaction[]
    locations?: NovelLocation[]
    worldElements?: NovelWorldElement[]
    edges?: NovelEdge[]
    markers?: NovelMarker[]
  }) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  selectNode: (id: string | null, type: NovelNodeType | null) => void
  clearSelection: () => void
  clearProjectData: () => void

  // ── 实体 upsert ──
  upsertProject: (project: NovelProject) => void
  upsertCharacter: (character: NovelCharacter) => void
  upsertChapter: (chapter: NovelChapter) => void
  upsertVolume: (volume: NovelVolume) => void
  upsertConflict: (conflict: NovelConflict) => void
  upsertForeshadow: (foreshadow: NovelForeshadow) => void
  upsertRelationship: (relationship: NovelRelationship) => void
  upsertClue: (clue: NovelClue) => void
  upsertWorldRule: (rule: NovelWorldRule) => void
  upsertStyleGuide: (guide: NovelStyleGuide) => void
  upsertConstraint: (constraint: NovelConstraint) => void
  upsertInfoLayer: (layer: NovelInformationLayer) => void
  upsertFaction: (faction: NovelFaction) => void
  upsertLocation: (location: NovelLocation) => void
  upsertWorldElement: (element: NovelWorldElement) => void

  // ── 实体删除 ──
  removeProject: (id: string) => void
  removeCharacter: (id: string) => void
  removeChapter: (id: string) => void
  removeConflict: (id: string) => void
  removeForeshadow: (id: string) => void
  removeFaction: (id: string) => void
  removeLocation: (id: string) => void
  removeWorldElement: (id: string) => void

  // ── 节点位置 ──
  setNodePositions: (positions: NovelNodePosition[]) => void
  upsertNodePosition: (pos: NovelNodePosition) => void
  removeNodePosition: (nodeType: NovelNodeTypeName, entityId: string) => void
  clearNodePositions: () => void

  // ── 角色历史 ──
  setCharacterHistory: (history: NovelCharacterHistory[]) => void
  addCharacterHistory: (entry: NovelCharacterHistory) => void
  removeCharacterHistory: (id: string) => void

  // ── 画布连线 ──
  setEdges: (edges: NovelEdge[]) => void
  addEdge: (edge: NovelEdge) => void
  removeEdge: (id: string) => void

  // ── 时间轴标记 ──
  setMarkers: (markers: NovelMarker[]) => void
  upsertMarker: (marker: NovelMarker) => void
  removeMarker: (id: string) => void

  // ── Undo/Redo ──
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  clearHistory: () => void

  // ── 派生字段（由 temporal store 订阅同步，用于 React 订阅触发重渲染）──
  undoCount: number
  redoCount: number
}

// ── 通用 upsert 工具 ──

function upsertInList<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx >= 0) {
    const next = [...list]
    next[idx] = item
    return next
  }
  return [...list, item]
}

function removeFromList<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((x) => x.id !== id)
}

// ── Store ──

export const useNovelStore = create<NovelState>()(
  temporal(
    persist(
      (set, get): NovelState => ({
        // ── 初始状态 ──
        currentProjectId: null,
        projects: [],
        characters: [],
        chapters: [],
        volumes: [],
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
        nodePositions: [],
        characterHistory: [],
        edges: [],
        markers: [],

        selectedNodeId: null,
        selectedNodeType: null,

        viewMode: 'matrix',

        canvasEdgeType: 'rivalry',

        playheadChapter: 1,

        creationMode: null,

        collapsedGroups: [],

        expandedVolumes: [],

        matrixScrollTarget: null,

        loading: false,
        error: null,

        // ── Actions ──
        setViewMode: (mode) => set({ viewMode: mode }),
        setCanvasEdgeType: (edgeType) => set({ canvasEdgeType: edgeType }),
        setPlayheadChapter: (chapter) => set({ playheadChapter: chapter }),
        setCreationMode: (mode) => set({ creationMode: mode }),
        setCurrentProject: (projectId) => {
          const prevId = get().currentProjectId
          set({ currentProjectId: projectId, selectedNodeId: null, selectedNodeType: null })
          // 项目切换时清理历史栈，避免跨项目 undo 导致数据污染
          if (prevId !== projectId) {
            useNovelStore.temporal.getState().clear()
          }
        },
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

        setProjects: (projects) => set({ projects }),

        loadProjectData: (data) =>
          set((state) => ({
            characters: data.characters ?? state.characters,
            chapters: data.chapters ?? state.chapters,
            volumes: data.volumes ?? state.volumes,
            conflicts: data.conflicts ?? state.conflicts,
            foreshadows: data.foreshadows ?? state.foreshadows,
            relationships: data.relationships ?? state.relationships,
            clues: data.clues ?? state.clues,
            worldRules: data.worldRules ?? state.worldRules,
            styleGuides: data.styleGuides ?? state.styleGuides,
            constraints: data.constraints ?? state.constraints,
            infoLayers: data.infoLayers ?? state.infoLayers,
            factions: data.factions ?? state.factions,
            locations: data.locations ?? state.locations,
            worldElements: data.worldElements ?? state.worldElements,
            edges: data.edges ?? state.edges,
            markers: data.markers ?? state.markers,
          })),

        setLoading: (loading) => set({ loading }),
        setError: (error) => set({ error }),

        selectNode: (id, type) => set({ selectedNodeId: id, selectedNodeType: type }),
        clearSelection: () => set({ selectedNodeId: null, selectedNodeType: null }),
        clearProjectData: () =>
          set({
            characters: [],
            chapters: [],
            volumes: [],
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
            nodePositions: [],
            characterHistory: [],
            edges: [],
            markers: [],
            selectedNodeId: null,
            selectedNodeType: null,
            playheadChapter: 1,
            collapsedGroups: [],
            expandedVolumes: [],
            matrixScrollTarget: null,
          }),

        // ── upsert ──
        upsertProject: (project) => set((state) => ({ projects: upsertInList(state.projects, project) })),
        upsertCharacter: (character) => set((state) => ({ characters: upsertInList(state.characters, character) })),
        upsertChapter: (chapter) => set((state) => ({ chapters: upsertInList(state.chapters, chapter) })),
        upsertVolume: (volume) => set((state) => ({ volumes: upsertInList(state.volumes, volume) })),
        upsertConflict: (conflict) => set((state) => ({ conflicts: upsertInList(state.conflicts, conflict) })),
        upsertForeshadow: (foreshadow) => set((state) => ({ foreshadows: upsertInList(state.foreshadows, foreshadow) })),
        upsertRelationship: (relationship) => set((state) => ({ relationships: upsertInList(state.relationships, relationship) })),
        upsertClue: (clue) => set((state) => ({ clues: upsertInList(state.clues, clue) })),
        upsertWorldRule: (rule) => set((state) => ({ worldRules: upsertInList(state.worldRules, rule) })),
        upsertStyleGuide: (guide) => set((state) => ({ styleGuides: upsertInList(state.styleGuides, guide) })),
        upsertConstraint: (constraint) => set((state) => ({ constraints: upsertInList(state.constraints, constraint) })),
        upsertInfoLayer: (layer) => set((state) => ({ infoLayers: upsertInList(state.infoLayers, layer) })),
        upsertFaction: (faction) => set((state) => ({ factions: upsertInList(state.factions, faction) })),
        upsertLocation: (location) => set((state) => ({ locations: upsertInList(state.locations, location) })),
        upsertWorldElement: (element) => set((state) => ({ worldElements: upsertInList(state.worldElements, element) })),

        // ── remove ──
        removeProject: (id) =>
          set((state) => ({
            projects: removeFromList(state.projects, id),
            ...(state.currentProjectId === id
              ? {
                  currentProjectId: null,
                  characters: [],
                  chapters: [],
                  volumes: [],
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
                  nodePositions: [],
                  characterHistory: [],
                  edges: [],
                  markers: [],
                  selectedNodeId: null,
                  selectedNodeType: null,
                  expandedVolumes: [],
                }
              : {}),
          })),
        removeCharacter: (id) => set((state) => ({ characters: removeFromList(state.characters, id) })),
        removeChapter: (id) => set((state) => ({ chapters: removeFromList(state.chapters, id) })),
        removeConflict: (id) => set((state) => ({ conflicts: removeFromList(state.conflicts, id) })),
        removeForeshadow: (id) => set((state) => ({ foreshadows: removeFromList(state.foreshadows, id) })),
        removeFaction: (id) => set((state) => ({ factions: removeFromList(state.factions, id) })),
        removeLocation: (id) => set((state) => ({ locations: removeFromList(state.locations, id) })),
        removeWorldElement: (id) => set((state) => ({ worldElements: removeFromList(state.worldElements, id) })),

        // ── 节点位置 ──
        setNodePositions: (positions) => set({ nodePositions: positions }),
        upsertNodePosition: (pos) =>
          set((state) => ({ nodePositions: upsertInList(state.nodePositions, pos) })),
        removeNodePosition: (nodeType, entityId) =>
          set((state) => ({
            nodePositions: state.nodePositions.filter(
              (p) => !(p.nodeType === nodeType && p.entityId === entityId),
            ),
          })),
        clearNodePositions: () => set({ nodePositions: [] }),

        // ── 角色历史 ──
        setCharacterHistory: (history) => set({ characterHistory: history }),
        addCharacterHistory: (entry) =>
          set((state) => ({ characterHistory: [...state.characterHistory, entry] })),
        removeCharacterHistory: (id) =>
          set((state) => ({ characterHistory: state.characterHistory.filter((h) => h.id !== id) })),

        // ── 画布连线 ──
        setEdges: (edges) => set({ edges }),
        addEdge: (edge) => set((state) => ({ edges: upsertInList(state.edges, edge) })),
        removeEdge: (id) => set((state) => ({ edges: removeFromList(state.edges, id) })),

        // ── 时间轴标记 ──
        setMarkers: (markers) => set({ markers }),
        upsertMarker: (marker) => set((state) => ({ markers: upsertInList(state.markers, marker) })),
        removeMarker: (id) => set((state) => ({ markers: removeFromList(state.markers, id) })),

        // ── Undo/Redo ──
        undo: () => {
          useNovelStore.temporal.getState().undo()
        },
        redo: () => {
          useNovelStore.temporal.getState().redo()
        },
        canUndo: () => {
          const { pastStates } = useNovelStore.temporal.getState()
          return pastStates.length > 0
        },
        canRedo: () => {
          const { futureStates } = useNovelStore.temporal.getState()
          return futureStates.length > 0
        },
        clearHistory: () => {
          useNovelStore.temporal.getState().clear()
        },

        // ── 派生字段（由 temporal store 订阅同步）──
        undoCount: 0,
        redoCount: 0,
      }),
      {
        name: 'pi-agent-novel',
        storage: createJSONStorage(() => localStorage),
        // 只持久化数据字段，不持久化 actions 与瞬时状态
        partialize: (state) => ({
          currentProjectId: state.currentProjectId,
          projects: state.projects,
          characters: state.characters,
          chapters: state.chapters,
          volumes: state.volumes,
          conflicts: state.conflicts,
          foreshadows: state.foreshadows,
          relationships: state.relationships,
          clues: state.clues,
          worldRules: state.worldRules,
          styleGuides: state.styleGuides,
          constraints: state.constraints,
          infoLayers: state.infoLayers,
          factions: state.factions,
          locations: state.locations,
          worldElements: state.worldElements,
          nodePositions: state.nodePositions,
          characterHistory: state.characterHistory,
          edges: state.edges,
          markers: state.markers,
          selectedNodeId: state.selectedNodeId,
          selectedNodeType: state.selectedNodeType,
          viewMode: state.viewMode,
          canvasEdgeType: state.canvasEdgeType,
          collapsedGroups: state.collapsedGroups,
          expandedVolumes: state.expandedVolumes,
        }),
      },
    ),
    {
      // temporal 选项：仅追踪数据字段，UI 状态与 actions 不进入历史栈
      partialize: (state) => ({
        currentProjectId: state.currentProjectId,
        projects: state.projects,
        characters: state.characters,
        chapters: state.chapters,
        volumes: state.volumes,
        conflicts: state.conflicts,
        foreshadows: state.foreshadows,
        relationships: state.relationships,
        clues: state.clues,
        worldRules: state.worldRules,
        styleGuides: state.styleGuides,
        constraints: state.constraints,
        infoLayers: state.infoLayers,
        factions: state.factions,
        locations: state.locations,
        worldElements: state.worldElements,
        nodePositions: state.nodePositions,
        characterHistory: state.characterHistory,
        edges: state.edges,
        markers: state.markers,
      }),
      limit: 50, // 历史栈最多 50 步
      equality: (pastState, currentState) =>
        JSON.stringify(pastState) === JSON.stringify(currentState),
    },
  ),
)

// 同步 undoCount/redoCount 派生字段（订阅 temporal store 状态变化）
// temporal store 是独立 vanilla store，其 pastStates/futureStates 变化时
// 需同步到主 store 的 undoCount/redoCount 以触发 React 重渲染
useNovelStore.temporal.subscribe((state) => {
  useNovelStore.setState({
    undoCount: state.pastStates.length,
    redoCount: state.futureStates.length,
  })
})
