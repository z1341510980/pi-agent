import { describe, expect, it } from 'vitest'
import type { DesignBoardObject } from '../design-board-types'
import {
  cursorForHandle,
  oppositeHandle,
  pointerToScene,
  resizeBoxWithHandle,
  snapThresholdFor,
  solveSnapDelta
} from '../design-board-interaction'

const obj = (x: number, y: number, width: number, height: number): DesignBoardObject => ({
  id: `o${x}`,
  kind: 'rect',
  x,
  y,
  width,
  height,
  fill: '#000',
  stroke: 'transparent',
  strokeWidth: 0,
  radius: 0
})

describe('pointerToScene', () => {
  it('converts client to scene coordinates and clamps inside the board', () => {
    const rect = { left: 100, top: 50, width: 540, height: 720 } as DOMRect
    expect(pointerToScene(190, 230, rect, 0.5, 1080, 1440)).toEqual({ x: 180, y: 360 })
    expect(pointerToScene(10, 10, rect, 0.5, 1080, 1440)).toEqual({ x: 0, y: 0 })
    expect(pointerToScene(9999, 9999, rect, 0.5, 1080, 1440)).toEqual({ x: 1080, y: 1440 })
  })
})

describe('snap', () => {
  it('computes threshold from board size', () => {
    expect(snapThresholdFor(1080, 1440)).toBe(8)
    expect(snapThresholdFor(4000, 4000)).toBe(10)
  })

  it('snaps moving edge to target edge within threshold', () => {
    const result = solveSnapDelta(
      { left: 303, top: 10, right: 403, bottom: 110 },
      [obj(300, 0, 100, 50)],
      1080,
      1440,
      null
    )
    expect(result.dx).toBe(-3)
    expect(result.guideX).toBe(300)
    expect(result.guideY).toBeNull()
  })

  it('returns zero delta beyond threshold and prefers board center', () => {
    const far = solveSnapDelta(
      { left: 400, top: 400, right: 500, bottom: 500 },
      [obj(0, 0, 100, 100)],
      1080,
      1440,
      null
    )
    expect(far.dx).toBe(0)
    const center = solveSnapDelta(
      { left: 541, top: 0, right: 641, bottom: 100 },
      [],
      1080,
      1440,
      null
    )
    expect(center.dx).toBe(-1)
    expect(center.guideX).toBe(540)
  })

  it('keeps previous guide when within sticky window', () => {
    const first = solveSnapDelta(
      { left: 303, top: 0, right: 403, bottom: 100 },
      [obj(300, 0, 100, 100)],
      1080,
      1440,
      null
    )
    const next = solveSnapDelta(
      { left: 300, top: 0, right: 400, bottom: 100 },
      [obj(300, 0, 100, 100)],
      1080,
      1440,
      first.guideX
    )
    expect(next.dx).toBe(0)
    expect(next.guideX).toBe(300)
  })
})

describe('resize', () => {
  it('maps handles to opposite anchors', () => {
    expect(oppositeHandle('nw')).toBe('se')
    expect(oppositeHandle('e')).toBe('w')
  })

  it('maps handles to css resize cursors', () => {
    expect(cursorForHandle('n')).toBe('ns-resize')
    expect(cursorForHandle('s')).toBe('ns-resize')
    expect(cursorForHandle('e')).toBe('ew-resize')
    expect(cursorForHandle('w')).toBe('ew-resize')
    expect(cursorForHandle('nw')).toBe('nwse-resize')
    expect(cursorForHandle('se')).toBe('nwse-resize')
    expect(cursorForHandle('ne')).toBe('nesw-resize')
    expect(cursorForHandle('sw')).toBe('nesw-resize')
  })

  it('resizes from se corner keeping top-left anchor', () => {
    const box = resizeBoxWithHandle(
      { x: 100, y: 100, width: 200, height: 100 },
      'se',
      { x: 200, y: 200 },
      { keepRatio: false }
    )
    expect(box).toEqual({ x: 100, y: 100, width: 100, height: 100 })
  })

  it('enforces 12px minimum and keep-ratio on corners', () => {
    const tiny = resizeBoxWithHandle(
      { x: 0, y: 0, width: 200, height: 100 },
      'se',
      { x: 2, y: 2 },
      { keepRatio: false }
    )
    expect(tiny.width).toBe(12)
    const ratio = resizeBoxWithHandle(
      { x: 0, y: 0, width: 200, height: 100 },
      'se',
      { x: 200, y: 300 },
      { keepRatio: true }
    )
    expect(Math.abs(ratio.width / ratio.height - 2)).toBeLessThan(0.01)
  })

  it('resizes symmetrically around center when centered', () => {
    const box = resizeBoxWithHandle(
      { x: 100, y: 100, width: 200, height: 100 },
      'e',
      { x: 300, y: 150 },
      { keepRatio: false, centered: true }
    )
    expect(box).toEqual({ x: 100, y: 100, width: 400, height: 100 })
  })
})
