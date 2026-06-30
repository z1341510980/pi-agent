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
import { buildGroups, buildPool, GROUP_ORDER, type MatrixEntity, type MatrixEntityKind } from './matrix-logic'
import { MatrixToolbar } from './matrix-toolbar'
import { MatrixView } from './matrix-view'
import { MatrixLegend } from './matrix-legend'
import { ChapterContextMenu, type ChapterContextMenuPosition } from './chapter-context-menu'
import { EntityCellMenu, type EntityCellMenuPosition } from './entity-cell-menu'
import { EntityCreateDialog } from './entity-create-dialog'
import { EntitySpanDialog } from './entity-span-dialog'
import { EntityNoteDialog } from './entity-note-dialog'

export interface MatrixWorkspaceProps {
  creationRunning?: boolean
  creationChapterNumber?: number
  onRegenerateChapter?: (chapterNumber: number) => void
  onStartCreationAt?: (chapterNumber: number) => void
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

  // ── 本地 UI 状态 ──
  const [cellWidth, setCellWidth] = useState(DEFAULT_CELL_WIDTH)
  const collapsedGroups = useMemo(() => new Set(collapsedGroupsArr), [collapsedGroupsArr])
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
        if (!c || c.firstChapter == null) return false
        const last = c.lastChapter ?? c.firstChapter
        return chapter >= c.firstChapter && chapter <= last
      }
      case 'faction': {
        const f = factions.find((x) => x.id === entityId)
        if (!f || f.firstChapter == null) return false
        const last = f.lastChapter ?? f.firstChapter
        return chapter >= f.firstChapter && chapter <= last
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
        if (!e || e.firstChapter == null) return false
        const last = e.lastChapter ?? e.firstChapter
        // 仅首尾端点可删，中间格不可删（schema 闭区间不支持挖洞）
        return chapter === e.firstChapter || chapter === last
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
          const created = await batchCreateCharacterHistory(currentProjectId, [{ characterId: entityId, chapterNumber: chapter }])
          setCharacterHistory([...characterHistory, ...created])
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'conflict': {
          const c = conflicts.find((x) => x.id === entityId)
          if (!c) return
          const nextFirst = c.firstChapter == null ? chapter : Math.min(c.firstChapter, chapter)
          const nextLast = c.lastChapter == null ? chapter : Math.max(c.lastChapter, chapter)
          if (nextFirst === c.firstChapter && nextLast === c.lastChapter) return
          const updated = await updateConflict(entityId, { firstChapter: nextFirst, lastChapter: nextLast })
          useNovelStore.getState().upsertConflict(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'faction': {
          const f = factions.find((x) => x.id === entityId)
          if (!f) return
          const nextFirst = f.firstChapter == null ? chapter : Math.min(f.firstChapter, chapter)
          const nextLast = f.lastChapter == null ? chapter : Math.max(f.lastChapter, chapter)
          if (nextFirst === f.firstChapter && nextLast === f.lastChapter) return
          const updated = await updateFaction(entityId, { firstChapter: nextFirst, lastChapter: nextLast })
          useNovelStore.getState().upsertFaction(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'foreshadow': {
          const f = foreshadows.find((x) => x.id === entityId)
          if (!f) return
          // 若未埋设，设为埋设点；若已埋设但未回收，设为回收点
          if (f.firstChapter == null) {
            const updated = await updateForeshadow(entityId, { firstChapter: chapter })
            useNovelStore.getState().upsertForeshadow(updated)
          } else if (f.recoverByChapter == null && chapter > f.firstChapter) {
            const updated = await updateForeshadow(entityId, { recoverByChapter: chapter, status: 'recovered' })
            useNovelStore.getState().upsertForeshadow(updated)
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
          const records = characterHistory.filter((h) => h.characterId === entityId && h.chapterNumber === chapter)
          for (const r of records) {
            await deleteCharacterHistory(currentProjectId, r.id)
          }
          if (records.length > 0) {
            setCharacterHistory(characterHistory.filter((h) => !records.some((r) => r.id === h.id)))
            void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          }
          break
        }
        case 'conflict': {
          const c = conflicts.find((x) => x.id === entityId)
          if (!c || c.firstChapter == null) return
          const last = c.lastChapter ?? c.firstChapter
          let nextFirst = c.firstChapter
          let nextLast = last
          if (chapter === c.firstChapter && c.firstChapter < last) {
            nextFirst = c.firstChapter + 1
          } else if (chapter === last && c.firstChapter < last) {
            nextLast = last - 1
          } else if (c.firstChapter === last && chapter === c.firstChapter) {
            // 仅一章范围，整体清除
            nextFirst = null as number | null
            nextLast = null as number | null
          } else {
            return // 中间格不可删
          }
          const updated = await updateConflict(entityId, { firstChapter: nextFirst, lastChapter: nextLast })
          useNovelStore.getState().upsertConflict(updated)
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
          break
        }
        case 'faction': {
          const f = factions.find((x) => x.id === entityId)
          if (!f || f.firstChapter == null) return
          const last = f.lastChapter ?? f.firstChapter
          let nextFirst = f.firstChapter
          let nextLast = last
          if (chapter === f.firstChapter && f.firstChapter < last) {
            nextFirst = f.firstChapter + 1
          } else if (chapter === last && f.firstChapter < last) {
            nextLast = last - 1
          } else if (f.firstChapter === last && chapter === f.firstChapter) {
            nextFirst = null as number | null
            nextLast = null as number | null
          } else {
            return
          }
          const updated = await updateFaction(entityId, { firstChapter: nextFirst, lastChapter: nextLast })
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
    }
  }, [currentProjectId, characterHistory, conflicts, factions, foreshadows, locations, setCharacterHistory, queryClient])

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
  const handleEditSpan = useCallback((entity: MatrixEntity) => {
    if (entity.kind === 'world_element') return
    setSpanDialog({ entity })
  }, [])

  // 右键菜单入口：通过 entityId 找到 MatrixEntity 再打开对话框
  const handleEditSpanFromMenu = useCallback((entityId: string, _entityName: string, entityType: MatrixEntityKind) => {
    if (entityType === 'world_element') return
    const entity = matrixData.groups
      .flatMap((g) => g.entities)
      .find((e) => e.entityId === entityId && e.kind === entityType)
    if (entity) setSpanDialog({ entity })
  }, [matrixData.groups])

  const handleSubmitSpan = useCallback(async (entity: MatrixEntity, firstChapter: number, lastChapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      switch (entity.kind) {
        case 'conflict': {
          const updated = await updateConflict(entity.entityId, { firstChapter, lastChapter })
          useNovelStore.getState().upsertConflict(updated)
          break
        }
        case 'faction': {
          const updated = await updateFaction(entity.entityId, { firstChapter, lastChapter })
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
            (h) => h.characterId === entity.entityId && h.chapterNumber >= firstChapter && h.chapterNumber <= lastChapter,
          )
          const outRange = characterHistory.filter(
            (h) => h.characterId === entity.entityId && (h.chapterNumber < firstChapter || h.chapterNumber > lastChapter),
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
              participants: ai.data.participants,
              firstChapter,
              lastChapter: firstChapter,
            }
          : {
              description: data.description ?? '',
              type: 'inner' as const,
              firstChapter,
              lastChapter: firstChapter,
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
              firstChapter,
              lastChapter: firstChapter,
            }
          : {
              name: data.name ?? '',
              firstChapter,
              lastChapter: firstChapter,
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
        activeFilter={activeFilter}
        onFilterChange={handleFilterChange}
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
          onEditSpan={handleEditSpan}
          onDropEntity={handleMarkPresent}
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
