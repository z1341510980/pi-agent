import type { ITask } from '@svar-ui/react-gantt'
import type { NovelAnnotation, NovelChangeRecord, NovelStoryEvent } from '@/api/novel-client'
import type { MatrixEntity, MatrixEntityKind } from './matrix-logic'
import { buildSubtracksForEntity } from './subtrack-builders'

const DAY_MS = 86_400_000
const CHAPTER_EPOCH_UTC = Date.UTC(2020, 0, 1)

export type EntityGanttTaskKind = 'entity' | 'track' | 'band' | 'node' | 'curve-point' | 'event' | 'change' | 'annotation'

export type EntityGanttMutation =
  | { kind: 'span'; entityId: string; entityType: 'conflict' | 'faction' | 'item'; spanIndex: number; startChapter: number; endChapter: number }
  | { kind: 'curve-point'; entityId: string; trackKey: string; pointIndex: number; chapter: number; value: number }
  | { kind: 'node'; entityId: string; trackKey: string; nodeIndex: number; chapter: number }
  | { kind: 'event'; eventId: string; chapter: number }
  | { kind: 'annotation'; annotationId: string; startChapter: number; endChapter: number }

export interface EntityGanttTask extends ITask {
  id: string
  text: string
  storyTaskKind: EntityGanttTaskKind
  entityId: string
  entityType: MatrixEntityKind
  trackKey?: string
  bandIndex?: number
  pointIndex?: number
  value?: number
  color?: string
  chapterStart?: number
  chapterEnd?: number
  storyEventId?: string
  changeRecordId?: string
  annotationId?: string
}

type EntityGanttTaskUpdate = Partial<ITask> & Partial<Omit<EntityGanttTask, 'id'>>

export function chapterToGanttDate(chapter: number): Date {
  return new Date(CHAPTER_EPOCH_UTC + Math.max(0, chapter - 1) * DAY_MS)
}

export function ganttDateToChapter(date: Date): number {
  const utcDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return Math.max(1, Math.round((utcDay - CHAPTER_EPOCH_UTC) / DAY_MS) + 1)
}

function taskRange(tasks: EntityGanttTask[], fallbackStart: number, fallbackEnd: number): [number, number] {
  const starts = tasks.map((task) => task.chapterStart).filter((value): value is number => value != null)
  const ends = tasks.map((task) => task.chapterEnd).filter((value): value is number => value != null)
  return [starts.length > 0 ? Math.min(...starts) : fallbackStart, ends.length > 0 ? Math.max(...ends) : fallbackEnd]
}

export function buildEntityGanttTasks(entity: MatrixEntity, maxChapter: number): EntityGanttTask[] {
  const subtracks = buildSubtracksForEntity(entity, entity.kind)
  const childTasks: EntityGanttTask[] = []
  const trackTasks: EntityGanttTask[] = []
  const entityTaskId = `entity:${entity.entityId}`
  const fallbackStart = entity.spanStart ?? entity.plantChapter ?? 1
  const fallbackEnd = entity.spanEnd ?? Math.max(fallbackStart, maxChapter)

  for (const track of subtracks) {
    const trackId = `track:${entity.entityId}:${track.key}`
    const trackChildren: EntityGanttTask[] = []

    track.bands.forEach((band, bandIndex) => {
      trackChildren.push({
        id: `band:${entity.entityId}:${track.key}:${bandIndex}`,
        parent: trackId,
        text: band.label || track.label,
        start: chapterToGanttDate(band.startCh),
        end: chapterToGanttDate(band.endCh + 1),
        duration: Math.max(1, band.endCh - band.startCh + 1),
        type: 'task',
        progress: 0,
        storyTaskKind: 'band',
        entityId: entity.entityId,
        entityType: entity.kind,
        trackKey: track.key,
        bandIndex,
        color: track.color,
        chapterStart: band.startCh,
        chapterEnd: band.endCh,
      })
    })

    track.nodes?.forEach((node, pointIndex) => {
      trackChildren.push({
        id: `node:${entity.entityId}:${track.key}:${pointIndex}`,
        parent: trackId,
        text: node.label || track.label,
        start: chapterToGanttDate(node.ch),
        end: chapterToGanttDate(node.ch),
        duration: 0,
        type: 'milestone',
        progress: 0,
        storyTaskKind: 'node',
        entityId: entity.entityId,
        entityType: entity.kind,
        trackKey: track.key,
        pointIndex,
        color: node.color || track.color,
        chapterStart: node.ch,
        chapterEnd: node.ch,
      })
    })

    track.curve?.forEach((point, pointIndex) => {
      trackChildren.push({
        id: `curve:${entity.entityId}:${track.key}:${pointIndex}`,
        parent: trackId,
        text: `${track.label} ${Math.round(point.value * 100)}`,
        start: chapterToGanttDate(point.ch),
        end: chapterToGanttDate(point.ch),
        duration: 0,
        type: 'milestone',
        progress: Math.round(point.value * 100),
        storyTaskKind: 'curve-point',
        entityId: entity.entityId,
        entityType: entity.kind,
        trackKey: track.key,
        pointIndex,
        value: point.value,
        color: track.color,
        chapterStart: point.ch,
        chapterEnd: point.ch,
      })
    })

    const [trackStart, trackEnd] = taskRange(trackChildren, fallbackStart, fallbackEnd)
    trackTasks.push({
      id: trackId,
      parent: entityTaskId,
      text: track.label,
      start: chapterToGanttDate(trackStart),
      end: chapterToGanttDate(trackEnd + 1),
      duration: Math.max(1, trackEnd - trackStart + 1),
      type: 'summary',
      open: true,
      progress: 0,
      unscheduled: trackChildren.length === 0,
      storyTaskKind: 'track',
      entityId: entity.entityId,
      entityType: entity.kind,
      trackKey: track.key,
      color: track.color,
      chapterStart: trackStart,
      chapterEnd: trackEnd,
    })
    childTasks.push(...trackChildren)
  }

  const [entityStart, entityEnd] = taskRange([...trackTasks, ...childTasks], fallbackStart, fallbackEnd)
  const root: EntityGanttTask = {
    id: entityTaskId,
    parent: 0,
    text: entity.name,
    start: chapterToGanttDate(entityStart),
    end: chapterToGanttDate(entityEnd + 1),
    duration: Math.max(1, entityEnd - entityStart + 1),
    type: 'summary',
    open: true,
    progress: 0,
    storyTaskKind: 'entity',
    entityId: entity.entityId,
    entityType: entity.kind,
    chapterStart: entityStart,
    chapterEnd: entityEnd,
  }

  return [root, ...trackTasks.flatMap((track) => [track, ...childTasks.filter((child) => child.parent === track.id)])]
}

export interface EntityLedgerTimeline {
  events: NovelStoryEvent[]
  changes: NovelChangeRecord[]
  annotations: NovelAnnotation[]
}

function ledgerTrack(
  entity: MatrixEntity,
  id: string,
  label: string,
  children: EntityGanttTask[],
  fallbackChapter: number,
): EntityGanttTask[] {
  if (children.length === 0) return []
  const entityTaskId = `entity:${entity.entityId}`
  const [start, end] = taskRange(children, fallbackChapter, fallbackChapter)
  const track: EntityGanttTask = {
    id,
    parent: entityTaskId,
    text: label,
    start: chapterToGanttDate(start),
    end: chapterToGanttDate(end + 1),
    duration: Math.max(1, end - start + 1),
    type: 'summary',
    open: true,
    progress: 0,
    storyTaskKind: 'track',
    entityId: entity.entityId,
    entityType: entity.kind,
    trackKey: id,
    chapterStart: start,
    chapterEnd: end,
  }
  return [track, ...children]
}

/** Add event-ledger projections to the legacy snapshot tracks. */
export function buildEntityGanttTasksWithLedger(
  entity: MatrixEntity,
  maxChapter: number,
  timeline?: EntityLedgerTimeline,
): EntityGanttTask[] {
  const tasks = buildEntityGanttTasks(entity, maxChapter)
  if (!timeline) return tasks
  const root = tasks[0]
  const fallbackChapter = root?.chapterStart ?? 1

  const eventTrackId = `ledger:${entity.entityId}:events`
  const eventChildren = timeline.events.map<EntityGanttTask>((event) => ({
    id: `event:${event.id}`,
    parent: eventTrackId,
    text: event.title || event.summary || '事件',
    start: chapterToGanttDate(event.chapterNumber),
    end: chapterToGanttDate(event.chapterNumber),
    duration: 0,
    type: 'milestone',
    progress: 0,
    storyTaskKind: 'event',
    entityId: entity.entityId,
    entityType: entity.kind,
    trackKey: 'events',
    storyEventId: event.id,
    chapterStart: event.chapterNumber,
    chapterEnd: event.chapterNumber,
    color: '#0ea5e9',
  }))

  const changeTrackId = `ledger:${entity.entityId}:changes`
  const changeChildren = timeline.changes.map<EntityGanttTask>((change) => ({
    id: `change:${change.id}`,
    parent: changeTrackId,
    text: `${change.dimension}: ${String(change.beforeValue ?? '无')} -> ${String(change.afterValue ?? '无')}`,
    start: chapterToGanttDate(change.chapterNumber),
    end: chapterToGanttDate(change.chapterNumber),
    duration: 0,
    type: 'milestone',
    progress: 0,
    storyTaskKind: 'change',
    entityId: entity.entityId,
    entityType: entity.kind,
    trackKey: 'changes',
    changeRecordId: change.id,
    chapterStart: change.chapterNumber,
    chapterEnd: change.chapterNumber,
    color: '#22c55e',
  }))

  const annotationTrackId = `ledger:${entity.entityId}:annotations`
  const annotationChildren = timeline.annotations.map<EntityGanttTask>((annotation) => {
    const start = annotation.chapterStart ?? fallbackChapter
    const end = annotation.chapterEnd ?? start
    const isSpan = end > start
    return {
      id: `annotation:${annotation.id}`,
      parent: annotationTrackId,
      text: annotation.content,
      start: chapterToGanttDate(start),
      end: isSpan ? chapterToGanttDate(end + 1) : chapterToGanttDate(start),
      duration: isSpan ? end - start + 1 : 0,
      type: isSpan ? 'task' : 'milestone',
      progress: 0,
      storyTaskKind: 'annotation',
      entityId: entity.entityId,
      entityType: entity.kind,
      trackKey: 'annotations',
      annotationId: annotation.id,
      chapterStart: start,
      chapterEnd: end,
      color: annotation.color === 'red' ? '#ef4444' : annotation.color === 'green' ? '#22c55e' : annotation.color === 'yellow' ? '#eab308' : '#8b5cf6',
    }
  })

  return [
    ...tasks,
    ...ledgerTrack(entity, eventTrackId, '故事事件', eventChildren, fallbackChapter),
    ...ledgerTrack(entity, changeTrackId, '变化记录', changeChildren, fallbackChapter),
    ...ledgerTrack(entity, annotationTrackId, '作者批注', annotationChildren, fallbackChapter),
  ]
}

export function chaptersFromUpdatedTask(task: Pick<ITask, 'start' | 'end' | 'type'>): { startChapter: number; endChapter: number } | null {
  if (!task.start) return null
  const startChapter = ganttDateToChapter(task.start)
  if (task.type === 'milestone' || !task.end) return { startChapter, endChapter: startChapter }
  return { startChapter, endChapter: Math.max(startChapter, ganttDateToChapter(task.end) - 1) }
}

/**
 * Convert a Gantt leaf-task update into the domain callback payload.
 * Summary rows and tracks deliberately return null: their dates are derived
 * from children and must never become independent story facts.
 */
export function mutationFromUpdatedTask(task: EntityGanttTaskUpdate): EntityGanttMutation | null {
  if (!task.entityId || !task.storyTaskKind || !task.trackKey) return null
  if (task.storyTaskKind === 'band' && task.bandIndex == null) return null
  if ((task.storyTaskKind === 'node' || task.storyTaskKind === 'curve-point') && task.pointIndex == null) return null

  const range = chaptersFromUpdatedTask(task)
  if (!range) return null

  if (
    task.storyTaskKind === 'band'
    && task.trackKey === 'stage'
    && task.bandIndex != null
    && (task.entityType === 'conflict' || task.entityType === 'faction' || task.entityType === 'item')
  ) {
    return {
      kind: 'span',
      entityId: task.entityId,
      entityType: task.entityType,
      spanIndex: task.bandIndex,
      startChapter: range.startChapter,
      endChapter: range.endChapter,
    }
  }

  if (task.storyTaskKind === 'curve-point' && task.pointIndex != null && task.value != null) {
    return {
      kind: 'curve-point',
      entityId: task.entityId,
      trackKey: task.trackKey!,
      pointIndex: task.pointIndex,
      chapter: range.startChapter,
      value: task.value,
    }
  }

  if (task.storyTaskKind === 'node' && task.pointIndex != null && task.trackKey === 'beats') {
    return {
      kind: 'node',
      entityId: task.entityId,
      trackKey: task.trackKey,
      nodeIndex: task.pointIndex,
      chapter: range.startChapter,
    }
  }


  if (task.storyTaskKind === 'event' && task.storyEventId) {
    return { kind: 'event', eventId: task.storyEventId, chapter: range.startChapter }
  }

  if (task.storyTaskKind === 'annotation' && task.annotationId) {
    return {
      kind: 'annotation',
      annotationId: task.annotationId,
      startChapter: range.startChapter,
      endChapter: range.endChapter,
    }
  }

  return null
}
