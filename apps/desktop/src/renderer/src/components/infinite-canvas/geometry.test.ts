import { describe, expect, it } from 'vitest'
import {
  findContainingGroupId,
  findGroupDropTarget,
  normalizeConnection,
  snapNodesIntoGroup
} from './geometry'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

const node = (
  id: string,
  type: string,
  x: number,
  y: number,
  width = 100,
  height = 80
): CanvasNodeData => ({
  id,
  type,
  title: id,
  position: { x, y },
  width,
  height,
  metadata: {}
})

describe('infinite canvas geometry', () => {
  it('finds the topmost containing group and snaps a moved node', () => {
    const group = node('group', 'group', 0, 0, 400, 300)
    const child = node('child', 'text', 50, 50)
    expect(findContainingGroupId(child, [group, child])).toBe('group')
    const moved = snapNodesIntoGroup(
      new Set(['child']),
      [group, { ...child, position: { x: -100, y: -100 } }],
      group
    )
    expect(moved.find((item) => item.id === 'child')?.metadata?.groupId).toBe('group')
    expect(moved.find((item) => item.id === 'child')?.position.x).toBe(24)
  })

  it('chooses a group drop target and rejects invalid config/group connections', () => {
    const group = node('group', 'group', 0, 0, 400, 300)
    const text = node('text', 'text', 50, 50)
    const config = node('config', 'config', 500, 50)
    expect(findGroupDropTarget(new Set(['text']), [group, text])).toBe(group)
    expect(normalizeConnection('text', 'config', [text, config], 'source')).toEqual({
      fromNodeId: 'text',
      toNodeId: 'config'
    })
    expect(
      normalizeConnection(
        'config',
        'config',
        [config, node('config2', 'config', 700, 50)],
        'source'
      )
    ).toBeNull()
    expect(normalizeConnection('text', 'group', [text, group], 'source')).toBeNull()
  })
})
