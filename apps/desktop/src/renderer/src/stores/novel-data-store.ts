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
  NovelItem,
  NovelEdge,
  NovelMarker,
  NovelVolume,
} from '@/api/novel-client'
import { useNovelUiStore } from './novel-ui-store'

// ── Store 状态 ──

export interface NovelDataState {
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
  items: NovelItem[]
  nodePositions: NovelNodePosition[]
  characterHistory: NovelCharacterHistory[]
  edges: NovelEdge[]
  markers: NovelMarker[]

  // ── Actions ──
  setCurrentProject: (projectId: string | null) => void
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
    items?: NovelItem[]
    edges?: NovelEdge[]
    markers?: NovelMarker[]
  }) => void
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
  upsertItem: (item: NovelItem) => void

  // ── 实体删除 ──
  removeProject: (id: string) => void
  removeCharacter: (id: string) => void
  removeChapter: (id: string) => void
  removeConflict: (id: string) => void
  removeClue: (id: string) => void
  removeForeshadow: (id: string) => void
  removeFaction: (id: string) => void
  removeLocation: (id: string) => void
  removeWorldElement: (id: string) => void
  removeItem: (id: string) => void
  removeInfoLayer: (id: string) => void

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

/**
 * 合并两个实体列表：以后端列表为权威数据源。
 *
 * 策略：
 *   - 后端返回了列表（remote 存在）→ 直接采用后端列表，丢弃本地所有条目。
 *     这样能自动清除本地残留的 phantom 实体（后端数据库中根本不存在的条目），
 *     避免前端把不存在的 foreshadow/character ID 传给后端导致 400 "编排实体不属于当前项目或不存在"。
 *     所有创建实体的路径都是先 `await createXxx()` 成功再 `upsertXxx()`，然后 `invalidateQueries`
 *     触发 refetch，refetch 返回的最新数据必然包含新建实体，因此不存在"新建未同步"丢失风险。
 *   - 后端未返回该类型（remote 为 undefined）→ 仅保留属于当前项目的本地条目，
 *     过滤掉切换项目后 persist hydrate 恢复的上一个项目残留。
 *
 * @param currentProjectId 当前项目 ID，仅用于 remote 为 undefined 时过滤本地残留。
 */
function mergeListById<T extends { id: string; projectId?: string }>(
  local: T[],
  remote: T[] | undefined,
  currentProjectId?: string,
): T[] {
  if (!remote) {
    return currentProjectId
      ? local.filter((x) => x.projectId === currentProjectId)
      : local
  }
  // 后端是权威数据源，直接采用后端列表，丢弃本地所有条目（含 phantom 实体）
  return remote
}

// 清空所有实体数组的公共部分（不含 currentProjectId）
function emptyEntities() {
  return {
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
    items: [],
    edges: [],
    characterHistory: [],
    nodePositions: [],
    markers: [],
  }
}

// ── Store ──

// flag：persist hydrate 完成后置 true，store 创建后据此清除 temporal 伪快照
let needsClearTemporal = false

export const useNovelDataStore = create<NovelDataState>()(
  temporal(
    persist(
      (set, get): NovelDataState => ({
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
        items: [],
        nodePositions: [],
        characterHistory: [],
        edges: [],
        markers: [],

        // ── Actions ──
        setCurrentProject: (projectId) => {
          const prevId = get().currentProjectId
          // 项目切换时清空所有实体数组，防止上一个项目的实体残留混入新项目。
          // 根因：loadProjectData 用 mergeListById 合并（保留本地新建未同步条目），
          // 不清空会导致切换项目后旧项目的 foreshadow/character 等残留，
          // 前端过滤 arrangedEntities 时会把不属于当前项目的实体传给后端导致 400。
          // persist 的 localStorage 也会跨会话携带残留，必须在此清空。
          if (prevId !== projectId) {
            // 项目切换时统一清理 UI store 的项目相关状态
            useNovelUiStore.getState().resetForProjectSwitch()
            set({
              ...emptyEntities(),
              currentProjectId: projectId,
            })
            // 清空实体本身会被 zundo 记录为一次可撤销操作，因此必须在 set 之后
            // 再清历史，避免 undo 把上一个项目的数据带回当前项目。
            useNovelDataStore.temporal.getState().clear()
            return
          }
          set({ currentProjectId: projectId })
        },

        setProjects: (projects) => set({ projects }),

        loadProjectData: (data) =>
          set((state) => {
            const pid = state.currentProjectId ?? undefined
            // 合并语义：以后端数据为权威源直接采用，自动清除本地 phantom 实体
            // （后端数据库中根本不存在的条目），避免前端把不存在的 ID 传给后端导致 400。
            // 创建实体的路径都是先 await 后端成功再 upsert 本地 + invalidateQueries 触发 refetch，
            // refetch 返回的最新数据必然包含新建实体，因此不存在"新建未同步"丢失风险。
            // 传入 currentProjectId 仅用于后端未返回某类型时过滤本地残留（跨项目污染防御）。
            return {
              characters: mergeListById(state.characters, data.characters, pid),
              chapters: mergeListById(state.chapters, data.chapters, pid),
              volumes: mergeListById(state.volumes, data.volumes, pid),
              conflicts: mergeListById(state.conflicts, data.conflicts, pid),
              foreshadows: mergeListById(state.foreshadows, data.foreshadows, pid),
              relationships: mergeListById(state.relationships, data.relationships, pid),
              clues: mergeListById(state.clues, data.clues, pid),
              worldRules: mergeListById(state.worldRules, data.worldRules, pid),
              styleGuides: mergeListById(state.styleGuides, data.styleGuides, pid),
              constraints: mergeListById(state.constraints, data.constraints, pid),
              infoLayers: mergeListById(state.infoLayers, data.infoLayers, pid),
              factions: mergeListById(state.factions, data.factions, pid),
              locations: mergeListById(state.locations, data.locations, pid),
              worldElements: mergeListById(state.worldElements, data.worldElements, pid),
              items: mergeListById(state.items, data.items, pid),
              edges: data.edges ?? state.edges,
              markers: data.markers ?? state.markers,
            }
          }),

        clearProjectData: () => {
          // 统一清理 UI store 的项目相关状态
          useNovelUiStore.getState().resetForProjectSwitch()
          set({
            ...emptyEntities(),
            // UI store 负责自己的状态，这里只清数据
          })
        },

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
        upsertItem: (item) => set((state) => ({ items: upsertInList(state.items, item) })),

        // ── remove ──
        removeProject: (id) =>
          set((state) => {
            if (state.currentProjectId === id) {
              // 删除当前项目：清空数据 + 统一清理 UI store 的项目相关状态
              useNovelUiStore.getState().resetForProjectSwitch()
              return {
                projects: removeFromList(state.projects, id),
                currentProjectId: null,
                ...emptyEntities(),
              }
            }
            return { projects: removeFromList(state.projects, id) }
          }),
        removeCharacter: (id) => set((state) => ({ characters: removeFromList(state.characters, id) })),
        removeChapter: (id) => set((state) => ({ chapters: removeFromList(state.chapters, id) })),
        removeConflict: (id) => set((state) => ({ conflicts: removeFromList(state.conflicts, id) })),
        removeClue: (id) => set((state) => ({ clues: removeFromList(state.clues, id) })),
        removeForeshadow: (id) => set((state) => ({ foreshadows: removeFromList(state.foreshadows, id) })),
        removeFaction: (id) => set((state) => ({ factions: removeFromList(state.factions, id) })),
        removeLocation: (id) => set((state) => ({ locations: removeFromList(state.locations, id) })),
        removeWorldElement: (id) => set((state) => ({ worldElements: removeFromList(state.worldElements, id) })),
        removeItem: (id) => set((state) => ({ items: removeFromList(state.items, id) })),
        removeInfoLayer: (id) => set((state) => ({ infoLayers: removeFromList(state.infoLayers, id) })),

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
          useNovelDataStore.temporal.getState().undo()
        },
        redo: () => {
          useNovelDataStore.temporal.getState().redo()
        },
        canUndo: () => {
          const { pastStates } = useNovelDataStore.temporal.getState()
          return pastStates.length > 0
        },
        canRedo: () => {
          const { futureStates } = useNovelDataStore.temporal.getState()
          return futureStates.length > 0
        },
        clearHistory: () => {
          useNovelDataStore.temporal.getState().clear()
        },

        // ── 派生字段（由 temporal store 订阅同步）──
        undoCount: 0,
        redoCount: 0,
      }),
      {
        name: 'wenlang-agent-novel-data',
        storage: createJSONStorage(() => localStorage),
        // 修复 zundo + persist 嵌套时的经典问题：hydrate 期间 temporal 会把"空初始状态"
        // 压入 pastStates，导致用户首次点撤销会把整个 store 还原成空状态。
        // 用 flag 标记 hydrate 完成，在 store 创建后延迟 clear() 历史栈，
        // 避免 onRehydrateStorage 回调中引用 useNovelDataStore 导致 TDZ
        // （localStorage 是同步 hydrate，回调在 create() 执行期间触发，
        //  此时 useNovelDataStore const 尚未赋值）
        onRehydrateStorage: () => () => {
          needsClearTemporal = true
        },
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
          items: state.items,
          nodePositions: state.nodePositions,
          characterHistory: state.characterHistory,
          edges: state.edges,
          markers: state.markers,
        }),
      },
    ),
    {
      // temporal 选项：仅追踪数据字段，UI 状态与 actions 不进入历史栈
      // 注意：currentProjectId 不进 temporal——它是导航状态，undo 恢复它
      // 会把已删除项目 ID 恢复但不会触发 setCurrentProject 的 clearHistory 副作用，
      // 导致状态不一致。切项目时由 setCurrentProject 手动 clear() 历史栈。
      partialize: (state) => ({
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
        items: state.items,
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

// store 创建后：如果 persist 已 hydrate，清除 temporal 中 hydrate 期间产生的伪快照
// 用 queueMicrotask 确保在当前同步执行栈完成后执行，避免影响 store 初始化
if (needsClearTemporal) {
  queueMicrotask(() => {
    useNovelDataStore.temporal.getState().clear()
  })
}

// 同步 undoCount/redoCount 派生字段（订阅 temporal store 状态变化）
// temporal store 是独立 vanilla store，其 pastStates/futureStates 变化时
// 需同步到主 store 的 undoCount/redoCount 以触发 React 重渲染
useNovelDataStore.temporal.subscribe((state) => {
  useNovelDataStore.setState({
    undoCount: state.pastStates.length,
    redoCount: state.futureStates.length,
  })
})
