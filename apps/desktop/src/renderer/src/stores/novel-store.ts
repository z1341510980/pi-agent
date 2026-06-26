import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
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
} from '@/api/novel-client'

// ── 节点类型 ──

export type NovelNodeType =
  | 'project'
  | 'character'
  | 'chapter'
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

  // ── 选中节点 ──
  selectedNodeId: string | null
  selectedNodeType: NovelNodeType | null

  // ── 加载状态 ──
  loading: boolean
  error: string | null

  // ── Actions ──
  setCurrentProject: (projectId: string | null) => void
  setProjects: (projects: NovelProject[]) => void
  loadProjectData: (data: {
    characters?: NovelCharacter[]
    chapters?: NovelChapter[]
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
  persist(
    (set) => ({
      // ── 初始状态 ──
      currentProjectId: null,
      projects: [],
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
      nodePositions: [],
      characterHistory: [],

      selectedNodeId: null,
      selectedNodeType: null,

      loading: false,
      error: null,

      // ── Actions ──
      setCurrentProject: (projectId) =>
        set({ currentProjectId: projectId, selectedNodeId: null, selectedNodeType: null }),

      setProjects: (projects) => set({ projects }),

      loadProjectData: (data) =>
        set((state) => ({
          characters: data.characters ?? state.characters,
          chapters: data.chapters ?? state.chapters,
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
        })),

      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),

      selectNode: (id, type) => set({ selectedNodeId: id, selectedNodeType: type }),
      clearSelection: () => set({ selectedNodeId: null, selectedNodeType: null }),
      clearProjectData: () =>
        set({
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
          nodePositions: [],
          characterHistory: [],
          selectedNodeId: null,
          selectedNodeType: null,
        }),

      // ── upsert ──
      upsertProject: (project) => set((state) => ({ projects: upsertInList(state.projects, project) })),
      upsertCharacter: (character) => set((state) => ({ characters: upsertInList(state.characters, character) })),
      upsertChapter: (chapter) => set((state) => ({ chapters: upsertInList(state.chapters, chapter) })),
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
                selectedNodeId: null,
                selectedNodeType: null,
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
        selectedNodeId: state.selectedNodeId,
        selectedNodeType: state.selectedNodeType,
      }),
    },
  ),
)
