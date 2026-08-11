/**
 * MatrixWorkspace：矩阵视图工作区
 *
 * 整合 MatrixToolbar + MatrixView + ChapterContextMenu
 * 提供过滤、缩放、折叠、补全历史、播放头联动、章节右键菜单
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import {
  batchCreateCharacterHistory,
  createCharacter,
  createConflict,
  createClue,
  createFaction,
  createForeshadow,
  createItem,
  createLocation,
  createMarker,
  createWorldElement,
  deleteCharacterHistory,
  deleteChapter,
  deleteMarker,
  getMatrixAggregation,
  listMarkers,
  updateConflict,
  updateClue,
  updateFaction,
  updateForeshadow,
  updateItem,
  updateLocation,
  updateMarker,
  type ForeshadowBeatType,
  type NovelForeshadow,
} from '@/api/novel-client'
import {
  appendPendingEntities,
  buildPool,
  findSpanAt,
  GROUP_ORDER,
  moveForeshadowEndpointBeat,
  resolveForeshadowLeftClickBeat,
  setForeshadowBeatNote,
  upsertForeshadowBeat,
  type MatrixEntity,
  type MatrixEntityKind,
} from './matrix-logic'
import { buildGroups, MATRIX_LAYOUT } from './matrix-model'
import { MatrixToolbar } from './matrix-toolbar'
import { MatrixView } from './matrix-view'
import { MatrixLegend } from './matrix-legend'
import { MatrixHoverCard } from './matrix-hover-card'
import { ChapterContextMenu, type ChapterContextMenuPosition } from './chapter-context-menu'
import { EntityCellMenu, type EntityCellMenuPosition } from './entity-cell-menu'
import { EntityCreateDialog } from './entity-create-dialog'
import { EntitySpanDialog } from './entity-span-dialog'
import { EntityNoteDialog } from './entity-note-dialog'
import { toastError } from '@/hooks/use-toast'
import { NarrativeTrackPanel } from '../narrative-track-panel'
import { EntityCandidatePanel } from '../entity-candidate-panel'
import { PendingEventsDialog } from './pending-events-dialog'
import { AnnotationPanelDialog } from './annotation-panel-dialog'
import { Button } from '@/components/ui/button'
import { GitBranch, Inbox, MessageSquareText, ShieldQuestion } from 'lucide-react'

/**
 * 把新区间合并进现有跨度列表：
 * - 与新区间相交（含相邻）的段合并为一个段 [min, max]
 * - 不相交的段保留
 * - 结果按 start 升序排序
 *
 * 用于 EntitySpanDialog 提交时：对话框编辑单段，需保留其他段不被覆盖。
 */
function mergeSpanIntoList(
  existing: Array<[number, number]>,
  newSpan: [number, number],
): Array<[number, number]> {
  const [ns, ne] = newSpan
  let mergedStart = ns
  let mergedEnd = ne
  const kept: Array<[number, number]> = []
  for (const [s, e] of existing) {
    // 相交或相邻（区间 [s,e] 与 [mergedStart,mergedEnd] 有重叠或首尾相连）
    const overlaps = s <= mergedEnd + 1 && e >= mergedStart - 1
    if (overlaps) {
      mergedStart = Math.min(mergedStart, s)
      mergedEnd = Math.max(mergedEnd, e)
    } else {
      kept.push([s, e])
    }
  }
  const result: Array<[number, number]> = [...kept, [mergedStart, mergedEnd]]
  result.sort((a, b) => a[0] - b[0])
  return result
}

function getForeshadowBeats(foreshadow: NovelForeshadow): NonNullable<NovelForeshadow['beats']> {
  // beats 为空时从 firstChapter 补埋设点；
  // 目的是避免旧数据（beats=[] 的伏笔）在用户拖拽时被当作权威源送回后端，
  // 导致 normalize 清空整条链。
  //
  // ⚠️ 不从 recoverByChapter 补 payoff：recoverByChapter 是"计划回收章"（意图），
  // 补成 payoff 会让后端把这条伏笔判成已回收，进而永久排除出后续编排。
  const beats = foreshadow.beats && foreshadow.beats.length > 0 ? [...foreshadow.beats] : []
  if (!beats.some((beat) => beat.type === 'plant') && foreshadow.firstChapter != null) {
    beats.push({ chapter: foreshadow.firstChapter, type: 'plant' as const })
  }
  return beats.sort((a, b) => a.chapter - b.chapter)
}

export interface MatrixWorkspaceProps {
  creationRunning?: boolean
  creationChapterNumber?: number
  onRegenerateChapter?: (chapterNumber: number) => void
  onStartCreationAt?: (chapterNumber: number) => void
  /** LLM 相似度扫描：语义相似智能合并 */
  onSimilarityScan?: () => void
  similarityScanning?: boolean
}

const DEFAULT_CELL_WIDTH = MATRIX_LAYOUT.defaultCellWidth
const MIN_CELL_WIDTH = MATRIX_LAYOUT.minCellWidth
const MAX_CELL_WIDTH = MATRIX_LAYOUT.maxCellWidth
const ZOOM_STEP = 4

export function MatrixWorkspace({
  creationRunning = false,
  creationChapterNumber,
  onRegenerateChapter,
  onStartCreationAt,
  onSimilarityScan,
  similarityScanning = false,
}: MatrixWorkspaceProps): ReactElement {
  const queryClient = useQueryClient()

  // ── store 数据 ──
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const characters = useNovelDataStore((s) => s.characters)
  const chapters = useNovelDataStore((s) => s.chapters)
  const conflicts = useNovelDataStore((s) => s.conflicts)
  const clues = useNovelDataStore((s) => s.clues)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)
  const factions = useNovelDataStore((s) => s.factions)
  const locations = useNovelDataStore((s) => s.locations)
  const worldElements = useNovelDataStore((s) => s.worldElements)
  const infoLayers = useNovelDataStore((s) => s.infoLayers)
  const items = useNovelDataStore((s) => s.items)
  const narratives = useNovelDataStore((s) => s.narratives)
  const characterHistory = useNovelDataStore((s) => s.characterHistory)
  const relationships = useNovelDataStore((s) => s.relationships)
  const markers = useNovelDataStore((s) => s.markers)
  const setMarkers = useNovelDataStore((s) => s.setMarkers)
  const removeMarker = useNovelDataStore((s) => s.removeMarker)
  const selectNode = useNovelUiStore((s) => s.selectNode)
  const selectedNodeId = useNovelUiStore((s) => s.selectedNodeId)
  // dhtmlx-gantt 风格多选
  const selectMatrixEntity = useNovelUiStore((s) => s.selectMatrixEntity)
  const selectedMatrixEntityIds = useNovelUiStore((s) => s.selectedMatrixEntityIds)
  const clearMatrixSelection = useNovelUiStore((s) => s.clearMatrixSelection)
  // 子甘特图"复合片段"展开状态（不持久化）
  const expandedEntityIds = useNovelUiStore((s) => s.expandedEntityIds)
  const toggleEntityExpand = useNovelUiStore((s) => s.toggleEntityExpand)
  // 矩阵空白点击清空多选（dhtmlx 风格），阶段3 键盘 Esc 也会复用
  const playheadChapter = useNovelUiStore((s) => s.playheadChapter)
  const setPlayheadChapter = useNovelUiStore((s) => s.setPlayheadChapter)
  const removeChapter = useNovelDataStore((s) => s.removeChapter)
  const setCharacterHistory = useNovelDataStore((s) => s.setCharacterHistory)
  // ── C-3 折叠分组从 store 共享（与 NovelSidebar 联动）──
  const collapsedGroupsArr = useNovelUiStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useNovelUiStore((s) => s.toggleCollapsedGroup)
  const upsertMarker = useNovelDataStore((s) => s.upsertMarker)
  // ── Undo/Redo（与 MatrixToolbar 联动）──
  const undoCount = useNovelDataStore((s) => s.undoCount)
  const redoCount = useNovelDataStore((s) => s.redoCount)
  const undo = useNovelDataStore((s) => s.undo)
  const redo = useNovelDataStore((s) => s.redo)

  // ── 本地 UI 状态 ──
  const [cellWidth, setCellWidth] = useState<number>(DEFAULT_CELL_WIDTH)
  // 剧情轨道 / 待审实体入口（矩阵视图也能访问，不只在画布工具栏）
  const [trackPanelOpen, setTrackPanelOpen] = useState(false)
  const [candidatePanelOpen, setCandidatePanelOpen] = useState(false)
  const [pendingEventsOpen, setPendingEventsOpen] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const collapsedGroups = useMemo(() => new Set(collapsedGroupsArr as MatrixEntityKind[]), [collapsedGroupsArr])
  const [activeFilter, setActiveFilter] = useState<MatrixEntityKind | null>(null)
  const [isCompleting, setIsCompleting] = useState(false)
  const [contextMenu, setContextMenu] = useState<ChapterContextMenuPosition | null>(null)
  const [cellMenu, setCellMenu] = useState<EntityCellMenuPosition | null>(null)
  const [createDialog, setCreateDialog] = useState<{ kind: MatrixEntityKind; chapter: number | null } | null>(null)
  const [spanDialog, setSpanDialog] = useState<{ entity: MatrixEntity } | null>(null)
  const [noteDialog, setNoteDialog] = useState<{
    scope: 'entity' | 'foreshadow-beat'
    entityId: string
    entityName: string
    entityType: MatrixEntityKind
    chapter: number
    beatType: ForeshadowBeatType | null
    initialNote: string
    existingMarkerId: string | null
  } | null>(null)
  // ── 关系叠加层开关（统一渲染引擎第 5 步子任务 B）──
  const [showRelationshipOverlay, setShowRelationshipOverlay] = useState(false)
  // ── 实体名称搜索（图例展开态输入，下传 MatrixView 过滤行）──
  const [searchQuery, setSearchQuery] = useState('')

  // ── 从后端加载标记 ──
  useEffect(() => {
    if (!currentProjectId) {
      setMarkers([])
      return
    }
    let cancelled = false
    listMarkers(currentProjectId)
      .then((list) => {
        if (!cancelled) setMarkers(list)
      })
      .catch((err) => {
        console.error('[MatrixWorkspace] 加载标记失败:', err)
      })
    return () => {
      cancelled = true
    }
  }, [currentProjectId, setMarkers])

  // ── 矩阵数据（单次计算，下传给 MatrixView 纯渲染）──
  // ── 元素池：尚未放到任何章节的实体 ──
  // 既供工具栏「补全历史」使用，也用于把这些实体作为「未上线」行补进矩阵，
  // 否则它们在矩阵里完全不可见（buildGroups 会跳过无跨度的实体）。
  const pool = useMemo(
    () => buildPool({ characters, conflicts, clues, foreshadows, factions, locations, items, characterHistory }),
    [characters, conflicts, clues, foreshadows, factions, locations, items, characterHistory],
  )

  const matrixData = useMemo(
    () => {
      const built = buildGroups({
        chapters, characters, conflicts, clues, foreshadows, factions, locations, worldElements,
        infoLayers, items, characterHistory, markers, narratives,
      })
      return { ...built, groups: appendPendingEntities(built.groups, pool) }
    },
    [chapters, characters, conflicts, clues, foreshadows, factions, locations, worldElements, infoLayers, items, characterHistory, markers, narratives, pool],
  )

  // ── 共享账本投影：matrix-aggregation 单请求，全部展开实体的子轨道共用 ──
  const { data: aggregationData } = useQuery({
    queryKey: ['novel', 'matrix-aggregation', currentProjectId],
    queryFn: () => getMatrixAggregation(currentProjectId!, {
      chapterStart: 1,
      chapterEnd: matrixData.maxChapter,
    }),
    enabled: !!currentProjectId,
    staleTime: 30_000,
  })
  const aggregationChanges = useMemo(() => aggregationData?.changes ?? [], [aggregationData])
  const aggregationEventEdges = useMemo(() => aggregationData?.eventEdges ?? [], [aggregationData])

  // ── 失效统一入口：项目数据 + 矩阵聚合（子轨道缓存同步刷新）──
  const invalidateNovelData = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
    void queryClient.invalidateQueries({ queryKey: ['novel', 'matrix-aggregation', currentProjectId] })
  }, [queryClient, currentProjectId])

  // ── 扁平实体列表（键盘导航用，dhtmlx 风格方向键在实体间移动）──
  // 过滤掉折叠的分组内的实体 + 搜索关键字过滤，保证方向键只落在可见实体上
  const flatEntities = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const out: Array<{ entityId: string; entityType: MatrixEntityKind; name: string }> = []
    for (const g of matrixData.groups) {
      if (collapsedGroups.has(g.id)) continue
      for (const e of g.entities) {
        if (q && !e.name.toLowerCase().includes(q)) continue
        out.push({ entityId: e.entityId, entityType: g.id, name: e.name })
      }
    }
    return out
  }, [matrixData, collapsedGroups, searchQuery])

  // ── 播放头（创作流程联动）──
  const effectivePlayheadChapter = creationRunning && creationChapterNumber != null
    ? creationChapterNumber
    : playheadChapter

  // ── 回调 ──
  const handlePlayheadChange = useCallback((chapter: number) => {
    if (creationRunning) return
    setPlayheadChapter(chapter)
  }, [creationRunning, setPlayheadChapter])

  const handleZoomIn = useCallback(() => {
    setCellWidth((w) => Math.min(MAX_CELL_WIDTH, w + ZOOM_STEP))
  }, [])

  const handleZoomOut = useCallback(() => {
    setCellWidth((w) => Math.max(MIN_CELL_WIDTH, w - ZOOM_STEP))
  }, [])

  // Ctrl+滚轮 / 工具栏滑杆：连续缩放
  const handleCellWidthChange = useCallback((next: number) => {
    setCellWidth(Math.max(MIN_CELL_WIDTH, Math.min(MAX_CELL_WIDTH, next)))
  }, [])

  const handleToggleCollapse = useCallback((kind: MatrixEntityKind) => {
    toggleCollapsedGroup(kind)
  }, [toggleCollapsedGroup])

  // 统一渲染引擎第 4 步：直接 toggleEntityExpand，支持多实体同时 inline 展开
  // 不再 collapseAllExpanded（避免切换到 EntityGanttFocus 全屏替换）
  const handleToggleEntityFocus = useCallback((entityId: string) => {
    toggleEntityExpand(entityId)
  }, [toggleEntityExpand])

  const handleFilterChange = useCallback((filter: MatrixEntityKind | null) => {
    setActiveFilter((prev) => (prev === filter ? null : filter))
  }, [])

  // dhtmlx-gantt 风格：单击选中（同步 selectedNodeId 联动右面板），Ctrl/Cmd 多选
  const handleSelectEntity = useCallback(
    (entityType: MatrixEntityKind, entityId: string, opts?: { multi?: boolean }): void => {
      selectMatrixEntity(entityId, entityType, opts)
    },
    [selectMatrixEntity],
  )

  // 双击色带：编辑实体本身（dhtmlx 风格）
  // 复用现有的实体详情对话框：触发选中 + 打开右面板详情 tab
  const handleEditEntity = useCallback(
    (entity: MatrixEntity): void => {
      selectMatrixEntity(entity.entityId, entity.entityType)
      // 右面板详情 tab 由 selectedNodeId 联动自动切换
    },
    [selectMatrixEntity],
  )

  // ── dhtmlx-gantt 风格键盘导航 ──
  // ↑↓ 在可见实体间移动选中；Enter 编辑当前选中；Esc 清空多选；Ctrl+A 全选可见实体
  const moveSelection = useCallback(
    (dir: 'up' | 'down') => {
      if (flatEntities.length === 0) return
      const curIdx = flatEntities.findIndex((e) => e.entityId === selectedMatrixEntityIds[0])
      const nextIdx =
        curIdx < 0
          ? dir === 'down'
            ? 0
            : flatEntities.length - 1
          : (curIdx + (dir === 'down' ? 1 : -1) + flatEntities.length) % flatEntities.length
      const next = flatEntities[nextIdx]
      if (next) selectMatrixEntity(next.entityId, next.entityType)
    },
    [flatEntities, selectedMatrixEntityIds, selectMatrixEntity],
  )

  const selectAllVisible = useCallback(() => {
    // Ctrl+A：全选当前可见实体（dhtmlx 风格批量操作）
    if (flatEntities.length === 0) return
    // 逐个 toggle 会很慢，直接构造数组：用 store 的 set 不便，这里走多次调用
    // 注意：第一个用单选（同步 selectedNodeId），其余用 multi 追加
    flatEntities.forEach((e, i) => selectMatrixEntity(e.entityId, e.entityType, { multi: i > 0 }))
  }, [flatEntities, selectMatrixEntity])

  // 仅在矩阵视图且焦点不在输入框/富文本时响应（避免与正文编辑冲突）
  // enableOnTags 排除 INPUT/TEXTAREA/SELECT；ProseMirror 的 contenteditable 通过检查 activeElement
  const hotkeyOpts = {
    enabled: true,
    enableOnTags: ['BODY', 'DIV', 'BUTTON', 'SPAN'] as const,
    filter: () => {
      const ae = document.activeElement
      if (!ae) return true
      // 焦点在输入框/富文本/可编辑元素时禁用方向键导航
      const tag = ae.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
      if ((ae as HTMLElement).isContentEditable) return false
      return true
    },
  }
  useHotkeys('arrowdown', (e) => { e.preventDefault(); moveSelection('down') }, hotkeyOpts, [moveSelection])
  useHotkeys('arrowup', (e) => { e.preventDefault(); moveSelection('up') }, hotkeyOpts, [moveSelection])
  useHotkeys('escape', () => clearMatrixSelection(), { enabled: true }, [clearMatrixSelection])
  useHotkeys('mod+a', (e) => { e.preventDefault(); selectAllVisible() }, hotkeyOpts, [selectAllVisible])

  const handleContextMenuChapter = useCallback(
    (chapterNumber: number, x: number, y: number): void => {
      const chapter = chapters.find((c) => c.chapterNumber === chapterNumber)
      setContextMenu({
        x,
        y,
        chapterNumber,
        chapterId: chapter?.id ?? null,
        chapterTitle: chapter?.title ?? null,
      })
    },
    [chapters],
  )

  // ── 补全角色历史 ──
  const completableCount = pool.poolCharacters.length
  const handleCompleteHistory = useCallback(async (): Promise<void> => {
    if (!currentProjectId || completableCount === 0) return
    setIsCompleting(true)
    try {
      const records = pool.poolCharacters.map((c) => ({
        characterId: c.id,
        chapterNumber: 1,
      }))
      const created = await batchCreateCharacterHistory(currentProjectId, records)
      setCharacterHistory([...characterHistory, ...created])
      invalidateNovelData()
    } catch (err) {
      console.error('[MatrixWorkspace] 补全历史失败:', err)
      toastError('补全历史失败', err instanceof Error ? err.message : String(err))
    } finally {
      setIsCompleting(false)
    }
  }, [currentProjectId, completableCount, pool.poolCharacters, characterHistory, setCharacterHistory, queryClient])

  // ── 章节右键菜单回调 ──
  const handleGenerateFromMenu = useCallback((chapterNumber: number): void => {
    onStartCreationAt?.(chapterNumber)
  }, [onStartCreationAt])

  const handleRegenerateFromMenu = useCallback((chapterNumber: number): void => {
    onRegenerateChapter?.(chapterNumber)
  }, [onRegenerateChapter])

  const handleViewChapter = useCallback((chapterNumber: number): void => {
    const chapter = chapters.find((c) => c.chapterNumber === chapterNumber)
    if (chapter) selectNode(chapter.id, 'chapter')
  }, [chapters, selectNode])

  const handleDeleteChapter = useCallback(async (chapterId: string): Promise<void> => {
    if (!currentProjectId) return
    try {
      await deleteChapter(chapterId)
      removeChapter(chapterId)
      invalidateNovelData()
    } catch (err) {
      console.error('[MatrixWorkspace] 删除章节失败:', err)
    }
  }, [currentProjectId, removeChapter, queryClient])

  // ── 删除该段范围（仅 conflict/faction）──
  // 移除 chapter 所在的整段 chapterSpan，保留其他段
  const handleRemoveSpan = useCallback(async (
    entityId: string,
    entityType: MatrixEntityKind,
    chapter: number,
  ): Promise<void> => {
    if (!currentProjectId) return
    if (entityType !== 'conflict' && entityType !== 'faction') return
    try {
      if (entityType === 'conflict') {
        const c = useNovelDataStore.getState().conflicts.find((x) => x.id === entityId)
        if (!c) return
        const span = findSpanAt(c.chapterSpans, chapter)
        if (span == null) return
        const newSpans = c.chapterSpans.filter((sp) => sp !== span)
        const updated = await updateConflict(entityId, { chapterSpans: newSpans })
        useNovelDataStore.getState().upsertConflict(updated)
      } else {
        const f = useNovelDataStore.getState().factions.find((x) => x.id === entityId)
        if (!f) return
        const span = findSpanAt(f.chapterSpans, chapter)
        if (span == null) return
        const newSpans = f.chapterSpans.filter((sp) => sp !== span)
        const updated = await updateFaction(entityId, { chapterSpans: newSpans })
        useNovelDataStore.getState().upsertFaction(updated)
      }
      invalidateNovelData()
    } catch (err) {
      console.error('[MatrixWorkspace] 删除该段范围失败:', err)
    }
  }, [currentProjectId, queryClient])

  // ── 单元格右键菜单：标记/删除出场（按 entityType 语义化适配） ──
  // - character：操作 characterHistory 关联表（batchCreate / delete）
  // - conflict/faction：扩展或收缩 firstChapter/lastChapter 端点（中间格不可删）
  // - foreshadow：右键设 firstChapter（埋设点）或 recoverByChapter（回收点）
  // - location：操作 appearChapters 数组
  // - world_element / info_layer：由实体属性驱动，不通过单元格直接标记
  const isCellEditable = useCallback((kind: MatrixEntityKind): boolean => {
    return kind !== 'world_element' && kind !== 'info_layer'
  }, [])

  const isCellPresent = useCallback((entityId: string, kind: MatrixEntityKind, chapter: number): boolean => {
    switch (kind) {
      case 'character': {
        const history = characterHistory.filter((h) => h.characterId === entityId && h.chapterNumber === chapter)
        return history.length > 0
      }
      case 'conflict': {
        const c = conflicts.find((x) => x.id === entityId)
        if (!c) return false
        return c.chapterSpans.some(([s, e]) => chapter >= s && chapter <= e)
      }
      case 'clue': {
        const clue = clues.find((item) => item.id === entityId)
        return clue?.chapterSpans.some(([start, end]) => chapter >= start && chapter <= end) ?? false
      }
      case 'faction': {
        const f = factions.find((x) => x.id === entityId)
        if (!f) return false
        return f.chapterSpans.some(([s, e]) => chapter >= s && chapter <= e)
      }
      case 'foreshadow': {
        const f = foreshadows.find((x) => x.id === entityId)
        if (!f) return false
        const beat = getForeshadowBeats(f).find((item) => item.chapter === chapter)
        // 埋设点是矩阵行的锚点。普通单元格菜单不允许误删根节点，
        // 否则整条事件链会被清空，伏笔行也会立即移回元素池。
        return beat != null && beat.type !== 'plant'
      }
      case 'item': {
        const it = useNovelDataStore.getState().items.find((x) => x.id === entityId)
        if (!it) return false
        return (it.chapterSpans ?? []).some(([s, e]) => chapter >= s && chapter <= e)
      }
      case 'location': {
        const l = locations.find((x) => x.id === entityId)
        return !!l?.appearChapters?.includes(chapter)
      }
      case 'world_element':
        return true
      default:
        return false
    }
  }, [characterHistory, conflicts, clues, factions, foreshadows, locations])

  /** 该单元格是否支持「删除出场」操作（端点型实体中间格不可删） */
  const isCellRemovable = useCallback((entityId: string, kind: MatrixEntityKind, chapter: number): boolean => {
    switch (kind) {
      case 'conflict':
      case 'faction':
      case 'item': {
        const e = kind === 'conflict'
          ? conflicts.find((x) => x.id === entityId)
          : kind === 'faction'
            ? factions.find((x) => x.id === entityId)
            : useNovelDataStore.getState().items.find((x) => x.id === entityId)
        if (!e) return false
        // 用 findSpanAt 定位 chapter 所在段，仅段首/段尾可删（中间格不可挖洞）
        const span = findSpanAt(e.chapterSpans ?? [], chapter)
        if (span == null) return false
        return chapter === span[0] || chapter === span[1]
      }
      case 'foreshadow': {
        const f = foreshadows.find((x) => x.id === entityId)
        if (!f) return false
        return getForeshadowBeats(f).some((beat) => beat.chapter === chapter)
      }
      case 'clue':
        return true
      default:
        return true
    }
  }, [conflicts, factions, foreshadows])

  const handleContextMenuCell = useCallback((entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => {
    const editable = isCellEditable(entityType)
    const present = editable && isCellPresent(entityId, entityType, chapter)
    const removable = editable && present && isCellRemovable(entityId, entityType, chapter)
    // foreshadow 动态状态：根据离散事件链判断下一步动作
    let foreshadowState: 'unplanted' | 'active' | 'recovered' | undefined
    let foreshadowBeatType: ForeshadowBeatType | undefined
    let foreshadowBeatNote: string | undefined
    if (entityType === 'foreshadow') {
      const f = foreshadows.find((x) => x.id === entityId)
      const beats = f ? getForeshadowBeats(f) : []
      const currentBeat = beats.find((beat) => beat.chapter === chapter)
      foreshadowBeatType = currentBeat?.type
      foreshadowBeatNote = currentBeat?.note
      const plant = beats.find((beat) => beat.type === 'plant')?.chapter
      const payoff = beats.find((beat) => beat.type === 'payoff')?.chapter
      if (plant == null) foreshadowState = 'unplanted'
      else if (chapter < plant) foreshadowState = 'unplanted'
      else if (payoff != null && chapter > payoff) foreshadowState = 'recovered'
      else foreshadowState = 'active'
    }
    setCellMenu({
      x, y, entityId, entityName, entityType, chapter, present, editable, removable,
      foreshadowState, foreshadowBeatType, foreshadowBeatNote,
    })
  }, [isCellEditable, isCellPresent, isCellRemovable, foreshadows])

  const handleMarkPresent = useCallback(async (entityId: string, entityType: MatrixEntityKind, chapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entityType) {
        case 'character': {
          // 用 batchCreateCharacterHistory 写入一条 chapterNumber 记录（reason 标注手动）
          // useNovelDataStore.getState() 取最新数据，避免闭包陈旧导致覆盖丢失记录
          const created = await batchCreateCharacterHistory(currentProjectId, [{ characterId: entityId, chapterNumber: chapter }])
          const fresh = useNovelDataStore.getState().characterHistory
          setCharacterHistory([...fresh, ...created])
          invalidateNovelData()
          break
        }
        case 'conflict': {
          // 用 useNovelDataStore.getState() 取最新数据，避免闭包陈旧导致覆盖丢失段
          const c = useNovelDataStore.getState().conflicts.find((x) => x.id === entityId)
          if (!c) {
            console.warn('[MatrixWorkspace] conflict 拖入：未找到冲突', entityId)
            return
          }
          // 拖入冲突到矩阵的语义（操作 chapterSpans 多段跨度）：
          // - chapter 已在某段内 → 不操作
          // - chapterSpans 为空 → 新建单章段 [[chapter, chapter]]
          // - chapter 紧邻某段 start-1 → 扩展该段 start
          // - chapter 紧邻某段 end+1 → 扩展该段 end
          // - 否则 → 追加新段 [chapter, chapter] 并按起始章节排序
          const spans = c.chapterSpans
          if (findSpanAt(spans, chapter) != null) break
          let newSpans: Array<[number, number]>
          if (spans.length === 0) {
            newSpans = [[chapter, chapter]]
          } else {
            const adjStartIdx = spans.findIndex((sp) => sp[0] === chapter + 1)
            const adjEndIdx = spans.findIndex((sp) => sp[1] === chapter - 1)
            if (adjStartIdx >= 0) {
              newSpans = spans.map((sp, i) => i === adjStartIdx ? [chapter, sp[1]] as [number, number] : sp)
            } else if (adjEndIdx >= 0) {
              newSpans = spans.map((sp, i) => i === adjEndIdx ? [sp[0], chapter] as [number, number] : sp)
            } else {
              newSpans = [...spans, [chapter, chapter] as [number, number]].sort((a, b) => a[0] - b[0])
            }
          }
          const updated = await updateConflict(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertConflict(updated)
          invalidateNovelData()
          break
        }
        case 'clue': {
          const clue = useNovelDataStore.getState().clues.find((item) => item.id === entityId)
          if (!clue || findSpanAt(clue.chapterSpans, chapter) != null) break
          const chapterSpans = mergeSpanIntoList(clue.chapterSpans, [chapter, chapter])
          const updated = await updateClue(entityId, { chapterSpans })
          useNovelDataStore.getState().upsertClue(updated)
          invalidateNovelData()
          break
        }
        case 'faction': {
          // 用 useNovelDataStore.getState() 取最新数据，避免闭包陈旧
          const f = useNovelDataStore.getState().factions.find((x) => x.id === entityId)
          if (!f) {
            console.warn('[MatrixWorkspace] faction 拖入：未找到势力', entityId)
            return
          }
          // 拖入势力到矩阵的语义（与 conflict 一致，操作 chapterSpans）
          const spans = f.chapterSpans
          if (findSpanAt(spans, chapter) != null) break
          let newSpans: Array<[number, number]>
          if (spans.length === 0) {
            newSpans = [[chapter, chapter]]
          } else {
            const adjStartIdx = spans.findIndex((sp) => sp[0] === chapter + 1)
            const adjEndIdx = spans.findIndex((sp) => sp[1] === chapter - 1)
            if (adjStartIdx >= 0) {
              newSpans = spans.map((sp, i) => i === adjStartIdx ? [chapter, sp[1]] as [number, number] : sp)
            } else if (adjEndIdx >= 0) {
              newSpans = spans.map((sp, i) => i === adjEndIdx ? [sp[0], chapter] as [number, number] : sp)
            } else {
              newSpans = [...spans, [chapter, chapter] as [number, number]].sort((a, b) => a[0] - b[0])
            }
          }
          const updated = await updateFaction(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertFaction(updated)
          invalidateNovelData()
          break
        }
        case 'item': {
          // 物品拖入语义：与 faction 一致，操作 chapterSpans 多段跨度
          const it = useNovelDataStore.getState().items.find((x) => x.id === entityId)
          if (!it) {
            console.warn('[MatrixWorkspace] item 拖入：未找到物品', entityId)
            return
          }
          const spans = it.chapterSpans ?? []
          if (findSpanAt(spans, chapter) != null) break
          let newSpans: Array<[number, number]>
          if (spans.length === 0) {
            newSpans = [[chapter, chapter]]
          } else {
            const adjStartIdx = spans.findIndex((sp) => sp[0] === chapter + 1)
            const adjEndIdx = spans.findIndex((sp) => sp[1] === chapter - 1)
            if (adjStartIdx >= 0) {
              newSpans = spans.map((sp, i) => i === adjStartIdx ? [chapter, sp[1]] as [number, number] : sp)
            } else if (adjEndIdx >= 0) {
              newSpans = spans.map((sp, i) => i === adjEndIdx ? [sp[0], chapter] as [number, number] : sp)
            } else {
              newSpans = [...spans, [chapter, chapter] as [number, number]].sort((a, b) => a[0] - b[0])
            }
          }
          const updated = await updateItem(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertItem(updated)
          invalidateNovelData()
          break
        }
        case 'foreshadow': {
          const f = foreshadows.find((x) => x.id === entityId)
          if (!f) {
            console.warn('[MatrixWorkspace] foreshadow 拖入：未找到伏笔', entityId)
            return
          }
          // 从元素池首次拖入只负责建立埋设点。后续强化、揭示、回收必须通过
          // 单元格右键显式选择语义，避免“拖到后面 = 自动回收”的歧义。
          if (f.firstChapter == null) {
            const updated = await updateForeshadow(entityId, { beats: [{ chapter, type: 'plant' }] })
            useNovelDataStore.getState().upsertForeshadow(updated)
          }
          invalidateNovelData()
          break
        }
        case 'location': {
          const loc = locations.find((l) => l.id === entityId)
          if (!loc) return
          const next = Array.from(new Set([...(loc.appearChapters ?? []), chapter])).sort((a, b) => a - b)
          const updated = await updateLocation(entityId, { appearChapters: next })
          useNovelDataStore.getState().upsertLocation(updated)
          invalidateNovelData()
          break
        }
        case 'world_element':
          break
      }
    } catch (err) {
      console.error('[MatrixWorkspace] 标记出场失败:', err)
    }
  }, [currentProjectId, characterHistory, conflicts, clues, factions, foreshadows, locations, setCharacterHistory, queryClient])

  const handleRemovePresent = useCallback(async (entityId: string, entityType: MatrixEntityKind, chapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entityType) {
        case 'character': {
          // 找出该角色在该章的所有 history 记录，逐条删除
          // useNovelDataStore.getState() 取最新数据，避免闭包陈旧
          const fresh = useNovelDataStore.getState().characterHistory
          const records = fresh.filter((h) => h.characterId === entityId && h.chapterNumber === chapter)
          for (const r of records) {
            await deleteCharacterHistory(currentProjectId, r.id)
          }
          if (records.length > 0) {
            const after = useNovelDataStore.getState().characterHistory
            setCharacterHistory(after.filter((h) => !records.some((r) => r.id === h.id)))
            invalidateNovelData()
          }
          break
        }
        case 'conflict': {
          // 用 useNovelDataStore.getState() 取最新数据，避免闭包陈旧
          const c = useNovelDataStore.getState().conflicts.find((x) => x.id === entityId)
          if (!c) return
          const span = findSpanAt(c.chapterSpans, chapter)
          if (span == null) return // 不在任何段中（中间格不可删由 isCellRemovable 保证）
          let newSpans: Array<[number, number]>
          if (span[0] === span[1]) {
            // 单章段 → 删除该段
            newSpans = c.chapterSpans.filter((sp) => sp !== span)
          } else if (chapter === span[0]) {
            // 段首 → start +1
            newSpans = c.chapterSpans.map((sp) => sp === span ? [span[0] + 1, span[1]] as [number, number] : sp)
          } else if (chapter === span[1]) {
            // 段尾 → end -1
            newSpans = c.chapterSpans.map((sp) => sp === span ? [span[0], span[1] - 1] as [number, number] : sp)
          } else {
            return // 中间章不可删
          }
          const updated = await updateConflict(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertConflict(updated)
          invalidateNovelData()
          break
        }
        case 'clue': {
          const clue = useNovelDataStore.getState().clues.find((item) => item.id === entityId)
          if (!clue) return
          const span = findSpanAt(clue.chapterSpans, chapter)
          if (!span) return
          let chapterSpans: Array<[number, number]>
          if (span[0] === span[1]) {
            chapterSpans = clue.chapterSpans.filter((item) => item !== span)
          } else if (chapter === span[0]) {
            chapterSpans = clue.chapterSpans.map((item) => item === span ? [span[0] + 1, span[1]] as [number, number] : item)
          } else if (chapter === span[1]) {
            chapterSpans = clue.chapterSpans.map((item) => item === span ? [span[0], span[1] - 1] as [number, number] : item)
          } else {
            chapterSpans = [
              ...clue.chapterSpans.filter((item) => item !== span),
              [span[0], chapter - 1] as [number, number],
              [chapter + 1, span[1]] as [number, number],
            ].sort((a, b) => a[0] - b[0])
          }
          const updated = await updateClue(entityId, { chapterSpans })
          useNovelDataStore.getState().upsertClue(updated)
          invalidateNovelData()
          break
        }
        case 'faction': {
          // 用 useNovelDataStore.getState() 取最新数据，避免闭包陈旧
          const f = useNovelDataStore.getState().factions.find((x) => x.id === entityId)
          if (!f) return
          const span = findSpanAt(f.chapterSpans, chapter)
          if (span == null) return
          let newSpans: Array<[number, number]>
          if (span[0] === span[1]) {
            newSpans = f.chapterSpans.filter((sp) => sp !== span)
          } else if (chapter === span[0]) {
            newSpans = f.chapterSpans.map((sp) => sp === span ? [span[0] + 1, span[1]] as [number, number] : sp)
          } else if (chapter === span[1]) {
            newSpans = f.chapterSpans.map((sp) => sp === span ? [span[0], span[1] - 1] as [number, number] : sp)
          } else {
            return
          }
          const updated = await updateFaction(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertFaction(updated)
          invalidateNovelData()
          break
        }
        case 'item': {
          const it = useNovelDataStore.getState().items.find((x) => x.id === entityId)
          if (!it) return
          const spans = it.chapterSpans ?? []
          const span = findSpanAt(spans, chapter)
          if (span == null) return
          let newSpans: Array<[number, number]>
          if (span[0] === span[1]) {
            newSpans = spans.filter((sp) => sp !== span)
          } else if (chapter === span[0]) {
            newSpans = spans.map((sp) => sp === span ? [span[0] + 1, span[1]] as [number, number] : sp)
          } else if (chapter === span[1]) {
            newSpans = spans.map((sp) => sp === span ? [span[0], span[1] - 1] as [number, number] : sp)
          } else {
            return
          }
          const updated = await updateItem(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertItem(updated)
          invalidateNovelData()
          break
        }
        case 'foreshadow': {
          const f = foreshadows.find((x) => x.id === entityId)
          if (!f) return
          const existing = getForeshadowBeats(f)
          const removed = existing.find((beat) => beat.chapter === chapter)
          // 埋设点是事件链的根；删除根节点时清空整条链，避免留下没有起因的孤立事件。
          const beats = removed?.type === 'plant'
            ? []
            : existing.filter((beat) => beat.chapter !== chapter)
          const updated = await updateForeshadow(entityId, { beats })
          useNovelDataStore.getState().upsertForeshadow(updated)
          invalidateNovelData()
          break
        }
        case 'location': {
          const loc = locations.find((l) => l.id === entityId)
          if (!loc) return
          const next = (loc.appearChapters ?? []).filter((c) => c !== chapter)
          const updated = await updateLocation(entityId, { appearChapters: next })
          useNovelDataStore.getState().upsertLocation(updated)
          invalidateNovelData()
          break
        }
        case 'world_element':
          break
      }
    } catch (err) {
      console.error('[MatrixWorkspace] 删除出场失败:', err)
      toastError('删除出场失败', err instanceof Error ? err.message : String(err))
    }
  }, [currentProjectId, characterHistory, conflicts, clues, factions, foreshadows, locations, setCharacterHistory, queryClient])

  const handleMarkForeshadowBeat = useCallback(async (
    entityId: string,
    chapter: number,
    type: ForeshadowBeatType,
    editAfterCreate = false,
  ): Promise<void> => {
    if (!currentProjectId) return
    try {
      const foreshadow = useNovelDataStore.getState().foreshadows.find((item) => item.id === entityId)
      if (!foreshadow) return
      const existing = getForeshadowBeats(foreshadow)
      const beats = upsertForeshadowBeat(existing, chapter, type)
      const updated = await updateForeshadow(entityId, { beats })
      useNovelDataStore.getState().upsertForeshadow(updated)
      if (editAfterCreate) {
        const savedBeat = getForeshadowBeats(updated).find((beat) => beat.chapter === chapter)
        if (savedBeat) {
          const legacyMarker = useNovelDataStore.getState().markers.find(
            (marker) => marker.type === 'clip-note' && marker.entityId === entityId,
          )
          setNoteDialog({
            scope: 'foreshadow-beat',
            entityId,
            entityName: updated.description,
            entityType: 'foreshadow',
            chapter,
            beatType: savedBeat.type,
            initialNote: savedBeat.note ?? legacyMarker?.note ?? '',
            existingMarkerId: legacyMarker?.id ?? null,
          })
        }
      }
      invalidateNovelData()
    } catch (err) {
      console.error('[MatrixWorkspace] 标记伏笔节点失败:', err)
      toastError('标记伏笔节点失败', err instanceof Error ? err.message : String(err))
    }
  }, [currentProjectId, queryClient])

  // ── 空单元格单击：构造性快速新增；删除/收缩统一走右键菜单 ──
  const handleTogglePresent = useCallback(async (entity: MatrixEntity, chapter: number): Promise<void> => {
    const kind = entity.kind
    if (kind === 'world_element' || kind === 'info_layer') return

    if (kind === 'foreshadow') {
      const foreshadow = useNovelDataStore.getState().foreshadows.find((item) => item.id === entity.entityId)
      if (!foreshadow) return
      const type = resolveForeshadowLeftClickBeat(getForeshadowBeats(foreshadow), chapter)
      if (type) await handleMarkForeshadowBeat(entity.entityId, chapter, type)
      return
    }

    if (!isCellPresent(entity.entityId, kind, chapter)) {
      await handleMarkPresent(entity.entityId, kind, chapter)
    }
  }, [isCellPresent, handleMarkPresent, handleMarkForeshadowBeat])

  // ── 拖动跨度端点（conflict/faction/foreshadow）调整起止章节 ──
  // 语义：拖动端点到新章节列，移动该端点；conflict/faction 按 spanIndex 定位目标段，
  // 反转保护：start 不能超过同段 end，end 不能低于同段 start（clamp 而非扩展另一端）。
  const handleMoveEndpoint = useCallback(async (entityId: string, entityType: MatrixEntityKind, spanIndex: number, end: 'start' | 'end', chapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entityType) {
        case 'conflict': {
          const c = useNovelDataStore.getState().conflicts.find((x) => x.id === entityId)
          if (!c) return
          const span = c.chapterSpans[spanIndex]
          if (!span) return
          // 反转保护：clamp 到同段范围内
          const nextStart = end === 'start' ? Math.min(chapter, span[1]) : span[0]
          const nextEnd = end === 'end' ? Math.max(chapter, span[0]) : span[1]
          const newSpans = c.chapterSpans.map((sp, i) => i === spanIndex ? [nextStart, nextEnd] as [number, number] : sp)
          const updated = await updateConflict(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertConflict(updated)
          invalidateNovelData()
          break
        }
        case 'faction': {
          const f = useNovelDataStore.getState().factions.find((x) => x.id === entityId)
          if (!f) return
          const span = f.chapterSpans[spanIndex]
          if (!span) return
          const nextStart = end === 'start' ? Math.min(chapter, span[1]) : span[0]
          const nextEnd = end === 'end' ? Math.max(chapter, span[0]) : span[1]
          const newSpans = f.chapterSpans.map((sp, i) => i === spanIndex ? [nextStart, nextEnd] as [number, number] : sp)
          const updated = await updateFaction(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertFaction(updated)
          invalidateNovelData()
          break
        }
        case 'item': {
          const it = useNovelDataStore.getState().items.find((x) => x.id === entityId)
          if (!it) return
          const spans = it.chapterSpans ?? []
          const span = spans[spanIndex]
          if (!span) return
          const nextStart = end === 'start' ? Math.min(chapter, span[1]) : span[0]
          const nextEnd = end === 'end' ? Math.max(chapter, span[0]) : span[1]
          const newSpans = spans.map((sp, i) => i === spanIndex ? [nextStart, nextEnd] as [number, number] : sp)
          const updated = await updateItem(entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertItem(updated)
          invalidateNovelData()
          break
        }
        case 'foreshadow': {
          // 伏笔端点拖拽移动完整 beat，保留该节点的 note。
          const f = useNovelDataStore.getState().foreshadows.find((x) => x.id === entityId)
          if (!f) return
          const existing = getForeshadowBeats(f)
          let beats = existing
          if (end === 'start') {
            // 拖动 plant：不能超过 payoff（若已回收），否则不超过现有最大章节
            const maxStart = f.recoverByChapter != null
              ? Math.max(1, f.recoverByChapter - 1)
              : Math.max(20, ...chapters.map((c) => c.chapterNumber), 1)
            beats = moveForeshadowEndpointBeat(existing, 'plant', Math.min(chapter, maxStart))
          } else {
            // 拖动 payoff：必须晚于 plant，避免两个端点落在同章时覆盖节点
            const minEnd = (f.firstChapter ?? 0) + 1
            beats = moveForeshadowEndpointBeat(existing, 'payoff', Math.max(chapter, minEnd))
          }
          const updated = await updateForeshadow(entityId, { beats })
          useNovelDataStore.getState().upsertForeshadow(updated)
          invalidateNovelData()
          break
        }
      }
    } catch (err) {
      console.error('[MatrixWorkspace] 移动端点失败:', err)
    }
  }, [currentProjectId, chapters, queryClient])

  // ── 拖动整段色带：保持跨度时长平移；与其他段相交时自动合并 ──
  const handleMoveSpan = useCallback(async (
    entityId: string,
    entityType: 'conflict' | 'faction' | 'item',
    spanIndex: number,
    startChapter: number,
    endChapter: number,
  ): Promise<void> => {
    if (!currentProjectId) return
    try {
      if (entityType === 'conflict') {
        const entity = useNovelDataStore.getState().conflicts.find((item) => item.id === entityId)
        if (!entity?.chapterSpans[spanIndex]) return
        const otherSpans = entity.chapterSpans.filter((_, index) => index !== spanIndex)
        const chapterSpans = mergeSpanIntoList(otherSpans, [startChapter, endChapter])
        const updated = await updateConflict(entityId, { chapterSpans })
        useNovelDataStore.getState().upsertConflict(updated)
      } else if (entityType === 'faction') {
        const entity = useNovelDataStore.getState().factions.find((item) => item.id === entityId)
        if (!entity?.chapterSpans[spanIndex]) return
        const otherSpans = entity.chapterSpans.filter((_, index) => index !== spanIndex)
        const chapterSpans = mergeSpanIntoList(otherSpans, [startChapter, endChapter])
        const updated = await updateFaction(entityId, { chapterSpans })
        useNovelDataStore.getState().upsertFaction(updated)
      } else {
        const entity = useNovelDataStore.getState().items.find((item) => item.id === entityId)
        if (!entity?.chapterSpans?.[spanIndex]) return
        const otherSpans = entity.chapterSpans.filter((_, index) => index !== spanIndex)
        const chapterSpans = mergeSpanIntoList(otherSpans, [startChapter, endChapter])
        const updated = await updateItem(entityId, { chapterSpans })
        useNovelDataStore.getState().upsertItem(updated)
      }
      invalidateNovelData()
    } catch (err) {
      console.error('[MatrixWorkspace] 移动跨度失败:', err)
      toastError('移动范围失败', err instanceof Error ? err.message : String(err))
    }
  }, [currentProjectId, queryClient])

  // ── 拖动已出场单元格（character/location）换章 ──
  // 语义：从 fromChapter 移除、在 toChapter 新增。用 useNovelDataStore.getState() 取最新数据避免闭包陈旧。
  const handleMoveCell = useCallback(async (entityId: string, entityType: MatrixEntityKind, fromChapter: number, toChapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entityType) {
        case 'character': {
          // 先创建新记录，成功后再删除旧记录：创建失败时旧记录仍在，避免数据丢失
          // （后端 batchCreateCharacterHistory 是单次请求，整体成功或整体失败）
          const created = await batchCreateCharacterHistory(currentProjectId, [{ characterId: entityId, chapterNumber: toChapter }])
          // 创建成功后再删除旧记录；await 后重新取最新 state 避免闭包陈旧
          const freshAfterCreate = useNovelDataStore.getState().characterHistory
          const oldRecords = freshAfterCreate.filter((h) => h.characterId === entityId && h.chapterNumber === fromChapter)
          for (const r of oldRecords) {
            await deleteCharacterHistory(currentProjectId, r.id)
          }
          // 重新取最新 state 计算最终值，避免 await 期间并发修改被覆盖
          const freshAfterDelete = useNovelDataStore.getState().characterHistory
          const next = freshAfterDelete
            .filter((h) => !(h.characterId === entityId && h.chapterNumber === fromChapter))
            .concat(created)
          setCharacterHistory(next)
          invalidateNovelData()
          break
        }
        case 'location': {
          const loc = useNovelDataStore.getState().locations.find((l) => l.id === entityId)
          if (!loc) return
          const set = new Set(loc.appearChapters ?? [])
          set.delete(fromChapter)
          set.add(toChapter)
          const next = Array.from(set).sort((a, b) => a - b)
          const updated = await updateLocation(entityId, { appearChapters: next })
          useNovelDataStore.getState().upsertLocation(updated)
          invalidateNovelData()
          break
        }
      }
    } catch (err) {
      console.error('[MatrixWorkspace] 移动出场失败:', err)
    }
  }, [currentProjectId, setCharacterHistory, queryClient])

  // ── C-4b 修改批注：查找已有 clip-note marker ──
  const handleEditNote = useCallback((entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number) => {
    if (entityType === 'foreshadow') {
      const foreshadow = useNovelDataStore.getState().foreshadows.find((item) => item.id === entityId)
      const beat = foreshadow ? getForeshadowBeats(foreshadow).find((item) => item.chapter === chapter) : undefined
      if (!beat) return
      const legacyMarker = markers.find(
        (marker) => marker.type === 'clip-note' && marker.entityId === entityId,
      )
      setNoteDialog({
        scope: 'foreshadow-beat',
        entityId,
        entityName,
        entityType,
        chapter,
        beatType: beat.type,
        initialNote: beat.note ?? legacyMarker?.note ?? '',
        existingMarkerId: legacyMarker?.id ?? null,
      })
      return
    }
    const existing = markers.find(
      (m) => m.type === 'clip-note' && m.entityId === entityId,
    )
    setNoteDialog({
      scope: 'entity',
      entityId,
      entityName,
      entityType,
      chapter,
      beatType: null,
      initialNote: existing?.note ?? '',
      existingMarkerId: existing?.id ?? null,
    })
  }, [markers])

  const handleSubmitNote = useCallback(async (note: string): Promise<void> => {
    if (!currentProjectId || !noteDialog) return
    try {
      if (noteDialog.scope === 'foreshadow-beat') {
        const foreshadow = useNovelDataStore.getState().foreshadows.find((item) => item.id === noteDialog.entityId)
        if (!foreshadow) throw new Error('伏笔不存在或已被删除')
        const beats = setForeshadowBeatNote(
          getForeshadowBeats(foreshadow),
          noteDialog.chapter,
          note,
        )
        const updated = await updateForeshadow(noteDialog.entityId, { beats })
        useNovelDataStore.getState().upsertForeshadow(updated)
        // 旧版本把伏笔批注存在 clip-note marker。首次保存节点内容时完成惰性迁移，
        // 避免同一内容在实体行和节点格重复展示。
        if (noteDialog.existingMarkerId) {
          try {
            await deleteMarker(noteDialog.existingMarkerId)
            removeMarker(noteDialog.existingMarkerId)
          } catch (migrationError) {
            // 节点内容已经保存成功，旧 marker 清理失败不应把主操作报告为失败。
            console.warn('[MatrixWorkspace] 清理旧伏笔批注失败:', migrationError)
          }
        }
      } else if (noteDialog.existingMarkerId) {
        const updated = await updateMarker(noteDialog.existingMarkerId, { note })
        upsertMarker(updated)
      } else {
        const created = await createMarker(currentProjectId, {
          chapter: noteDialog.chapter,
          title: noteDialog.entityName,
          note,
          type: 'clip-note',
          entityType: noteDialog.entityType,
          entityId: noteDialog.entityId,
        })
        upsertMarker(created)
      }
      invalidateNovelData()
    } catch (err) {
      console.error('[MatrixWorkspace] 保存批注失败:', err)
      throw err
    }
  }, [currentProjectId, noteDialog, upsertMarker, removeMarker, queryClient])

  // ── C-4a 双击色带 / 右键「编辑范围」：通用实体跨度编辑 ──
  // 双击色带直接拿到 MatrixEntity；右键菜单通过 (entityId, entityType) 在 matrixData 里查到
  const openSpanDialog = useCallback((entity: MatrixEntity) => {
    if (entity.kind === 'world_element' || entity.kind === 'foreshadow') return
    setSpanDialog({ entity })
  }, [])

  // 右键菜单入口：由 (entityId, entityType) 反查 MatrixEntity 后打开对话框
  const handleEditSpanFromMenu = useCallback((entityId: string, _entityName: string, entityType: MatrixEntityKind) => {
    if (entityType === 'world_element' || entityType === 'foreshadow') return
    const entity = matrixData.groups
      .flatMap((g) => g.entities)
      .find((e) => e.entityId === entityId && e.kind === entityType)
    if (entity) openSpanDialog(entity)
  }, [matrixData.groups, openSpanDialog])

  const handleSubmitSpan = useCallback(async (entity: MatrixEntity, firstChapter: number, lastChapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entity.kind) {
        case 'conflict': {
          // 合并而非覆盖：把与 [firstChapter, lastChapter] 相交的现有段合并为新段，
          // 保留不相交的段。避免对话框编辑单段时静默丢失其他段。
          const existing = entity.chapterSpans ?? []
          const newSpans = mergeSpanIntoList(existing, [firstChapter, lastChapter])
          const updated = await updateConflict(entity.entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertConflict(updated)
          break
        }
        case 'clue': {
          const existing = entity.chapterSpans ?? []
          const chapterSpans = mergeSpanIntoList(existing, [firstChapter, lastChapter])
          const updated = await updateClue(entity.entityId, { chapterSpans })
          useNovelDataStore.getState().upsertClue(updated)
          break
        }
        case 'faction': {
          const existing = entity.chapterSpans ?? []
          const newSpans = mergeSpanIntoList(existing, [firstChapter, lastChapter])
          const updated = await updateFaction(entity.entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertFaction(updated)
          break
        }
        case 'item': {
          const existing = entity.chapterSpans ?? []
          const newSpans = mergeSpanIntoList(existing, [firstChapter, lastChapter])
          const updated = await updateItem(entity.entityId, { chapterSpans: newSpans })
          useNovelDataStore.getState().upsertItem(updated)
          break
        }
        case 'foreshadow': {
          // first → firstChapter（埋设点，事实）；last → recoverByChapter（计划回收章，意图）
          // 不再传 status：状态由后端从 beats 单向派生。
          // 旧实现这里硬写 status:'recovered'，等于用户拖一下跨度就把伏笔标成已回收，
          // 进而被 generateAndArrange 永久排除出后续编排。
          const updated = await updateForeshadow(entity.entityId, {
            firstChapter,
            recoverByChapter: lastChapter,
          })
          useNovelDataStore.getState().upsertForeshadow(updated)
          break
        }
        case 'character': {
          // 在 [first, last] 范围每章保留/创建 characterHistory，移除范围外的
          const inRange = characterHistory.filter(
            (h) => h.characterId === entity.entityId && h.chapterNumber != null && h.chapterNumber >= firstChapter && h.chapterNumber <= lastChapter,
          )
          const outRange = characterHistory.filter(
            (h) => h.characterId === entity.entityId && h.chapterNumber != null && (h.chapterNumber < firstChapter || h.chapterNumber > lastChapter),
          )
          // 删除范围外的
          for (const r of outRange) {
            await deleteCharacterHistory(currentProjectId, r.id)
          }
          // 创建范围内不存在的
          const existingChs = new Set(inRange.map((h) => h.chapterNumber))
          const toCreate: { characterId: string; chapterNumber: number }[] = []
          for (let ch = firstChapter; ch <= lastChapter; ch++) {
            if (!existingChs.has(ch)) {
              toCreate.push({ characterId: entity.entityId, chapterNumber: ch })
            }
          }
          if (toCreate.length > 0) {
            const created = await batchCreateCharacterHistory(currentProjectId, toCreate)
            setCharacterHistory([...inRange, ...created, ...characterHistory.filter((h) => h.characterId !== entity.entityId)])
          } else {
            setCharacterHistory([
              ...inRange,
              ...characterHistory.filter((h) => h.characterId !== entity.entityId),
            ])
          }
          break
        }
        case 'location': {
          // [first, last] 范围填满 appearChapters，移除范围外的章
          const rangeChs: number[] = []
          for (let ch = firstChapter; ch <= lastChapter; ch++) rangeChs.push(ch)
          const updated = await updateLocation(entity.entityId, { appearChapters: rangeChs })
          useNovelDataStore.getState().upsertLocation(updated)
          break
        }
        case 'world_element':
          break
      }
      invalidateNovelData()
    } catch (err) {
      console.error('[MatrixWorkspace] 保存跨度失败:', err)
      toastError('保存跨度失败', err instanceof Error ? err.message : String(err))
      throw err
    }
  }, [currentProjectId, queryClient, characterHistory, setCharacterHistory])

  // ── 分组空白右键：新建实体 ──
  const handleContextMenuGroupEmpty = useCallback((kind: MatrixEntityKind) => {
    setCreateDialog({ kind, chapter: null })
  }, [])

  const handleCreateEntity = useCallback(async (kind: MatrixEntityKind, data: { name?: string; description?: string; firstChapter?: number | null; aiFields?: import('@/api/novel-client').GeneratedEntityResult }): Promise<void> => {
    if (!currentProjectId) return
    const firstChapter = data.firstChapter ?? null
    const ai = data.aiFields
    switch (kind) {
      case 'character': {
        const input = ai?.type === 'character'
          ? {
              name: ai.data.name,
              description: ai.data.description,
              identity: ai.data.identity,
              personality: ai.data.personality,
              appearance: ai.data.appearance,
              currentState: ai.data.currentState,
              currentGoal: ai.data.currentGoal,
              currentPressure: ai.data.currentPressure,
              secret: ai.data.secret,
              arcStage: ai.data.arcStage,
              speechStyle: ai.data.speechStyle,
            }
          : { name: data.name ?? '' }
        const created = await createCharacter(currentProjectId, input)
        useNovelDataStore.getState().upsertCharacter(created)
        invalidateNovelData()
        break
      }
      case 'conflict': {
        const input = ai?.type === 'conflict'
          ? {
              description: ai.data.description,
              type: ai.data.type,
              intensity: ai.data.intensity,
              stage: ai.data.stage,
              tier: ai.data.tier,
              chapterSpans: firstChapter != null ? [[firstChapter, firstChapter] as [number, number]] : [],
              climaxChapter: ai.data.climaxChapter ?? undefined,
              climaxType: ai.data.climaxType ?? undefined,
              stakes: ai.data.stakes ?? undefined,
              twistPotential: ai.data.twistPotential,
            }
          : {
              description: data.description ?? '',
              type: 'inner' as const,
              chapterSpans: firstChapter != null ? [[firstChapter, firstChapter] as [number, number]] : [],
            }
        const created = await createConflict(currentProjectId, input)
        useNovelDataStore.getState().upsertConflict(created)
        invalidateNovelData()
        break
      }
      case 'clue': {
        const created = await createClue(currentProjectId, {
          description: data.description ?? '',
          pointsTo: '',
          chapterSpans: firstChapter != null ? [[firstChapter, firstChapter]] : [],
        })
        useNovelDataStore.getState().upsertClue(created)
        invalidateNovelData()
        break
      }
      case 'foreshadow': {
        const input = ai?.type === 'foreshadow'
          ? {
              description: ai.data.description,
              category: ai.data.category,
              status: ai.data.status,
              firstChapter,
            }
          : {
              description: data.description ?? '',
              firstChapter,
            }
        const created = await createForeshadow(currentProjectId, input)
        useNovelDataStore.getState().upsertForeshadow(created)
        invalidateNovelData()
        break
      }
      case 'faction': {
        const input = ai?.type === 'faction'
          ? {
              name: ai.data.name,
              description: ai.data.description,
              type: ai.data.type,
              ideology: ai.data.ideology,
              strength: ai.data.strength,
              resources: ai.data.resources,
              allies: ai.data.allies,
              enemies: ai.data.enemies,
              status: ai.data.status,
              chapterSpans: firstChapter != null ? [[firstChapter, firstChapter] as [number, number]] : [],
            }
          : {
              name: data.name ?? '',
              chapterSpans: firstChapter != null ? [[firstChapter, firstChapter] as [number, number]] : [],
            }
        const created = await createFaction(currentProjectId, input)
        useNovelDataStore.getState().upsertFaction(created)
        invalidateNovelData()
        break
      }
      case 'location': {
        const input = ai?.type === 'location'
          ? {
              name: ai.data.name,
              description: ai.data.description,
              type: ai.data.type,
              significance: ai.data.significance,
              status: ai.data.status,
              firstChapter,
              appearChapters: firstChapter != null ? [firstChapter] : [],
            }
          : {
              name: data.name ?? '',
              firstChapter,
              appearChapters: firstChapter != null ? [firstChapter] : [],
            }
        const created = await createLocation(currentProjectId, input)
        useNovelDataStore.getState().upsertLocation(created)
        invalidateNovelData()
        break
      }
      case 'item': {
        const input = ai?.type === 'item'
          ? {
              name: ai.data.name,
              description: ai.data.description,
              type: ai.data.type,
              ownerId: ai.data.ownerId,
              status: ai.data.status,
              abilities: ai.data.abilities,
              origin: ai.data.origin,
              firstChapter,
              chapterSpans: firstChapter != null ? [[firstChapter, firstChapter] as [number, number]] : [],
            }
          : {
              name: data.name ?? '',
              firstChapter,
              chapterSpans: firstChapter != null ? [[firstChapter, firstChapter] as [number, number]] : [],
            }
        const created = await createItem(currentProjectId, input)
        useNovelDataStore.getState().upsertItem(created)
        invalidateNovelData()
        break
      }
      case 'world_element': {
        const input = ai?.type === 'world_element'
          ? {
              category: ai.data.category,
              name: ai.data.name,
              description: ai.data.description,
              attributes: ai.data.attributes,
            }
          : {
              name: data.name ?? '',
              category: 'history' as const,
            }
        const created = await createWorldElement(currentProjectId, input)
        useNovelDataStore.getState().upsertWorldElement(created)
        invalidateNovelData()
        break
      }
    }
  }, [currentProjectId, queryClient])

  // ── 当前章节标题（用于 toolbar badge）──
  const currentChapterTitle = useMemo(() => {
    const ch = chapters.find((c) => c.chapterNumber === effectivePlayheadChapter)
    return ch?.title ?? ''
  }, [chapters, effectivePlayheadChapter])

  return (
    <div className="flex h-full flex-col bg-surface-1">
      <div data-tour="matrix-toolbar">
        <MatrixToolbar
          playheadChapter={effectivePlayheadChapter}
          totalChapters={Math.max(chapters.length, matrixData.maxChapter)}
          currentChapterTitle={currentChapterTitle}
          cellWidth={cellWidth}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onCellWidthChange={handleCellWidthChange}
          completableCount={completableCount}
          isCompleting={isCompleting}
          onCompleteHistory={handleCompleteHistory}
          canUndo={undoCount > 0}
          canRedo={redoCount > 0}
          onUndo={undo}
          onRedo={redo}
          activeFilter={activeFilter}
          onFilterChange={handleFilterChange}
          onSimilarityScan={onSimilarityScan}
          similarityScanning={similarityScanning}
          showRelationshipOverlay={showRelationshipOverlay}
          onToggleRelationshipOverlay={() => setShowRelationshipOverlay((v) => !v)}
        />
        {/* 剧情轨道 / 待审实体（矩阵视图入口，与画布工具栏并列） */}
        <div className="flex items-center gap-1 px-2 pb-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={() => setTrackPanelOpen(true)}
            disabled={!currentProjectId}
            title="查看故事线如何被逐章推进（剧情推进轨道）"
          >
            <GitBranch className="size-3.5" />
            剧情轨道
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={() => setCandidatePanelOpen(true)}
            disabled={!currentProjectId}
            title="查看 Memory 提出、待确认的新冲突/线索候选"
          >
            <ShieldQuestion className="size-3.5" />
            待审实体
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={() => setPendingEventsOpen(true)}
            disabled={!currentProjectId}
            title="确认或驳回 AI 自动提取的故事事件"
          >
            <Inbox className="size-3.5" />
            待确认事件
            {pendingCount > 0 && (
              <span className="ml-0.5 rounded-full bg-amber-500/90 px-1.5 text-[10px] font-semibold leading-4 text-white">
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={() => setAnnotationsOpen(true)}
            disabled={!currentProjectId}
            title="统一批注：说明、意图、待办、警告、疑问"
          >
            <MessageSquareText className="size-3.5" />
            批注
          </Button>
        </div>
        <NarrativeTrackPanel open={trackPanelOpen} onOpenChange={setTrackPanelOpen} projectId={currentProjectId} />
        <EntityCandidatePanel open={candidatePanelOpen} onOpenChange={setCandidatePanelOpen} projectId={currentProjectId} />
        <PendingEventsDialog
          open={pendingEventsOpen}
          onOpenChange={setPendingEventsOpen}
          projectId={currentProjectId}
          onPendingCountChange={setPendingCount}
        />
        <AnnotationPanelDialog
          open={annotationsOpen}
          onOpenChange={setAnnotationsOpen}
          projectId={currentProjectId}
        />
      </div>

      <div data-tour="matrix-legend">
        <MatrixLegend
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          hasExpandedSubtracks={expandedEntityIds.length > 0}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden" data-tour="matrix-view">
        <MatrixView
          matrixData={matrixData}
          chapters={chapters}
          markers={markers}
          relationships={relationships}
          aggregationChanges={aggregationChanges}
          aggregationEventEdges={aggregationEventEdges}
          playheadChapter={effectivePlayheadChapter}
          cellWidth={cellWidth}
          collapsedGroups={collapsedGroups}
          activeFilter={activeFilter}
          selectedNodeId={selectedNodeId}
          selectedMatrixEntityIds={selectedMatrixEntityIds}
          onSelectEntity={handleSelectEntity}
          onToggleCollapse={handleToggleCollapse}
          onPlayheadChange={handlePlayheadChange}
          onToggleEntityExpand={handleToggleEntityFocus}
          onCellWidthChange={handleCellWidthChange}
          onContextMenuChapter={handleContextMenuChapter}
          onContextMenuCell={handleContextMenuCell}
          onContextMenuGroupEmpty={handleContextMenuGroupEmpty}
          onEditEntity={handleEditEntity}
          onEditSpan={openSpanDialog}
          onDropEntity={handleMarkPresent}
          onMoveEndpoint={handleMoveEndpoint}
          onMoveSpan={handleMoveSpan}
          onMoveCell={handleMoveCell}
          onTogglePresent={handleTogglePresent}
          expandedEntityIds={expandedEntityIds}
          showRelationshipOverlay={showRelationshipOverlay}
          searchQuery={searchQuery}
        />
      </div>

      {/* 悬浮卡单例：全矩阵 data-hc-* 元素统一生效 */}
      <MatrixHoverCard />

      <ChapterContextMenu
        position={contextMenu}
        creationRunning={creationRunning}
        onClose={() => setContextMenu(null)}
        onGenerate={handleGenerateFromMenu}
        onRegenerate={handleRegenerateFromMenu}
        onView={handleViewChapter}
        onDelete={(id) => void handleDeleteChapter(id)}
      />

      <EntityCellMenu
        position={cellMenu}
        onClose={() => setCellMenu(null)}
        onMarkPresent={(eid, kind, ch) => void handleMarkPresent(eid, kind, ch)}
        onRemovePresent={(eid, kind, ch) => void handleRemovePresent(eid, kind, ch)}
        onEditNote={handleEditNote}
        onEditSpan={handleEditSpanFromMenu}
        onRemoveSpan={(eid, kind, ch) => void handleRemoveSpan(eid, kind, ch)}
        onMarkForeshadowBeat={(eid, ch, type, editAfterCreate) => void handleMarkForeshadowBeat(eid, ch, type, editAfterCreate)}
      />

      <EntityCreateDialog
        open={createDialog != null}
        entityType={createDialog?.kind ?? null}
        defaultChapter={createDialog?.chapter ?? null}
        onClose={() => setCreateDialog(null)}
        onSubmit={(kind, data) => handleCreateEntity(kind, data)}
      />

      <EntitySpanDialog
        open={spanDialog != null}
        entity={spanDialog?.entity ?? null}
        maxChapter={matrixData.maxChapter}
        onClose={() => setSpanDialog(null)}
        onSubmit={(entity, first, last) => handleSubmitSpan(entity, first, last)}
      />

      <EntityNoteDialog
        open={noteDialog != null}
        entityId={noteDialog?.entityId ?? null}
        entityName={noteDialog?.entityName ?? null}
        entityType={noteDialog?.entityType ?? null}
        chapter={noteDialog?.chapter ?? null}
        initialNote={noteDialog?.initialNote ?? ''}
        existingMarkerId={noteDialog?.existingMarkerId ?? null}
        noteScope={noteDialog?.scope ?? 'entity'}
        foreshadowBeatType={noteDialog?.beatType ?? null}
        onClose={() => setNoteDialog(null)}
        onSubmit={(note) => handleSubmitNote(note)}
      />
    </div>
  )
}

// 暴露 GROUP_ORDER 供外部潜在使用
export { GROUP_ORDER }
