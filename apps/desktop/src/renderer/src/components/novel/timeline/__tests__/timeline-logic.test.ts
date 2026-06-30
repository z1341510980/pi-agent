import { describe, it, expect } from 'vitest'
import {
  clampMoveRange,
  clampResizeRightRange,
  findSnapPoint,
  finalClampAfterSnap,
  buildRelationLines,
  computeMinimapViewportFrame,
  rangeToRestore,
  type EditAction,
} from '../timeline-logic'

describe('clampMoveRange', () => {
  it('keeps original range when delta is within bounds', () => {
    expect(clampMoveRange(5, 8, 2, 20)).toEqual({ start: 7, end: 10 })
  })
  it('clamps newEnd to maxChapter by limiting newStart', () => {
    const r = clampMoveRange(5, 8, 13, 20)
    expect(r.end).toBe(20)
    expect(r.start).toBe(17)
  })
  it('clamps newStart to 1', () => {
    expect(clampMoveRange(3, 6, -10, 20)).toEqual({ start: 1, end: 4 })
  })
  it('does not allow zero-length or inverted range when maxChapter < duration', () => {
    const r = clampMoveRange(1, 5, 0, 3)
    expect(r.start).toBeGreaterThanOrEqual(1)
    expect(r.end).toBeLessThanOrEqual(3)
  })
})

describe('clampResizeRightRange', () => {
  it('clamps newEnd to maxChapter', () => {
    expect(clampResizeRightRange(5, 8, 20, 20)).toBe(20)
  })
  it('clamps newEnd to at least origStart', () => {
    expect(clampResizeRightRange(5, 8, -10, 20)).toBe(5)
  })
})

describe('findSnapPoint', () => {
  const tracks = [
    {
      id: 't1', kind: 'character' as const, label: 'A', clips: [
        { id: 'c1', startChapter: 10, endChapter: 14, effectId: 'x', entityType: 'character' as const, entityId: 'e1', label: 'A' },
      ],
    },
  ]

  it('snaps to playhead when within SNAP_PX/chapterWidth distance', () => {
    const snap = findSnapPoint(5.98, 9.98, 280, 'c1', tracks, 6, 20)
    expect(snap).not.toBeNull()
    expect(snap!.chapter).toBe(6)
    expect(snap!.type).toBe('playhead')
  })

  it('does NOT snap when distance exceeds threshold', () => {
    const snap = findSnapPoint(5.8, 9.8, 280, 'c1', tracks, 6, 20)
    expect(snap).toBeNull()
  })

  it('snaps to clip endpoint', () => {
    const snap = findSnapPoint(11, 14, 80, 'other', tracks, 1, 20)
    expect(snap).not.toBeNull()
    expect(snap!.chapter).toBe(15)
    expect(snap!.type).toBe('clip-end')
  })

  it('excludes the clip being dragged', () => {
    const snap = findSnapPoint(10, 14, 80, 'c1', tracks, 1, 20)
    expect(snap).toBeNull()
  })
})

describe('finalClampAfterSnap', () => {
  it('clamps move range after snap to keep within [1, maxChapter]', () => {
    const r = finalClampAfterSnap('move', 19, 22, 5, 8, 20)
    expect(r.end).toBe(20)
    expect(r.start).toBe(17)
  })
  it('clamps newStart to 1 on resize-left after snap', () => {
    const r = finalClampAfterSnap('resize-left', 0, 8, 0, 8, 20)
    expect(r.start).toBe(1)
    expect(r.end).toBe(8)
  })
  it('clamps newEnd to maxChapter on resize-right after snap', () => {
    const r = finalClampAfterSnap('resize-right', 5, 25, 5, 8, 20)
    expect(r.end).toBe(20)
    expect(r.start).toBe(5)
  })
  it('leaves valid range untouched', () => {
    const r = finalClampAfterSnap('move', 7, 10, 5, 8, 20)
    expect(r).toEqual({ start: 7, end: 10 })
  })
})

describe('buildRelationLines', () => {
  it('builds character-character line when ranges overlap', () => {
    const tracks = [
      {
        id: 't1', kind: 'character' as const, label: 'A', clips: [
          { id: 'c1', startChapter: 1, endChapter: 10, effectId: 'x', entityType: 'character' as const, entityId: 'charA', label: 'A' },
        ],
      },
      {
        id: 't2', kind: 'character' as const, label: 'B', clips: [
          { id: 'c2', startChapter: 5, endChapter: 15, effectId: 'x', entityType: 'character' as const, entityId: 'charB', label: 'B' },
        ],
      },
    ]
    const rels = [{ id: 'r1', projectId: 'p', characterA: 'charA', characterB: 'charB', relationType: 'friendship', currentStage: '', stageHistory: '', createdAt: 0, updatedAt: 0 }]
    const lines = buildRelationLines(tracks, rels, [], 80, 36)
    expect(lines.length).toBe(1)
    expect(lines[0].relationType).toBe('friendship')
  })

  it('skips lines when ranges do not overlap', () => {
    const tracks = [
      {
        id: 't1', kind: 'character' as const, label: 'A', clips: [
          { id: 'c1', startChapter: 1, endChapter: 3, effectId: 'x', entityType: 'character' as const, entityId: 'charA', label: 'A' },
        ],
      },
      {
        id: 't2', kind: 'character' as const, label: 'B', clips: [
          { id: 'c2', startChapter: 10, endChapter: 15, effectId: 'x', entityType: 'character' as const, entityId: 'charB', label: 'B' },
        ],
      },
    ]
    const rels = [{ id: 'r1', projectId: 'p', characterA: 'charA', characterB: 'charB', relationType: 'friendship', currentStage: '', stageHistory: '', createdAt: 0, updatedAt: 0 }]
    expect(buildRelationLines(tracks, rels, [], 80, 36).length).toBe(0)
  })

  it('dedupes faction ally pairs bidirectionally', () => {
    const tracks = [
      {
        id: 't1', kind: 'faction' as const, label: 'F1', clips: [
          { id: 'c1', startChapter: 1, endChapter: 10, effectId: 'x', entityType: 'faction' as const, entityId: 'f1', label: 'F1' },
        ],
      },
      {
        id: 't2', kind: 'faction' as const, label: 'F2', clips: [
          { id: 'c2', startChapter: 1, endChapter: 10, effectId: 'x', entityType: 'faction' as const, entityId: 'f2', label: 'F2' },
        ],
      },
    ]
    const factions = [
      { id: 'f1', projectId: 'p', name: 'F1', description: '', type: 'organization' as const, leaderId: null, allies: ['f2'], enemies: [], strength: 'medium' as const, status: 'active' as const, createdAt: 0, updatedAt: 0 },
      { id: 'f2', projectId: 'p', name: 'F2', description: '', type: 'organization' as const, leaderId: null, allies: ['f1'], enemies: [], strength: 'medium' as const, status: 'active' as const, createdAt: 0, updatedAt: 0 },
    ]
    expect(buildRelationLines(tracks, [], factions, 80, 36).length).toBe(1)
  })
})

describe('computeMinimapViewportFrame', () => {
  it('computes left/width in px from chapter range', () => {
    // maxChapter=100, viewportStart=10, visible=20, containerWidth=500
    const f = computeMinimapViewportFrame(10, 20, 100, 500)
    // chapterW = 500/100 = 5; left = (10-1)*5 = 45; width = 20*5 = 100
    expect(f.left).toBe(45)
    expect(f.width).toBe(100)
  })

  it('enforces minimum width of 8px', () => {
    const f = computeMinimapViewportFrame(1, 1, 1000, 100)
    expect(f.width).toBeGreaterThanOrEqual(8)
  })
})

describe('rangeToRestore', () => {
  const action: EditAction = {
    type: 'delete',
    clip: { id: 'c1', startChapter: 3, endChapter: 8, entityType: 'conflict', entityId: 'e1' },
    before: { start: 3, end: 8 },
    after: { start: 0, end: -1 },
  }
  it('undo returns action.before', () => {
    expect(rangeToRestore(action, 'undo')).toEqual({ start: 3, end: 8 })
  })
  it('redo returns action.after', () => {
    expect(rangeToRestore(action, 'redo')).toEqual({ start: 0, end: -1 })
  })
})

import { groupContiguousSpans, planClipSplit } from '../timeline-logic'

describe('groupContiguousSpans', () => {
  it('groups adjacent chapter numbers into spans', () => {
    expect(groupContiguousSpans([1, 2, 3, 7, 8, 10])).toEqual([
      { start: 1, end: 3 },
      { start: 7, end: 8 },
      { start: 10, end: 10 },
    ])
  })
  it('handles empty input', () => {
    expect(groupContiguousSpans([])).toEqual([])
  })
  it('sorts unsorted input', () => {
    expect(groupContiguousSpans([5, 1, 2, 6])).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ])
  })
})

describe('planClipSplit', () => {
  it('produces first and second ranges for a split', () => {
    expect(planClipSplit(3, 10, 7)).toEqual({
      first: { start: 3, end: 6 },
      second: { start: 7, end: 10 },
    })
  })
  it('returns null first when atChapter <= start', () => {
    expect(planClipSplit(5, 10, 5)).toBeNull()
  })
  it('returns null second when atChapter > end', () => {
    expect(planClipSplit(5, 10, 11)).toEqual({ first: { start: 5, end: 10 }, second: null })
  })
})
