import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, LocateFixed, Plus } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Gantt, Willow, WillowDark, type IApi, type ITask } from '@svar-ui/react-gantt'
import '@svar-ui/react-gantt/all.css'
import { cn } from '@/lib/utils'
import { getEntityStoryTimeline, updateAnnotation, updateStoryEvent } from '@/api/novel-client'
import { toastError } from '@/hooks/use-toast'
import { StoryEventDialog } from './story-event-dialog'
import { GROUP_META, type MatrixEntity } from './matrix-logic'
import {
  buildEntityGanttTasksWithLedger,
  chapterToGanttDate,
  ganttDateToChapter,
  mutationFromUpdatedTask,
  type EntityGanttMutation,
  type EntityGanttTask,
} from './entity-gantt-adapter'

export interface EntityGanttFocusProps {
  projectId: string | null
  entity: MatrixEntity
  maxChapter: number
  playheadChapter: number
  onBack: () => void
  onPlayheadChange?: (chapter: number) => void
  onMoveSpan?: (entityId: string, entityType: 'conflict' | 'faction' | 'item', spanIndex: number, startChapter: number, endChapter: number) => void
  onMoveCurvePoint?: (entityId: string, trackKey: string, pointIndex: number, chapter: number, value: number) => void
  onMoveSubtrackNode?: (entityId: string, trackKey: string, nodeIndex: number, chapter: number) => void
  onEditTrack?: (trackKey: string, entity: MatrixEntity, anchor: { x: number; y: number }) => void
}

interface FocusCallbacks {
  onMoveSpan?: EntityGanttFocusProps['onMoveSpan']
  onMoveCurvePoint?: EntityGanttFocusProps['onMoveCurvePoint']
  onMoveSubtrackNode?: EntityGanttFocusProps['onMoveSubtrackNode']
  onEditTrack?: EntityGanttFocusProps['onEditTrack']
  onPlayheadChange?: EntityGanttFocusProps['onPlayheadChange']
  onMoveStoryEvent: (eventId: string, chapter: number) => void
  onMoveAnnotation: (annotationId: string, startChapter: number, endChapter: number) => void
  entity: MatrixEntity
}

function isDarkTheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function StoryTaskTemplate({ data }: { data: ITask }): ReactElement {
  const task = data as EntityGanttTask
  const isSummary = task.storyTaskKind === 'entity' || task.storyTaskKind === 'track'
  const label = task.storyTaskKind === 'curve-point' && task.value != null
    ? `${task.text} · ${Math.round(task.value * 100)}`
    : task.text

  return (
    <div
      className={cn(
        'story-gantt-task-content',
        `story-gantt-task-content--${task.storyTaskKind ?? 'task'}`,
        isSummary && 'story-gantt-task-content--summary',
      )}
      style={{
        backgroundColor: task.color ?? 'transparent',
        borderColor: task.color ?? 'var(--wx-gantt-border)',
      }}
      title={label}
    >
      {!isSummary && label}
    </div>
  )
}

function applyMutation(mutation: EntityGanttMutation, callbacks: FocusCallbacks): void {
  switch (mutation.kind) {
    case 'span':
      callbacks.onMoveSpan?.(
        mutation.entityId,
        mutation.entityType,
        mutation.spanIndex,
        mutation.startChapter,
        mutation.endChapter,
      )
      break
    case 'curve-point':
      callbacks.onMoveCurvePoint?.(
        mutation.entityId,
        mutation.trackKey,
        mutation.pointIndex,
        mutation.chapter,
        mutation.value,
      )
      break
    case 'node':
      callbacks.onMoveSubtrackNode?.(
        mutation.entityId,
        mutation.trackKey,
        mutation.nodeIndex,
        mutation.chapter,
      )
      break
    case 'event':
      callbacks.onMoveStoryEvent(mutation.eventId, mutation.chapter)
      break
    case 'annotation':
      callbacks.onMoveAnnotation(mutation.annotationId, mutation.startChapter, mutation.endChapter)
      break
  }
}

export function EntityGanttFocus({
  projectId,
  entity,
  maxChapter,
  playheadChapter,
  onBack,
  onPlayheadChange,
  onMoveSpan,
  onMoveCurvePoint,
  onMoveSubtrackNode,
  onEditTrack,
}: EntityGanttFocusProps): ReactElement {
  const queryClient = useQueryClient()
  const [eventDialogOpen, setEventDialogOpen] = useState(false)
  const ganttRef = useRef<IApi | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const timelineQueryKey = useMemo(
    () => ['novel-entity-story-timeline', projectId, entity.kind, entity.entityId] as const,
    [entity.entityId, entity.kind, projectId],
  )
  const timelineQuery = useQuery({
    queryKey: timelineQueryKey,
    queryFn: () => getEntityStoryTimeline(projectId!, entity.kind, entity.entityId),
    enabled: Boolean(projectId),
  })
  const moveStoryEvent = useCallback((eventId: string, chapter: number): void => {
    void updateStoryEvent(eventId, { chapterNumber: chapter })
      .then(() => queryClient.invalidateQueries({ queryKey: timelineQueryKey }))
      .catch((error) => toastError('移动故事事件失败', error instanceof Error ? error.message : String(error)))
  }, [queryClient, timelineQueryKey])
  const moveAnnotation = useCallback((annotationId: string, startChapter: number, endChapter: number): void => {
    void updateAnnotation(annotationId, { chapterStart: startChapter, chapterEnd: endChapter })
      .then(() => queryClient.invalidateQueries({ queryKey: timelineQueryKey }))
      .catch((error) => toastError('移动批注失败', error instanceof Error ? error.message : String(error)))
  }, [queryClient, timelineQueryKey])
  const callbacksRef = useRef<FocusCallbacks>({
    entity,
    onMoveSpan,
    onMoveCurvePoint,
    onMoveSubtrackNode,
    onEditTrack,
    onPlayheadChange,
    onMoveStoryEvent: moveStoryEvent,
    onMoveAnnotation: moveAnnotation,
  })
  callbacksRef.current = {
    entity,
    onMoveSpan,
    onMoveCurvePoint,
    onMoveSubtrackNode,
    onEditTrack,
    onPlayheadChange,
    onMoveStoryEvent: moveStoryEvent,
    onMoveAnnotation: moveAnnotation,
  }

  const tasks = useMemo(
    () => buildEntityGanttTasksWithLedger(entity, maxChapter, timelineQuery.data),
    [entity, maxChapter, timelineQuery.data],
  )
  const meta = GROUP_META[entity.kind]
  const chapterEnd = Math.max(maxChapter, entity.spanEnd ?? maxChapter) + 1

  const ganttInit = useCallback((api: IApi): void => {
    ganttRef.current = api

    // Summary dates are derived from their children. Blocking drag-task here
    // prevents the library from moving a whole entity/track independently.
    api.intercept('drag-task', (event) => {
      const task = api.getTask(event.id) as EntityGanttTask | undefined
      return task ? mutationFromUpdatedTask(task) != null : false
    })
    api.intercept('update-task', (event) => {
      const task = api.getTask(event.id) as EntityGanttTask | undefined
      if (!task) return false
      return mutationFromUpdatedTask({ ...task, ...event.task }) != null
    })
    api.on('update-task', (event) => {
      if (event.inProgress) return
      const task = api.getTask(event.id) as EntityGanttTask | undefined
      if (!task) return
      const mutation = mutationFromUpdatedTask({ ...task, ...event.task })
      if (mutation) applyMutation(mutation, callbacksRef.current)
    })
    api.intercept('show-editor', (event) => {
      const task = api.getTask(event.id) as EntityGanttTask | undefined
      if (!task?.trackKey) return false
      const rect = viewportRef.current?.getBoundingClientRect()
      callbacksRef.current.onEditTrack?.(
        task.trackKey,
        callbacksRef.current.entity,
        { x: rect ? rect.left + rect.width / 2 : 0, y: rect ? rect.top + rect.height / 2 : 0 },
      )
      return false
    })
    api.on('select-task', (event) => {
      const task = api.getTask(event.id) as EntityGanttTask | undefined
      const chapter = task?.chapterStart
      if (chapter != null) callbacksRef.current.onPlayheadChange?.(chapter)
    })
  }, [])

  const highlightTime = useCallback((date: Date, unit: 'day' | 'hour'): string => {
    if (unit !== 'day') return ''
    return ganttDateToChapter(date) === playheadChapter ? 'story-gantt-playhead' : ''
  }, [playheadChapter])

  useEffect(() => {
    ganttRef.current?.exec('scroll-chart', { date: chapterToGanttDate(playheadChapter) })
  }, [playheadChapter])

  const Theme = isDarkTheme() ? WillowDark : Willow

  return (
    <div ref={viewportRef} className="story-gantt-focus flex h-full min-h-0 flex-col bg-surface-1">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 px-3">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          onClick={onBack}
          aria-label="返回故事矩阵"
        >
          <ArrowLeft className="size-4" />
          <span>返回矩阵</span>
        </button>
        <span className="h-4 w-px bg-border/70" aria-hidden="true" />
        <span className="text-sm" style={{ color: meta.color }}>{meta.icon}</span>
        <span className="min-w-0 truncate text-sm font-semibold text-text">{entity.name}</span>
        {entity.subLabel && <span className="truncate text-xs text-muted-foreground">{entity.subLabel}</span>}
        <button
          type="button"
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded border border-border/70 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          onClick={() => setEventDialogOpen(true)}
        >
          <Plus className="size-3.5" />
          <span>新增事件</span>
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded border border-border/70 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          onClick={() => ganttRef.current?.exec('scroll-chart', { date: chapterToGanttDate(playheadChapter) })}
          aria-label={`定位到第${playheadChapter}章`}
        >
          <LocateFixed className="size-3.5" />
          <span>第 {playheadChapter} 章</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <Theme fonts={false} />
          <Gantt
            tasks={tasks}
            columns={[{ id: 'text', header: '复合轨道', width: 280, resize: true }]}
            start={chapterToGanttDate(1)}
            end={chapterToGanttDate(chapterEnd)}
            projectStart={chapterToGanttDate(1)}
            projectEnd={chapterToGanttDate(chapterEnd)}
            autoScale={false}
            lengthUnit="day"
            durationUnit="day"
            cellWidth={48}
            cellHeight={38}
            scaleHeight={38}
            scales={[
              { unit: 'day', step: 5, format: (date) => `第${ganttDateToChapter(date)}-${ganttDateToChapter(new Date(date.getTime() + 4 * 86_400_000))}章` },
              { unit: 'day', step: 1, format: (date) => `${ganttDateToChapter(date)}` },
            ]}
            highlightTime={highlightTime}
            taskTemplate={StoryTaskTemplate}
            init={ganttInit}
          />
      </div>

      <StoryEventDialog
        open={eventDialogOpen}
        projectId={projectId}
        entity={entity}
        defaultChapter={playheadChapter}
        timeline={timelineQuery.data}
        onClose={() => setEventDialogOpen(false)}
        onCreated={() => void queryClient.invalidateQueries({ queryKey: timelineQueryKey })}
      />
    </div>
  )
}
