import { describe, expect, it } from 'vitest'
import type { MatrixEntity } from '../matrix-logic'
import {
  buildEntityGanttTasks,
  buildEntityGanttTasksWithLedger,
  chapterToGanttDate,
  chaptersFromUpdatedTask,
  ganttDateToChapter,
  mutationFromUpdatedTask,
} from '../entity-gantt-adapter'

const conflict: MatrixEntity = {
  id: 'conflict:c1', entityId: 'c1', entityType: 'conflict', kind: 'conflict',
  name: '身份冲突', chapterSpans: [[3, 5], [9, 12]],
  spanStart: 3, spanEnd: 12, subLabel: '主要冲突',
}

describe('entity gantt adapter', () => {
  it('maps every conflict phase to an independent child task', () => {
    const tasks = buildEntityGanttTasks(conflict, 20)
    const stageBands = tasks.filter((task) => task.storyTaskKind === 'band' && task.trackKey === 'stage')

    expect(stageBands).toHaveLength(2)
    expect(stageBands.map((task) => [task.chapterStart, task.chapterEnd])).toEqual([[3, 5], [9, 12]])
    expect(new Set(stageBands.map((task) => task.id)).size).toBe(2)
    expect(tasks.find((task) => task.id === 'track:c1:stage')?.type).toBe('summary')
  })

  it('keeps chapter conversion stable across years', () => {
    for (const chapter of [1, 10, 365, 900]) {
      expect(ganttDateToChapter(chapterToGanttDate(chapter))).toBe(chapter)
    }
  })

  it('converts Gantt exclusive end dates back to inclusive chapter ranges', () => {
    expect(chaptersFromUpdatedTask({
      start: chapterToGanttDate(9),
      end: chapterToGanttDate(13),
      type: 'task',
    })).toEqual({ startChapter: 9, endChapter: 12 })
  })

  it('maps only editable leaf tasks back to story mutations', () => {
    const tasks = buildEntityGanttTasks(conflict, 20)
    const stage = tasks.find((task) => task.storyTaskKind === 'band' && task.bandIndex === 1)!
    const summary = tasks.find((task) => task.storyTaskKind === 'track')!

    expect(mutationFromUpdatedTask({
      ...stage,
      start: chapterToGanttDate(10),
      end: chapterToGanttDate(15),
    })).toEqual({
      kind: 'span',
      entityId: 'c1',
      entityType: 'conflict',
      spanIndex: 1,
      startChapter: 10,
      endChapter: 14,
    })
    expect(mutationFromUpdatedTask(summary)).toBeNull()
  })

  it('projects ledger events and keeps standalone changes read-only', () => {
    const tasks = buildEntityGanttTasksWithLedger(conflict, 20, {
      events: [{
        id: 'event-1', projectId: 'p1', chapterNumber: 10, sceneId: null, sceneOrder: 0,
        type: 'conflict', title: '书房对质', summary: '', outcome: '', status: 'planned',
        parentEventId: null, source: 'manual', createdAt: 1, updatedAt: 1,
      }],
      changes: [{
        id: 'change-1', projectId: 'p1', storyEventId: 'event-1', chapterNumber: 10, sceneOrder: 0,
        subjectType: 'conflict', subjectId: 'c1', dimension: 'stage', targetType: null, targetId: null,
        valueType: 'enum', beforeValue: 'emerging', afterValue: 'escalating', reason: '对质', significance: 8,
        source: 'manual', cause: null, effectIds: [], createdAt: 1,
      }],
      annotations: [],
    })
    const event = tasks.find((task) => task.storyTaskKind === 'event')!
    const change = tasks.find((task) => task.storyTaskKind === 'change')!

    expect(mutationFromUpdatedTask({ ...event, start: chapterToGanttDate(11) })).toEqual({
      kind: 'event', eventId: 'event-1', chapter: 11,
    })
    expect(mutationFromUpdatedTask(change)).toBeNull()
  })
})
