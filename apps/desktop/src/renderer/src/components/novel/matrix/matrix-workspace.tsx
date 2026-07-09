/**
 * MatrixWorkspace：矩阵视图工作区
 *
 * 整合 MatrixToolbar + MatrixView + ChapterContextMenu
 * 提供过滤、缩放、折叠、补全历史、播放头联动、章节右键菜单
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNovelStore } from '@/stores/novel-store'
import {
  batchCreateCharacterHistory,
  createCharacter,
  createConflict,
  createFaction,
  createForeshadow,
  createLocation,
  createMarker,
  createWorldElement,
  deleteCharacterHistory,
  deleteChapter,
  listMarkers,
  updateConflict,
  updateFaction,
  updateForeshadow,
  updateLocation,
  updateMarker,
} from '@/api/novel-client'
import { buildGroups, buildPool, findSpanAt, GROUP_ORDER, type MatrixEntity, type MatrixEntityKind } from './matrix-logic'
import { MatrixToolbar } from './matrix-toolbar'
import { MatrixView } from './matrix-view'
import { MatrixLegend } from './matrix-legend'
import { ChapterContextMenu, type ChapterContextMenuPosition } from './chapter-context-menu'
import { EntityCellMenu, type EntityCellMenuPosition } from './entity-cell-menu'
import { EntityCreateDialog } from './entity-create-dialog'
import { EntitySpanDialog } from './entity-span-dialog'
import { EntityNoteDialog } from './entity-note-dialog'
import { toastError } from '@/hooks/use-toast'

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

export interface MatrixWorkspaceProps {
  creationRunning?: boolean
  creationChapterNumber?: number
  onRegenerateChapter?: (chapterNumber: number) => void
  onStartCreationAt?: (chapterNumber: number) => void
  /** LLM 相似度扫描：语义相似智能合并 */
  onSimilarityScan?: () => void
  similarityScanning?: boolean
}

const DEFAULT_CELL_WIDTH = 36
const MIN_CELL_WIDTH = 24
const MAX_CELL_WIDTH = 56
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
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const characters = useNovelStore((s) => s.characters)
  const chapters = useNovelStore((s) => s.chapters)
  const conflicts = useNovelStore((s) => s.conflicts)
  const foreshadows = useNovelStore((s) => s.foreshadows)
  const factions = useNovelStore((s) => s.factions)
  const locations = useNovelStore((s) => s.locations)
  const worldElements = useNovelStore((s) => s.worldElements)
  const characterHistory = useNovelStore((s) => s.characterHistory)
  const relationships = useNovelStore((s) => s.relationships)
  const markers = useNovelStore((s) => s.markers)
  const setMarkers = useNovelStore((s) => s.setMarkers)
  const selectNode = useNovelStore((s) => s.selectNode)
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const playheadChapter = useNovelStore((s) => s.playheadChapter)
  const setPlayheadChapter = useNovelStore((s) => s.setPlayheadChapter)
  const removeChapter = useNovelStore((s) => s.removeChapter)
  const setCharacterHistory = useNovelStore((s) => s.setCharacterHistory)
  // ── C-3 折叠分组从 store 共享（与 NovelSidebar 联动）──
  const collapsedGroupsArr = useNovelStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useNovelStore((s) => s.toggleCollapsedGroup)
  const upsertMarker = useNovelStore((s) => s.upsertMarker)
  // ── Undo/Redo（与 MatrixToolbar 联动）──
  const undoCount = useNovelStore((s) => s.undoCount)
  const redoCount = useNovelStore((s) => s.redoCount)
  const undo = useNovelStore((s) => s.undo)
  const redo = useNovelStore((s) => s.redo)

  // ── 本地 UI 状态 ──
  const [cellWidth, setCellWidth] = useState(DEFAULT_CELL_WIDTH)
  const collapsedGroups = useMemo(() => new Set(collapsedGroupsArr as MatrixEntityKind[]), [collapsedGroupsArr])
  const [activeFilter, setActiveFilter] = useState<MatrixEntityKind | null>(null)
  const [isCompleting, setIsCompleting] = useState(false)
  const [contextMenu, setContextMenu] = useState<ChapterContextMenuPosition | null>(null)
  const [cellMenu, setCellMenu] = useState<EntityCellMenuPosition | null>(null)
  const [createDialog, setCreateDialog] = useState<{ kind: MatrixEntityKind; chapter: number | null } | null>(null)
  const [spanDialog, setSpanDialog] = useState<{ entity: MatrixEntity } | null>(null)
  const [noteDialog, setNoteDialog] = useState<{
    entityId: string
    entityName: string
    entityType: MatrixEntityKind
    chapter: number
    initialNote: string
    existingMarkerId: string | null
  } | null>(null)

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

  // ── 矩阵数据 ──
  const matrixData = useMemo(
    () => buildGroups({
      chapters, characters, conflicts, foreshadows, factions, locations, worldElements,
      characterHistory, markers,
    }),
    [chapters, characters, conflicts, foreshadows, factions, locations, worldElements, characterHistory, markers],
  )

  // ── 元素池（补全历史用）──
  const pool = useMemo(
    () => buildPool({ characters, conflicts, foreshadows, factions, locations, characterHistory }),
    [characters, conflicts, foreshadows, factions, locations, characterHistory],
  )

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

  const handleToggleCollapse = useCallback((kind: MatrixEntityKind) => {
    toggleCollapsedGroup(kind)
  }, [toggleCollapsedGroup])

  const handleFilterChange = useCallback((filter: MatrixEntityKind | null) => {
    setActiveFilter((prev) => (prev === filter ? null : filter))
  }, [])

  const handleSelectEntity = useCallback(
    (entityType: MatrixEntityKind, entityId: string): void => {
      selectNode(entityId, entityType)
    },
    [selectNode],
  )

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
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
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
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
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
        const c = useNovelStore.getState().conflicts.find((x) => x.id === entityId)
        if (!c) return
        const span = findSpanAt(c.chapterSpans, chapter)
        if (span == null) return
        const newSpans = c.chapterSpans.filter((sp) => sp !== span)
        const updated = await updateConflict(entityId, { chapterSpans: newSpans })
        useNovelStore.getState().upsertConflict(updated)
      } else {
        const f = useNovelStore.getState().factions.find((x) => x.id === entityId)
        if (!f) return
        const span = findSpanAt(f.chapterSpans, chapter)
        if (span == null) return
        const newSpans = f.chapterSpans.filter((sp) => sp !== span)
        const updated = await updateFaction(entityId, { chapterSpans: newSpans })
        useNovelStore.getState().upsertFaction(updated)
      }
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
    } catch (err) {
      console.error('[MatrixWorkspace] 删除该段范围失败:', err)
    }
  }, [currentProjectId, queryClient])

  // ── 单元格右键菜单：标记/删除出场（按 entityType 语义化适配） ──
  // - character：操作 characterHistory 关联表（batchCreate / delete）
  // - conflict/faction：扩展或收缩 firstChapter/lastChapter 端点（中间格不可删）
  // - foreshadow：右键设 firstChapter（埋设点）或 recoverByChapter（回收点）
  // - location：操作 appearChapters 数组
  // - world_element：恒全程出现，不可标记
  const isCellEditable = useCallback((kind: MatrixEntityKind): boolean => {
    return kind !== 'world_element'
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
      case 'faction': {
        const f = factions.find((x) => x.id === entityId)
        if (!f) return false
        return f.chapterSpans.some(([s, e]) => chapter >= s && chapter <= e)
      }
      case 'foreshadow': {
        const f = foreshadows.find((x) => x.id === entityId)
        if (!f || f.firstChapter == null) return false
        const recover = f.recoverByChapter
        if (recover == null) return chapter === f.firstChapter
        return chapter === f.firstChapter || chapter === recover
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
  }, [characterHistory, conflicts, factions, foreshadows, locations])

  /** 该单元格是否支持「删除出场」操作（端点型实体中间格不可删） */
  const isCellRemovable = useCallback((entityId: string, kind: MatrixEntityKind, chapter: number): boolean => {
    switch (kind) {
      case 'conflict':
      case 'faction': {
        const e = kind === 'conflict'
          ? conflicts.find((x) => x.id === entityId)
          : factions.find((x) => x.id === entityId)
        if (!e) return false
        // 用 findSpanAt 定位 chapter 所在段，仅段首/段尾可删（中间格不可挖洞）
        const span = findSpanAt(e.chapterSpans, chapter)
        if (span == null) return false
        return chapter === span[0] || chapter === span[1]
      }
      default:
        return true
    }
  }, [conflicts, factions])

  const handleContextMenuCell = useCallback((entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => {
    const editable = isCellEditable(entityType)
    const present = editable && isCellPresent(entityId, entityType, chapter)
    const removable = editable && present && isCellRemovable(entityId, entityType, chapter)
    // foreshadow 动态状态：根据 firstChapter / recoverByChapter 判断下一步动作
    let foreshadowState: 'unplanted' | 'planted' | 'recoverable' | undefined
    if (entityType === 'foreshadow') {
      const f = foreshadows.find((x) => x.id === entityId)
      if (!f || f.firstChapter == null) foreshadowState = 'unplanted'
      else if (f.recoverByChapter == null) foreshadowState = chapter > f.firstChapter ? 'planted' : 'unplanted'
      else foreshadowState = chapter === f.recoverByChapter ? 'recoverable' : (chapter > f.firstChapter ? 'planted' : 'unplanted')
    }
    setCellMenu({ x, y, entityId, entityName, entityType, chapter, present, editable, removable, foreshadowState })
  }, [isCellEditable, isCellPresent, isCellRemovable, foreshadows])

  const handleMarkPresent = useCallback(async (entityId: string, entityType: MatrixEntityKind, chapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entityType) {
        case 'character': {
          // 用 batchCreateCharacterHistory 写入一条 chapterNumber 记录（reason 标注手动）
          // useNovelStore.getState() 取最新数据，避免闭包陈旧导致覆盖丢失记录
          const created = await batchCreateCharacterHistory(currentProjectId, [{ characterId: entityId, chapterNumber: chapter }])
          const fresh = useNovelStore.getState().characterHistory
          setCharacterHistory([...fresh, ...created])
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'conflict': {
          // 用 useNovelStore.getState() 取最新数据，避免闭包陈旧导致覆盖丢失段
          const c = useNovelStore.getState().conflicts.find((x) => x.id === entityId)
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
          useNovelStore.getState().upsertConflict(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'faction': {
          // 用 useNovelStore.getState() 取最新数据，避免闭包陈旧
          const f = useNovelStore.getState().factions.find((x) => x.id === entityId)
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
          useNovelStore.getState().upsertFaction(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'foreshadow': {
          const f = foreshadows.find((x) => x.id === entityId)
          if (!f) {
            console.warn('[MatrixWorkspace] foreshadow 拖入：未找到伏笔', entityId)
            return
          }
          // 拖入伏笔到矩阵的语义（与左键单击 handleTogglePresent 保持一致并扩展移动端点）：
          // - 未放置（firstChapter null）→ 设埋设点
          // - 已埋设未回收，拖到埋设点之后 → 设回收点
          // - 已埋设未回收，拖到埋设点之前或同章 → 移动埋设点到该章
          // - 已回收，拖到新位置 → 移动离该章最近的端点（埋设点/回收点）
          if (f.firstChapter == null) {
            const updated = await updateForeshadow(entityId, { firstChapter: chapter, status: 'planted' })
            useNovelStore.getState().upsertForeshadow(updated)
          } else if (f.recoverByChapter == null && chapter > f.firstChapter) {
            const updated = await updateForeshadow(entityId, { recoverByChapter: chapter, status: 'recovered' })
            useNovelStore.getState().upsertForeshadow(updated)
          } else if (f.recoverByChapter == null) {
            // 未回收，拖到埋设点之前或同章 → 移动埋设点
            const updated = await updateForeshadow(entityId, { firstChapter: chapter })
            useNovelStore.getState().upsertForeshadow(updated)
          } else {
            // 已回收：移动离 chapter 最近的端点
            const distPlant = Math.abs(chapter - f.firstChapter!)
            const distPayoff = Math.abs(chapter - f.recoverByChapter)
            if (distPlant <= distPayoff) {
              const updated = await updateForeshadow(entityId, { firstChapter: chapter })
              useNovelStore.getState().upsertForeshadow(updated)
            } else {
              const updated = await updateForeshadow(entityId, { recoverByChapter: chapter })
              useNovelStore.getState().upsertForeshadow(updated)
            }
          }
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'location': {
          const loc = locations.find((l) => l.id === entityId)
          if (!loc) return
          const next = Array.from(new Set([...(loc.appearChapters ?? []), chapter])).sort((a, b) => a - b)
          const updated = await updateLocation(entityId, { appearChapters: next })
          useNovelStore.getState().upsertLocation(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'world_element':
          break
      }
    } catch (err) {
      console.error('[MatrixWorkspace] 标记出场失败:', err)
    }
  }, [currentProjectId, characterHistory, conflicts, factions, foreshadows, locations, setCharacterHistory, queryClient])

  const handleRemovePresent = useCallback(async (entityId: string, entityType: MatrixEntityKind, chapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entityType) {
        case 'character': {
          // 找出该角色在该章的所有 history 记录，逐条删除
          // useNovelStore.getState() 取最新数据，避免闭包陈旧
          const fresh = useNovelStore.getState().characterHistory
          const records = fresh.filter((h) => h.characterId === entityId && h.chapterNumber === chapter)
          for (const r of records) {
            await deleteCharacterHistory(currentProjectId, r.id)
          }
          if (records.length > 0) {
            const after = useNovelStore.getState().characterHistory
            setCharacterHistory(after.filter((h) => !records.some((r) => r.id === h.id)))
            void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          }
          break
        }
        case 'conflict': {
          // 用 useNovelStore.getState() 取最新数据，避免闭包陈旧
          const c = useNovelStore.getState().conflicts.find((x) => x.id === entityId)
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
          useNovelStore.getState().upsertConflict(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'faction': {
          // 用 useNovelStore.getState() 取最新数据，避免闭包陈旧
          const f = useNovelStore.getState().factions.find((x) => x.id === entityId)
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
          useNovelStore.getState().upsertFaction(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'foreshadow': {
          const f = foreshadows.find((x) => x.id === entityId)
          if (!f) return
          if (chapter === f.firstChapter) {
            const updated = await updateForeshadow(entityId, { firstChapter: null })
            useNovelStore.getState().upsertForeshadow(updated)
          } else if (chapter === f.recoverByChapter) {
            const updated = await updateForeshadow(entityId, { recoverByChapter: null, status: 'planted' })
            useNovelStore.getState().upsertForeshadow(updated)
          }
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'location': {
          const loc = locations.find((l) => l.id === entityId)
          if (!loc) return
          const next = (loc.appearChapters ?? []).filter((c) => c !== chapter)
          const updated = await updateLocation(entityId, { appearChapters: next })
          useNovelStore.getState().upsertLocation(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'world_element':
          break
      }
    } catch (err) {
      console.error('[MatrixWorkspace] 删除出场失败:', err)
      toastError('删除出场失败', err instanceof Error ? err.message : String(err))
    }
  }, [currentProjectId, characterHistory, conflicts, factions, foreshadows, locations, setCharacterHistory, queryClient])

  // ── 左键单元格：智能切换出场状态（实体类型自适应）──
  // - character/location：空→标记出场 / 已出场→删除出场
  // - conflict/faction：空→扩展端点 / 端点→收缩端点 / 中段→无操作（schema 闭区间不支持挖洞）
  // - foreshadow：未埋设→设埋设点 / 已埋设未回收→设回收点 / 埋设点→取消埋设 / 回收点→取消回收
  // - world_element：恒全程，不操作
  const handleTogglePresent = useCallback(async (entity: MatrixEntity, chapter: number): Promise<void> => {
    const kind = entity.kind
    if (kind === 'world_element') return

    let action: 'mark' | 'remove' | 'none' = 'none'
    if (kind === 'foreshadow') {
      const f = foreshadows.find((x) => x.id === entity.entityId)
      if (!f) return
      const plant = f.firstChapter
      const payoff = f.recoverByChapter
      if (plant != null && chapter === plant) action = 'remove' // 取消埋设点
      else if (payoff != null && chapter === payoff) action = 'remove' // 取消回收点
      else if (plant == null) action = 'mark' // 设埋设点
      else if (payoff == null && chapter > plant) action = 'mark' // 设回收点
      // else：跨度中段且已设回收 → none（用右键编辑范围移动）
    } else {
      const present = isCellPresent(entity.entityId, kind, chapter)
      const removable = isCellRemovable(entity.entityId, kind, chapter)
      if (!present) action = 'mark'
      else if (removable) action = 'remove'
      // present && !removable（冲突/势力跨度中段）→ none
    }

    if (action === 'mark') {
      await handleMarkPresent(entity.entityId, kind, chapter)
    } else if (action === 'remove') {
      await handleRemovePresent(entity.entityId, kind, chapter)
    }
  }, [foreshadows, isCellPresent, isCellRemovable, handleMarkPresent, handleRemovePresent])

  // ── 拖动跨度端点（conflict/faction/foreshadow）调整起止章节 ──
  // 语义：拖动端点到新章节列，移动该端点；conflict/faction 按 spanIndex 定位目标段，
  // 反转保护：start 不能超过同段 end，end 不能低于同段 start（clamp 而非扩展另一端）。
  const handleMoveEndpoint = useCallback(async (entityId: string, entityType: MatrixEntityKind, spanIndex: number, end: 'start' | 'end', chapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entityType) {
        case 'conflict': {
          const c = useNovelStore.getState().conflicts.find((x) => x.id === entityId)
          if (!c) return
          const span = c.chapterSpans[spanIndex]
          if (!span) return
          // 反转保护：clamp 到同段范围内
          const nextStart = end === 'start' ? Math.min(chapter, span[1]) : span[0]
          const nextEnd = end === 'end' ? Math.max(chapter, span[0]) : span[1]
          const newSpans = c.chapterSpans.map((sp, i) => i === spanIndex ? [nextStart, nextEnd] as [number, number] : sp)
          const updated = await updateConflict(entityId, { chapterSpans: newSpans })
          useNovelStore.getState().upsertConflict(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'faction': {
          const f = useNovelStore.getState().factions.find((x) => x.id === entityId)
          if (!f) return
          const span = f.chapterSpans[spanIndex]
          if (!span) return
          const nextStart = end === 'start' ? Math.min(chapter, span[1]) : span[0]
          const nextEnd = end === 'end' ? Math.max(chapter, span[0]) : span[1]
          const newSpans = f.chapterSpans.map((sp, i) => i === spanIndex ? [nextStart, nextEnd] as [number, number] : sp)
          const updated = await updateFaction(entityId, { chapterSpans: newSpans })
          useNovelStore.getState().upsertFaction(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'foreshadow': {
          // 迁移 055：伏笔改为多段跨度后，endpoint 拖动调整 chapterSpans
          // - 拖动 span 段 start/end → 更新该段 chapterSpans（参照 conflict/faction）
          // - 同时保持 plant/payoff 语义同步：
          //   * 若拖动第一段 start 且 plant == 原 start → firstChapter 跟随新 start
          //   * 若拖动最后一段 end 且 payoff == 原 end → recoverByChapter 跟随新 end
          //   * 若拖动最后一段 end 到新章节且原 payoff 为 null → 设 recoverByChapter = 新 end（标记回收）
          // 反转保护：clamp 到同段范围内
          const f = useNovelStore.getState().foreshadows.find((x) => x.id === entityId)
          if (!f) return
          const span = f.chapterSpans[spanIndex]
          if (!span) return
          const nextStart = end === 'start' ? Math.min(chapter, span[1]) : span[0]
          const nextEnd = end === 'end' ? Math.max(chapter, span[0]) : span[1]
          const newSpans = f.chapterSpans.map((sp, i) => i === spanIndex ? [nextStart, nextEnd] as [number, number] : sp)
          // 计算 plant/payoff 同步
          const patch: { chapterSpans: Array<[number, number]>; firstChapter?: number; recoverByChapter?: number | null; status?: 'recovered' } = { chapterSpans: newSpans }
          const isFirstSpan = spanIndex === 0
          const isLastSpan = spanIndex === f.chapterSpans.length - 1
          if (isFirstSpan && end === 'start' && f.firstChapter === span[0]) {
            patch.firstChapter = nextStart
          }
          if (isLastSpan && end === 'end') {
            if (f.recoverByChapter === span[1]) {
              // payoff 原本对齐该段 end → 跟随新 end
              patch.recoverByChapter = nextEnd
            } else if (f.recoverByChapter == null && nextEnd > span[1]) {
              // payoff 原本为 null（待回收）且用户把 end 拖到更远章节 → 标记回收
              patch.recoverByChapter = nextEnd
              patch.status = 'recovered'
            }
          }
          const updated = await updateForeshadow(entityId, patch)
          useNovelStore.getState().upsertForeshadow(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
      }
    } catch (err) {
      console.error('[MatrixWorkspace] 移动端点失败:', err)
    }
  }, [currentProjectId, queryClient])

  // ── 拖动已出场单元格（character/location）换章 ──
  // 语义：从 fromChapter 移除、在 toChapter 新增。用 useNovelStore.getState() 取最新数据避免闭包陈旧。
  const handleMoveCell = useCallback(async (entityId: string, entityType: MatrixEntityKind, fromChapter: number, toChapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entityType) {
        case 'character': {
          // 先创建新记录，成功后再删除旧记录：创建失败时旧记录仍在，避免数据丢失
          // （后端 batchCreateCharacterHistory 是单次请求，整体成功或整体失败）
          const created = await batchCreateCharacterHistory(currentProjectId, [{ characterId: entityId, chapterNumber: toChapter }])
          // 创建成功后再删除旧记录；await 后重新取最新 state 避免闭包陈旧
          const freshAfterCreate = useNovelStore.getState().characterHistory
          const oldRecords = freshAfterCreate.filter((h) => h.characterId === entityId && h.chapterNumber === fromChapter)
          for (const r of oldRecords) {
            await deleteCharacterHistory(currentProjectId, r.id)
          }
          // 重新取最新 state 计算最终值，避免 await 期间并发修改被覆盖
          const freshAfterDelete = useNovelStore.getState().characterHistory
          const next = freshAfterDelete
            .filter((h) => !(h.characterId === entityId && h.chapterNumber === fromChapter))
            .concat(created)
          setCharacterHistory(next)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'location': {
          const loc = useNovelStore.getState().locations.find((l) => l.id === entityId)
          if (!loc) return
          const set = new Set(loc.appearChapters ?? [])
          set.delete(fromChapter)
          set.add(toChapter)
          const next = Array.from(set).sort((a, b) => a - b)
          const updated = await updateLocation(entityId, { appearChapters: next })
          useNovelStore.getState().upsertLocation(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
      }
    } catch (err) {
      console.error('[MatrixWorkspace] 移动出场失败:', err)
    }
  }, [currentProjectId, setCharacterHistory, queryClient])

  // ── C-4b 修改批注：查找已有 clip-note marker ──
  const handleEditNote = useCallback((entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number) => {
    const existing = markers.find(
      (m) => m.type === 'clip-note' && m.entityId === entityId,
    )
    setNoteDialog({
      entityId,
      entityName,
      entityType,
      chapter,
      initialNote: existing?.note ?? '',
      existingMarkerId: existing?.id ?? null,
    })
  }, [markers])

  const handleSubmitNote = useCallback(async (note: string): Promise<void> => {
    if (!currentProjectId || !noteDialog) return
    try {
      if (noteDialog.existingMarkerId) {
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
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
    } catch (err) {
      console.error('[MatrixWorkspace] 保存批注失败:', err)
      throw err
    }
  }, [currentProjectId, noteDialog, upsertMarker, queryClient])

  // ── C-4a 双击色带 / 右键「编辑范围」：通用实体跨度编辑 ──
  // 双击色带直接拿到 MatrixEntity；右键菜单通过 (entityId, entityType) 在 matrixData 里查到
  const openSpanDialog = useCallback((entity: MatrixEntity) => {
    if (entity.kind === 'world_element') return
    setSpanDialog({ entity })
  }, [])

  // 右键菜单入口：由 (entityId, entityType) 反查 MatrixEntity 后打开对话框
  const handleEditSpanFromMenu = useCallback((entityId: string, _entityName: string, entityType: MatrixEntityKind) => {
    if (entityType === 'world_element') return
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
          useNovelStore.getState().upsertConflict(updated)
          break
        }
        case 'faction': {
          const existing = entity.chapterSpans ?? []
          const newSpans = mergeSpanIntoList(existing, [firstChapter, lastChapter])
          const updated = await updateFaction(entity.entityId, { chapterSpans: newSpans })
          useNovelStore.getState().upsertFaction(updated)
          break
        }
        case 'foreshadow': {
          // first → firstChapter（埋设点）；last → recoverByChapter（回收点）
          const updated = await updateForeshadow(entity.entityId, {
            firstChapter,
            recoverByChapter: lastChapter,
            status: lastChapter >= firstChapter ? 'recovered' : undefined,
          })
          useNovelStore.getState().upsertForeshadow(updated)
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
          useNovelStore.getState().upsertLocation(updated)
          break
        }
        case 'world_element':
          break
      }
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
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
        useNovelStore.getState().upsertCharacter(created)
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
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
        useNovelStore.getState().upsertConflict(created)
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
        break
      }
      case 'foreshadow': {
        const input = ai?.type === 'foreshadow'
          ? {
              description: ai.data.description,
              category: ai.data.category,
              status: ai.data.status,
              linkedCharacters: ai.data.linkedCharacters,
              linkedClues: ai.data.linkedClues,
              firstChapter,
            }
          : {
              description: data.description ?? '',
              firstChapter,
            }
        const created = await createForeshadow(currentProjectId, input)
        useNovelStore.getState().upsertForeshadow(created)
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
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
        useNovelStore.getState().upsertFaction(created)
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
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
        useNovelStore.getState().upsertLocation(created)
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
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
        useNovelStore.getState().upsertWorldElement(created)
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
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
      <MatrixToolbar
        playheadChapter={effectivePlayheadChapter}
        totalChapters={Math.max(chapters.length, matrixData.maxChapter)}
        currentChapterTitle={currentChapterTitle}
        cellWidth={cellWidth}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
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
      />

      <MatrixLegend />

      <div className="flex-1 min-h-0 overflow-hidden">
        <MatrixView
          chapters={chapters}
          characters={characters}
          conflicts={conflicts}
          foreshadows={foreshadows}
          factions={factions}
          locations={locations}
          worldElements={worldElements}
          characterHistory={characterHistory}
          relationships={relationships}
          markers={markers}
          playheadChapter={effectivePlayheadChapter}
          cellWidth={cellWidth}
          collapsedGroups={collapsedGroups}
          activeFilter={activeFilter}
          selectedNodeId={selectedNodeId}
          onSelectEntity={handleSelectEntity}
          onToggleCollapse={handleToggleCollapse}
          onPlayheadChange={handlePlayheadChange}
          onContextMenuChapter={handleContextMenuChapter}
          onContextMenuCell={handleContextMenuCell}
          onContextMenuGroupEmpty={handleContextMenuGroupEmpty}
          onEditSpan={openSpanDialog}
          onDropEntity={handleMarkPresent}
          onMoveEndpoint={handleMoveEndpoint}
          onMoveCell={handleMoveCell}
          onTogglePresent={handleTogglePresent}
        />
      </div>

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
        onClose={() => setNoteDialog(null)}
        onSubmit={(note) => handleSubmitNote(note)}
      />
    </div>
  )
}

// 暴露 GROUP_ORDER 供外部潜在使用
export { GROUP_ORDER }
