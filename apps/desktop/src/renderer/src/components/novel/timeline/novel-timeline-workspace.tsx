/**
 * NovelTimelineWorkspace：小说时间轴编辑器主容器
 *
 * 集成自研 TimelineEditor 组件（剪辑编辑器风格），提供：
 * - 章节号显示
 * - 撤销/重做系统
 * - 多选 + 框选
 * - 元素池拖入
 * - 片段拖动/删除
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNovelStore } from '@/stores/novel-store'
import {
  batchCreateCharacterHistory,
  createCharacterHistory,
  deleteChapter,
  deleteCharacterHistory,
  updateConflict,
  updateForeshadow,
  updateFaction,
  updateLocation,
  listMarkers,
  createMarker,
  updateMarker,
  deleteMarker,
} from '@/api/novel-client'
import { useTimelineData, type TimelineClip, type TimelineTrack } from './use-timeline-data'
import { rangeToRestore, type EditAction } from './timeline-logic'
import { ElementPool, POOL_DRAG_MIME, type PoolDragPayload } from './element-pool'
import {
  TimelineToolbar,
  ZOOM_WIDTH,
  DEFAULT_FILTER,
  type ZoomLevel,
  type TimelineFilter,
} from './timeline-toolbar'
import {
  ChapterContextMenu,
  type ChapterContextMenuPosition,
} from './chapter-context-menu'
import { ClipContextMenu, type ClipContextMenuPosition } from './clip-context-menu'
import { TrackContextMenu, type TrackContextMenuPosition, type TrackHeightLevel } from './track-context-menu'
import { MarkerContextMenu } from './marker-context-menu'
import { MarkerEditDialog } from './marker-edit-dialog'
import { ClipNoteDialog } from './clip-note-dialog'
import { TimelineEditor } from './timeline-editor'
import type { TimelineMarker } from './timeline-markers'
import './timeline-styles.css'

export interface NovelTimelineWorkspaceProps {
  creationRunning?: boolean
  creationChapterNumber?: number
  onCancelCreation?: () => void
  onRegenerateChapter?: (chapterNumber: number) => void
  onStartCreationAt?: (chapterNumber: number) => void
}

// ── 撤销/重做类型 ──
// EditAction 类型从 ./timeline-logic 导入（支持 move/delete/paste/cut）

interface HistoryState {
  past: EditAction[]
  future: EditAction[]
}

// ── 工具：从 location clip id 提取索引 ──
function getLocationClipIndex(clipId: string): number {
  const parts = clipId.split(':')
  const idx = parts.length > 2 ? Number(parts[2]) : 0
  return Number.isNaN(idx) ? 0 : idx
}

// ── 主组件 ──

export function NovelTimelineWorkspace({
  creationRunning = false,
  creationChapterNumber,
  onRegenerateChapter,
  onStartCreationAt,
}: NovelTimelineWorkspaceProps): ReactElement {
  const queryClient = useQueryClient()
  const canvasRef = useRef<HTMLDivElement | null>(null)

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
  const selectNode = useNovelStore((s) => s.selectNode)
  const upsertConflict = useNovelStore((s) => s.upsertConflict)
  const upsertForeshadow = useNovelStore((s) => s.upsertForeshadow)
  const upsertFaction = useNovelStore((s) => s.upsertFaction)
  const upsertLocation = useNovelStore((s) => s.upsertLocation)
  const removeChapter = useNovelStore((s) => s.removeChapter)
  const setCharacterHistory = useNovelStore((s) => s.setCharacterHistory)
  const addCharacterHistory = useNovelStore((s) => s.addCharacterHistory)
  const removeCharacterHistory = useNovelStore((s) => s.removeCharacterHistory)
  const markers = useNovelStore((s) => s.markers)
  const setMarkers = useNovelStore((s) => s.setMarkers)
  const upsertMarker = useNovelStore((s) => s.upsertMarker)
  const removeMarker = useNovelStore((s) => s.removeMarker)

  // ── 本地 UI 状态 ──
  const [zoom, setZoom] = useState<ZoomLevel>('standard')
  const [chapterWidth, setChapterWidth] = useState(ZOOM_WIDTH.standard)
  const [filter, setFilter] = useState<TimelineFilter>(DEFAULT_FILTER)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isCompleting, setIsCompleting] = useState(false)
  const [contextMenu, setContextMenu] = useState<ChapterContextMenuPosition | null>(null)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set())
  const [dropIndicatorChapter, setDropIndicatorChapter] = useState<number | null>(null)
  const playheadChapter = useNovelStore((s) => s.playheadChapter)
  const setPlayheadChapter = useNovelStore((s) => s.setPlayheadChapter)
  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] })
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenuPosition | null>(null)
  const [trackContextMenu, setTrackContextMenu] = useState<TrackContextMenuPosition | null>(null)
  const [trackHeightLevel, setTrackHeightLevel] = useState<TrackHeightLevel>('standard')
  // A7：轨道 lock/hide/solo/mute 状态提升到 workspace，与 trackHeightLevel 一致，
  // 由 TrackContextMenu 与 TimelineEditor 共享（受控）。
  const [hiddenTracks, setHiddenTracks] = useState<Set<string>>(new Set())
  const [lockedTracks, setLockedTracks] = useState<Set<string>>(new Set())
  const [soloedTrack, setSoloedTrack] = useState<string | null>(null)
  const [mutedTracks, setMutedTracks] = useState<Set<string>>(new Set())
  const [collapsedTracks, setCollapsedTracks] = useState<Set<string>>(new Set())
  const [clipboard, setClipboard] = useState<TimelineClip[] | null>(null)
  const [showRelations, setShowRelations] = useState(false)
  const [markerContextMenu, setMarkerContextMenu] = useState<{ marker: TimelineMarker; x: number; y: number } | null>(null)
  const [editingMarker, setEditingMarker] = useState<TimelineMarker | null>(null)
  const [noteDialogClip, setNoteDialogClip] = useState<TimelineClip | null>(null)

  // 撤销重做历史引用（避免 stale closure）
  const historyRef = useRef(history)
  historyRef.current = history

  // ── 应用过滤器后的数据 ──
  const filteredData = useMemo(() => ({
    characters: filter.character ? characters : [],
    chapters,
    conflicts: filter.conflict ? conflicts : [],
    foreshadows: filter.foreshadow ? foreshadows : [],
    factions: filter.faction ? factions : [],
    locations: filter.location ? locations : [],
    worldElements: filter.worldElement ? worldElements : [],
    characterHistory,
    markers,
  }), [filter, characters, chapters, conflicts, foreshadows, factions, locations, worldElements, characterHistory, markers])

  const { tracks, poolCharacters, poolConflicts, poolForeshadows, poolFactions, poolLocations } =
    useTimelineData(filteredData)

  // ── 最大章节号 ──
  const maxChapter = useMemo(() => {
    if (chapters.length === 0) return 20
    return Math.max(...chapters.map((c) => c.chapterNumber), 20)
  }, [chapters])

  // ── 播放头章节号（创作流程联动优先）──
  const effectivePlayheadChapter = creationRunning && creationChapterNumber != null
    ? creationChapterNumber
    : playheadChapter

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
        console.error('[NovelTimelineWorkspace] 加载标记失败:', err)
      })
    return () => {
      cancelled = true
    }
  }, [currentProjectId, setMarkers])

  // ── 播放头变更回调 ──
  const handlePlayheadChange = useCallback((chapter: number) => {
    if (creationRunning) return
    setPlayheadChapter(chapter)
  }, [creationRunning])

  // ── 缩放 ──
  const handleZoomChange = useCallback((newZoom: ZoomLevel) => {
    setZoom(newZoom)
    setChapterWidth(ZOOM_WIDTH[newZoom])
  }, [])

  const handleChapterWidthChange = useCallback((width: number) => {
    setChapterWidth(width)
    // 根据宽度自动归类 zoom 标签
    if (width <= ZOOM_WIDTH.compact + 30) setZoom('compact')
    else if (width <= ZOOM_WIDTH.standard + 50) setZoom('standard')
    else setZoom('detailed')
  }, [])

  // ── 选中实体回调 ──
  const handleSelectEntity = useCallback(
    (entityType: TimelineClip['entityType'], entityId: string): void => {
      selectNode(entityId, entityType)
    },
    [selectNode],
  )

  const handleSelectClipsChange = useCallback((clipIds: Set<string>) => {
    setSelectedClipIds(clipIds)
  }, [])

  // ── 右键章节刻度 ──
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

  // ── 记录编辑历史 ──
  const pushHistory = useCallback((action: EditAction) => {
    setHistory((prev) => ({
      past: [...prev.past, action].slice(-50), // 最多 50 条
      future: [], // 新操作清空重做栈
    }))
  }, [])

  // ── 更新实体范围 ──
  const updateEntityRange = useCallback(
    async (clip: EditAction['clip'], start: number, end: number): Promise<void> => {
      if (!currentProjectId) return
      const firstChapter = Math.max(1, Math.round(start))
      const lastChapter = Math.max(firstChapter, Math.round(end))
      try {
        switch (clip.entityType) {
          case 'character': {
            const exists = characterHistory.some(
              (h) => h.characterId === clip.entityId && h.chapterNumber === firstChapter,
            )
            if (!exists) {
              const newHistory = await createCharacterHistory(currentProjectId, clip.entityId, {
                fieldName: 'currentState',
                oldValue: null,
                newValue: '【时间轴调整】角色出场章节记录',
                reason: `时间轴拖拽：第 ${firstChapter} 章`,
                chapterNumber: firstChapter,
              })
              addCharacterHistory(newHistory)
            }
            void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
            break
          }
          case 'conflict': {
            const conflict = conflicts.find((c) => c.id === clip.entityId)
            if (!conflict) break
            const updated = await updateConflict(conflict.id, {
              firstChapter,
              lastChapter: lastChapter === firstChapter ? null : lastChapter,
            })
            upsertConflict(updated)
            break
          }
          case 'foreshadow': {
            const foreshadow = foreshadows.find((f) => f.id === clip.entityId)
            if (!foreshadow) break
            const updated = await updateForeshadow(foreshadow.id, {
              firstChapter,
              recoverByChapter: lastChapter === firstChapter ? null : lastChapter,
            })
            upsertForeshadow(updated)
            break
          }
          case 'faction': {
            const faction = factions.find((f) => f.id === clip.entityId)
            if (!faction) break
            const updated = await updateFaction(faction.id, {
              firstChapter,
              lastChapter: lastChapter === firstChapter ? null : lastChapter,
            })
            upsertFaction(updated)
            break
          }
          case 'location': {
            const location = locations.find((l) => l.id === clip.entityId)
            if (!location) break
            const idx = getLocationClipIndex(clip.id)
            const next = [...(location.appearChapters ?? [])]
            if (idx >= 0 && idx < next.length) {
              next[idx] = firstChapter
            } else if (idx === next.length) {
              next.push(firstChapter)
            }
            const unique = Array.from(new Set(next)).sort((a, b) => a - b)
            const updated = await updateLocation(location.id, { appearChapters: unique })
            upsertLocation(updated)
            break
          }
          case 'world_element':
            break
        }
      } catch (err) {
        console.error('[NovelTimelineWorkspace] 更新区间失败:', err)
      }
    },
    [
      currentProjectId, characterHistory, conflicts, foreshadows, factions, locations,
      addCharacterHistory, upsertConflict, upsertForeshadow, upsertFaction, upsertLocation, queryClient,
    ],
  )

  // ── 片段移动/调整（记录历史）──
  const handleClipMove = useCallback(
    (clip: TimelineClip, newStart: number, newEnd: number): void => {
      pushHistory({
        type: 'move',
        clip: { ...clip },
        before: { start: clip.startChapter, end: clip.endChapter },
        after: { start: newStart, end: newEnd },
      })
      void updateEntityRange(clip, newStart, newEnd)
    },
    [pushHistory, updateEntityRange],
  )

  // ── 片段删除 ──
  const handleClipDelete = useCallback(
    async (clipId: string, opts?: { skipHistory?: boolean }): Promise<void> => {
      const clip = tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
      if (!clip || !currentProjectId) return
      const before = { start: clip.startChapter, end: clip.endChapter }
      try {
        switch (clip.entityType) {
          case 'character': {
            // 删除该章节的角色历史记录
            const records = characterHistory.filter(
              (h) => h.characterId === clip.entityId,
            )
            for (const rec of records) {
              if (rec.chapterNumber != null && rec.chapterNumber >= clip.startChapter && rec.chapterNumber <= clip.endChapter) {
                await deleteCharacterHistory(currentProjectId, rec.id)
                removeCharacterHistory(rec.id)
              }
            }
            break
          }
          case 'conflict': {
            const conflict = conflicts.find((c) => c.id === clip.entityId)
            if (!conflict) break
            const updated = await updateConflict(conflict.id, {
              firstChapter: null,
              lastChapter: null,
            })
            upsertConflict(updated)
            break
          }
          case 'foreshadow': {
            const foreshadow = foreshadows.find((f) => f.id === clip.entityId)
            if (!foreshadow) break
            const updated = await updateForeshadow(foreshadow.id, {
              firstChapter: null,
              recoverByChapter: null,
            })
            upsertForeshadow(updated)
            break
          }
          case 'faction': {
            const faction = factions.find((f) => f.id === clip.entityId)
            if (!faction) break
            const updated = await updateFaction(faction.id, {
              firstChapter: null,
              lastChapter: null,
            })
            upsertFaction(updated)
            break
          }
          case 'location': {
            const location = locations.find((l) => l.id === clip.entityId)
            if (!location) break
            const idx = getLocationClipIndex(clip.id)
            const next = (location.appearChapters ?? []).filter((_, i) => i !== idx)
            const updated = await updateLocation(location.id, { appearChapters: next })
            upsertLocation(updated)
            break
          }
          case 'world_element':
            break
        }
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
        // 入栈：删除后区间为空（start>end），撤销时恢复 before
        // skipHistory 时跳过入栈（如 cut 已由 cut 类型独占入栈，避免重复）
        if (!opts?.skipHistory) {
          pushHistory({
            type: 'delete',
            clip: { ...clip },
            before,
            after: { start: 0, end: -1 },
          })
        }
        // 从选择集中移除
        setSelectedClipIds((prev) => {
          const next = new Set(prev)
          next.delete(clipId)
          return next
        })
      } catch (err) {
        console.error('[NovelTimelineWorkspace] 删除片段失败:', err)
      }
    },
    [tracks, currentProjectId, characterHistory, conflicts, foreshadows, factions, locations,
      removeCharacterHistory, upsertConflict, upsertForeshadow, upsertFaction, upsertLocation, queryClient, pushHistory,
      updateEntityRange],
  )

  // ── 批量删除选中 ──
  const handleDeleteSelected = useCallback(async () => {
    const ids = Array.from(selectedClipIds)
    await Promise.all(ids.map((id) => handleClipDelete(id).catch((err) => {
      console.error('[NovelTimelineWorkspace] 批量删除单项失败:', err)
    })))
  }, [selectedClipIds, handleClipDelete])

  // ── 复制/剪切/粘贴 ──
  const handleCopyClip = useCallback((clip: TimelineClip) => {
    setClipboard([clip])
  }, [])

  const handleCutClip = useCallback((clip: TimelineClip) => {
    setClipboard([clip])
    pushHistory({
      type: 'cut',
      clip: { ...clip },
      before: { start: clip.startChapter, end: clip.endChapter },
      after: { start: 0, end: -1 },
    })
    // cut 已独占入栈，删除步骤跳过入栈避免重复
    void handleClipDelete(clip.id, { skipHistory: true })
  }, [handleClipDelete, pushHistory])

  const handlePasteClips = useCallback(() => {
    if (!clipboard || clipboard.length === 0) return
    // 在播放头位置粘贴，保持相对偏移
    const actions: EditAction[] = []
    for (const clip of clipboard) {
      const origDuration = clip.endChapter - clip.startChapter
      const newStart = playheadChapter
      const newEnd = newStart + origDuration
      actions.push({
        type: 'paste',
        clip: { ...clip },
        before: { start: clip.startChapter, end: clip.endChapter },
        after: { start: newStart, end: newEnd },
      })
      void updateEntityRange(clip, newStart, newEnd)
    }
    for (const a of actions) pushHistory(a)
  }, [clipboard, playheadChapter, updateEntityRange, pushHistory])

  // ── 对齐到播放头 ──
  const handleAlignToPlayhead = useCallback((clip: TimelineClip) => {
    const duration = clip.endChapter - clip.startChapter
    const newStart = playheadChapter
    const newEnd = newStart + duration
    pushHistory({
      type: 'move',
      clip: { ...clip },
      before: { start: clip.startChapter, end: clip.endChapter },
      after: { start: newStart, end: newEnd },
    })
    void updateEntityRange(clip, newStart, newEnd)
  }, [playheadChapter, pushHistory, updateEntityRange])

  // ── 双击片段：编辑批注（单击跳转详情面板已由 onSelectEntity 处理）──
  const handleClipDoubleClick = useCallback((clip: TimelineClip) => {
    setNoteDialogClip(clip)
  }, [])

  // ── 右键菜单"编辑详情"：跳转到实体面板 ──
  const handleEditClipDetails = useCallback((clip: TimelineClip) => {
    selectNode(clip.entityId, clip.entityType)
  }, [selectNode])

  // ── 标记：创建（双击标尺）──
  const handleMarkerCreate = useCallback(async (chapter: number): Promise<void> => {
    if (!currentProjectId) return
    try {
      const created = await createMarker(currentProjectId, {
        chapter,
        title: `第 ${chapter} 章标记`,
        type: 'bookmark',
        color: 'blue',
      })
      upsertMarker(created)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 创建标记失败:', err)
    }
  }, [currentProjectId, upsertMarker])

  // ── 标记：移动 ──
  const handleMarkerMove = useCallback(async (marker: TimelineMarker, newChapter: number): Promise<void> => {
    try {
      const updated = await updateMarker(marker.id, { chapter: newChapter })
      upsertMarker(updated)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 移动标记失败:', err)
    }
  }, [upsertMarker])

  // ── 标记：右键 ──
  const handleContextMenuMarker = useCallback((marker: TimelineMarker, x: number, y: number) => {
    setMarkerContextMenu({ marker, x, y })
  }, [])

  // ── 标记：删除 ──
  const handleMarkerDelete = useCallback(async (markerId: string): Promise<void> => {
    try {
      await deleteMarker(markerId)
      removeMarker(markerId)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 删除标记失败:', err)
    }
    setMarkerContextMenu(null)
  }, [removeMarker])

  // ── 标记：切换类型 ──
  const handleMarkerChangeType = useCallback(async (markerId: string, type: TimelineMarker['type']): Promise<void> => {
    const colorMap: Record<TimelineMarker['type'], TimelineMarker['color']> = {
      'bookmark': 'blue',
      'turning-point': 'yellow',
      'foreshadow': 'green',
      'climax': 'red',
      'note': 'purple',
      'clip-note': 'purple',
    }
    try {
      const updated = await updateMarker(markerId, { type, color: colorMap[type] })
      upsertMarker(updated)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 切换标记类型失败:', err)
    }
    setMarkerContextMenu(null)
  }, [upsertMarker])

  // ── 标记：保存编辑 ──
  const handleMarkerSaveEdit = useCallback(async (markerId: string, title: string, note: string): Promise<void> => {
    try {
      const updated = await updateMarker(markerId, { title, note })
      upsertMarker(updated)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 保存标记失败:', err)
    }
    setEditingMarker(null)
  }, [upsertMarker])

  // ── 片段批注：保存/删除（以 type='clip-note' 的 marker 持久化）──
  const handleSaveClipNote = useCallback(async (note: string): Promise<void> => {
    if (!currentProjectId || !noteDialogClip) return
    const existing = markers.find(
      (m) => m.type === 'clip-note' && m.entityId === noteDialogClip.entityId,
    )
    try {
      if (existing) {
        const updated = await updateMarker(existing.id, { note })
        upsertMarker(updated)
      } else {
        const created = await createMarker(currentProjectId, {
          chapter: noteDialogClip.startChapter,
          title: `${noteDialogClip.label} 批注`,
          type: 'clip-note',
          color: 'purple',
          entityType: noteDialogClip.entityType,
          entityId: noteDialogClip.entityId,
          note,
        })
        upsertMarker(created)
      }
      setNoteDialogClip(null)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 保存片段批注失败:', err)
    }
  }, [currentProjectId, noteDialogClip, markers, updateMarker, upsertMarker, createMarker])

  const handleDeleteClipNote = useCallback(async (): Promise<void> => {
    if (!noteDialogClip) return
    const existing = markers.find(
      (m) => m.type === 'clip-note' && m.entityId === noteDialogClip.entityId,
    )
    if (!existing) {
      setNoteDialogClip(null)
      return
    }
    try {
      await deleteMarker(existing.id)
      removeMarker(existing.id)
      setNoteDialogClip(null)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 删除片段批注失败:', err)
    }
  }, [noteDialogClip, markers, deleteMarker, removeMarker])

  // ── 片段右键 ──
  const handleContextMenuClip = useCallback((clip: TimelineClip, x: number, y: number) => {
    setClipContextMenu({ x, y, clip })
  }, [])

  // ── 轨道右键 ──
  const handleContextMenuTrack = useCallback((track: TimelineTrack, x: number, y: number) => {
    setTrackContextMenu({ x, y, track })
  }, [])

  // ── 轨道状态 toggle（A7：受控状态，由 workspace 维护并下发给 TimelineEditor）──
  const toggleTrackVisible = useCallback((trackId: string) => {
    setHiddenTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])
  const toggleTrackLock = useCallback((trackId: string) => {
    setLockedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])
  const toggleTrackMute = useCallback((trackId: string) => {
    setMutedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])
  const toggleTrackSolo = useCallback((trackId: string) => {
    setSoloedTrack((prev) => (prev === trackId ? null : trackId))
  }, [])
  const toggleTrackCollapse = useCallback((trackId: string) => {
    setCollapsedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])

  // ── 空白右键（暂用章节菜单）──
  const handleContextMenuEmpty = useCallback((x: number, y: number) => {
    // 计算右键位置的章节号
    const viewport = canvasRef.current?.querySelector('.tl-tracks-viewport') as HTMLElement | null
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const relX = x - rect.left + viewport.scrollLeft
    const chapter = Math.max(1, Math.floor(relX / chapterWidth) + 1)
    const ch = chapters.find((c) => c.chapterNumber === chapter)
    setContextMenu({
      x,
      y,
      chapterNumber: chapter,
      chapterId: ch?.id ?? null,
      chapterTitle: ch?.title ?? null,
    })
  }, [chapterWidth, chapters])

  // ── 轨道头部操作 ──
  const currentTrackIndex = trackContextMenu ? tracks.findIndex((t) => t.id === trackContextMenu.track.id) : -1
  const handleTrackMoveUp = useCallback(() => {
    // 轨道顺序由数据决定，暂不持久化（仅 UI 层）
    // TODO: 后续可持久化到 novel_track_order 表
  }, [])
  const handleTrackMoveDown = useCallback(() => {
    // 同上
  }, [])

  // ── 清空实体区间（undo/redo else 分支使用，避免 updateEntityRange(0,-1) 的 Math.max 钳制）──
  // 与 handleClipDelete 的 switch 分支语义一致：直接置空区间而非走钳制路径。
  const clearEntityRange = useCallback(
    async (clip: EditAction['clip']): Promise<void> => {
      if (!currentProjectId) return
      try {
        switch (clip.entityType) {
          case 'character': {
            const records = characterHistory.filter((h) => h.characterId === clip.entityId)
            for (const rec of records) {
              if (rec.chapterNumber != null) {
                await deleteCharacterHistory(currentProjectId, rec.id)
                removeCharacterHistory(rec.id)
              }
            }
            break
          }
          case 'conflict': {
            const conflict = conflicts.find((c) => c.id === clip.entityId)
            if (!conflict) break
            const updated = await updateConflict(conflict.id, { firstChapter: null, lastChapter: null })
            upsertConflict(updated)
            break
          }
          case 'foreshadow': {
            const foreshadow = foreshadows.find((f) => f.id === clip.entityId)
            if (!foreshadow) break
            const updated = await updateForeshadow(foreshadow.id, { firstChapter: null, recoverByChapter: null })
            upsertForeshadow(updated)
            break
          }
          case 'faction': {
            const faction = factions.find((f) => f.id === clip.entityId)
            if (!faction) break
            const updated = await updateFaction(faction.id, { firstChapter: null, lastChapter: null })
            upsertFaction(updated)
            break
          }
          case 'location': {
            // location 的置空逻辑较复杂（appearChapters 数组），简化处理：清空 appearChapters
            const location = locations.find((l) => l.id === clip.entityId)
            if (!location) break
            const updated = await updateLocation(location.id, { appearChapters: [] })
            upsertLocation(updated)
            break
          }
          case 'world_element':
            break
        }
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
      } catch (err) {
        console.error('[NovelTimelineWorkspace] 清空实体区间失败:', err)
      }
    },
    [
      currentProjectId, characterHistory, conflicts, foreshadows, factions, locations,
      removeCharacterHistory, upsertConflict, upsertForeshadow, upsertFaction, upsertLocation, queryClient,
    ],
  )

  // ── 撤销/重做 ──
  const handleUndo = useCallback(() => {
    const cur = historyRef.current
    if (cur.past.length === 0) return
    const action = cur.past[cur.past.length - 1]
    // move/delete/cut 恢复 before；paste 撤销应删除（区间置空）→ before(0,-1) 表示无
    const restore = rangeToRestore(action, 'undo')
    if (restore.end >= restore.start) {
      void updateEntityRange(action.clip, restore.start, restore.end)
    } else {
      // 区间无效表示撤销应"删除"该片段：按 entityType 置空
      void clearEntityRange(action.clip)
    }
    setHistory({
      past: cur.past.slice(0, -1),
      future: [...cur.future, action],
    })
  }, [updateEntityRange, clearEntityRange])

  const handleRedo = useCallback(() => {
    const cur = historyRef.current
    if (cur.future.length === 0) return
    const action = cur.future[cur.future.length - 1]
    const restore = rangeToRestore(action, 'redo')
    if (restore.end >= restore.start) {
      void updateEntityRange(action.clip, restore.start, restore.end)
    } else {
      // 区间无效表示 redo 应"删除"该片段（delete/cut 的 after={0,-1}）：按 entityType 置空
      void clearEntityRange(action.clip)
    }
    setHistory({
      past: [...cur.past, action],
      future: cur.future.slice(0, -1),
    })
  }, [updateEntityRange, clearEntityRange])

  // ── 元素池拖入 ──
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    if (e.dataTransfer.types.includes(POOL_DRAG_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (!isDragOver) setIsDragOver(true)
      const viewport = canvasRef.current?.querySelector('.tl-tracks-viewport') as HTMLElement | null
      if (viewport) {
        const rect = viewport.getBoundingClientRect()
        const dropX = e.clientX - rect.left + viewport.scrollLeft
        const chapter = Math.max(1, Math.floor(dropX / chapterWidth) + 1)
        setDropIndicatorChapter(chapter)
      }
    }
  }, [isDragOver, chapterWidth])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    if (e.currentTarget === e.target) {
      setIsDragOver(false)
      setDropIndicatorChapter(null)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    setIsDragOver(false)
    setDropIndicatorChapter(null)
    if (!currentProjectId) return
    const payloadStr = e.dataTransfer.getData(POOL_DRAG_MIME)
    if (!payloadStr) return
    let payload: PoolDragPayload
    try {
      payload = JSON.parse(payloadStr) as PoolDragPayload
    } catch {
      return
    }

    const viewport = canvasRef.current?.querySelector('.tl-tracks-viewport') as HTMLElement | null
    let chapterNumber = 1
    if (viewport) {
      const rect = viewport.getBoundingClientRect()
      const dropX = e.clientX - rect.left + viewport.scrollLeft
      chapterNumber = Math.max(1, Math.floor(dropX / chapterWidth) + 1)
    }

    try {
      switch (payload.kind) {
        case 'character': {
          const newHistory = await createCharacterHistory(currentProjectId, payload.id, {
            fieldName: 'currentState',
            oldValue: null,
            newValue: '【时间轴拖入】角色首次出场',
            reason: `从元素池拖入：第 ${chapterNumber} 章`,
            chapterNumber,
          })
          addCharacterHistory(newHistory)
          break
        }
        case 'conflict': {
          const conflict = conflicts.find((c) => c.id === payload.id)
          if (!conflict) break
          const updated = await updateConflict(conflict.id, {
            firstChapter: chapterNumber,
            lastChapter: conflict.lastChapter,
          })
          upsertConflict(updated)
          break
        }
        case 'foreshadow': {
          const foreshadow = foreshadows.find((f) => f.id === payload.id)
          if (!foreshadow) break
          const updated = await updateForeshadow(foreshadow.id, {
            firstChapter: chapterNumber,
            recoverByChapter: foreshadow.recoverByChapter,
          })
          upsertForeshadow(updated)
          break
        }
        case 'faction': {
          const faction = factions.find((f) => f.id === payload.id)
          if (!faction) break
          const updated = await updateFaction(faction.id, {
            firstChapter: chapterNumber,
            lastChapter: faction.lastChapter,
          })
          upsertFaction(updated)
          break
        }
        case 'location': {
          const location = locations.find((l) => l.id === payload.id)
          if (!location) break
          const next = Array.from(new Set([...(location.appearChapters ?? []), chapterNumber])).sort((a, b) => a - b)
          const updated = await updateLocation(location.id, { appearChapters: next })
          upsertLocation(updated)
          break
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 拖入元素失败:', err)
    }
  }, [
    currentProjectId, chapterWidth, conflicts, foreshadows, factions, locations,
    addCharacterHistory, upsertConflict, upsertForeshadow, upsertFaction, upsertLocation, queryClient,
  ])

  // ── 角色历史补全 ──
  const completableCount = poolCharacters.length

  const handleCompleteHistory = useCallback(async (): Promise<void> => {
    if (!currentProjectId || completableCount === 0) return
    setIsCompleting(true)
    try {
      const records = poolCharacters.map((c) => ({
        characterId: c.id,
        chapterNumber: 1,
      }))
      const created = await batchCreateCharacterHistory(currentProjectId, records)
      setCharacterHistory([...characterHistory, ...created])
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 补全历史失败:', err)
    } finally {
      setIsCompleting(false)
    }
  }, [currentProjectId, completableCount, poolCharacters, characterHistory, setCharacterHistory, queryClient])

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
      console.error('[NovelTimelineWorkspace] 删除章节失败:', err)
    }
  }, [currentProjectId, removeChapter, queryClient])

  // 同步选中片段到实体（单选时联动右侧面板）
  const selectedClipForEntity = useMemo(() => {
    if (selectedClipIds.size !== 1) return null
    const id = Array.from(selectedClipIds)[0]
    return tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null
  }, [selectedClipIds, tracks])

  useEffect(() => {
    if (selectedClipForEntity) {
      selectNode(selectedClipForEntity.entityId, selectedClipForEntity.entityType)
    }
  }, [selectedClipForEntity, selectNode])

  return (
    <div className="novel-timeline-root">
      <TimelineToolbar
        zoom={zoom}
        filter={filter}
        completableCount={completableCount}
        isCompleting={isCompleting}
        onZoomChange={handleZoomChange}
        onFilterChange={setFilter}
        onCompleteHistory={handleCompleteHistory}
        totalChapters={Math.max(chapters.length, maxChapter)}
        playheadChapter={effectivePlayheadChapter}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canDelete={selectedClipIds.size > 0}
        onDelete={handleDeleteSelected}
        showRelations={showRelations}
        onToggleRelations={() => setShowRelations((prev) => !prev)}
      />

      <div className="novel-timeline-body">
        <ElementPool
          characters={poolCharacters}
          conflicts={poolConflicts}
          foreshadows={poolForeshadows}
          factions={poolFactions}
          locations={poolLocations}
        />

        <div
          ref={canvasRef}
          className={`novel-timeline-canvas ${isDragOver ? 'is-drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(e) => void handleDrop(e)}
        >
          <TimelineEditor
            tracks={tracks}
            chapters={chapters}
            relationships={relationships}
            conflicts={conflicts}
            factions={factions}
            markers={markers}
            playheadChapter={effectivePlayheadChapter}
            chapterWidth={chapterWidth}
            maxChapter={maxChapter}
            creatingChapter={creationRunning ? creationChapterNumber : undefined}
            selectedClipIds={selectedClipIds}
            showPlayhead
            dropIndicatorChapter={dropIndicatorChapter}
            trackHeightLevel={trackHeightLevel}
            showWordCount
            showMinimap
            showRelations={showRelations}
            showMarkers
            onSelectEntity={handleSelectEntity}
            onPlayheadChange={handlePlayheadChange}
            onClipMove={handleClipMove}
            onClipDelete={handleClipDelete}
            onContextMenuChapter={handleContextMenuChapter}
            onContextMenuClip={handleContextMenuClip}
            onContextMenuTrack={handleContextMenuTrack}
            onContextMenuEmpty={handleContextMenuEmpty}
            onMarkerMove={handleMarkerMove}
            onMarkerCreate={handleMarkerCreate}
            onContextMenuMarker={handleContextMenuMarker}
            onMarkerEdit={setEditingMarker}
            onClipDoubleClick={handleClipDoubleClick}
            onSelectClipsChange={handleSelectClipsChange}
            onChapterWidthChange={handleChapterWidthChange}
            hiddenTracks={hiddenTracks}
            lockedTracks={lockedTracks}
            soloedTrack={soloedTrack}
            mutedTracks={mutedTracks}
            collapsedTracks={collapsedTracks}
            onToggleTrackVisible={toggleTrackVisible}
            onToggleTrackLock={toggleTrackLock}
            onToggleTrackMute={toggleTrackMute}
            onToggleTrackSolo={toggleTrackSolo}
            onToggleTrackCollapse={toggleTrackCollapse}
          />
        </div>
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

      <ClipContextMenu
        position={clipContextMenu}
        canPaste={clipboard != null && clipboard.length > 0}
        onClose={() => setClipContextMenu(null)}
        onCopy={handleCopyClip}
        onCut={handleCutClip}
        onDelete={(clip) => void handleClipDelete(clip.id)}
        onAlignToPlayhead={handleAlignToPlayhead}
        onEditDetails={handleEditClipDetails}
      />

      <TrackContextMenu
        position={trackContextMenu}
        isLocked={trackContextMenu ? lockedTracks.has(trackContextMenu.track.id) : false}
        isHidden={trackContextMenu ? hiddenTracks.has(trackContextMenu.track.id) : false}
        isCollapsed={trackContextMenu ? collapsedTracks.has(trackContextMenu.track.id) : false}
        heightLevel={trackHeightLevel}
        canMoveUp={currentTrackIndex > 0}
        canMoveDown={currentTrackIndex >= 0 && currentTrackIndex < tracks.length - 1}
        onClose={() => setTrackContextMenu(null)}
        onMoveUp={handleTrackMoveUp}
        onMoveDown={handleTrackMoveDown}
        onSetHeight={setTrackHeightLevel}
        onToggleLock={() => trackContextMenu && toggleTrackLock(trackContextMenu.track.id)}
        onToggleVisible={() => trackContextMenu && toggleTrackVisible(trackContextMenu.track.id)}
        onToggleCollapse={() => trackContextMenu && toggleTrackCollapse(trackContextMenu.track.id)}
      />

      <MarkerContextMenu
        position={markerContextMenu}
        onClose={() => setMarkerContextMenu(null)}
        onJumpTo={(marker) => setPlayheadChapter(marker.chapter)}
        onChangeType={handleMarkerChangeType}
        onEdit={(marker) => setEditingMarker(marker)}
        onDelete={handleMarkerDelete}
      />

      <MarkerEditDialog
        marker={editingMarker}
        onClose={() => setEditingMarker(null)}
        onSave={handleMarkerSaveEdit}
      />

      <ClipNoteDialog
        clip={noteDialogClip}
        initialNote={noteDialogClip?.note ?? ''}
        onClose={() => setNoteDialogClip(null)}
        onSave={handleSaveClipNote}
        onDelete={handleDeleteClipNote}
      />
    </div>
  )
}
