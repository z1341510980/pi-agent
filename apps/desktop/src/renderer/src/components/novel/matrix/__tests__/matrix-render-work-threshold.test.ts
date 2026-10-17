import { describe, expect, it } from 'vitest'
import { buildRowSpecs, computeRowOffsets, computeVisibleRowWindow } from '../matrix-model'

describe('matrix render work acceptance thresholds', () => {
  it('keeps a long matrix render window bounded by overscan rows', () => {
    const groups = Array.from({ length: 20 }, (_, groupIndex) => ({
      id: `group-${groupIndex}`,
      label: `组 ${groupIndex}`,
      entities: Array.from({ length: 100 }, (_, entityIndex) => ({
        id: `entity-${groupIndex}-${entityIndex}`,
        entityId: `entity-${groupIndex}-${entityIndex}`,
        kind: 'character' as const,
        name: `实体 ${groupIndex}-${entityIndex}`,
        spans: [],
      })),
    }))
    const rows = buildRowSpecs({
      groups,
      collapsedGroups: new Set(),
      activeFilter: null,
      expandedTrackCounts: new Map(),
    })
    const offsets = computeRowOffsets(rows)
    const visible = computeVisibleRowWindow({
      offsets,
      rows,
      scrollTop: 10_000,
      viewportHeight: 640,
      overscan: 6,
    })

    expect(rows.length).toBe(2020)
    expect(visible.end - visible.start + 1).toBeLessThanOrEqual(40)
  })
})
