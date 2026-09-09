import type { DesignBoardObject } from './design-board-types'

export type ResizeHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const RESIZE_HANDLE_IDS: ResizeHandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const OPPOSITE_HANDLE: Record<ResizeHandleId, ResizeHandleId> = {
  nw: 'se',
  n: 's',
  ne: 'sw',
  e: 'w',
  se: 'nw',
  s: 'n',
  sw: 'ne',
  w: 'e'
}

export function oppositeHandle(handle: ResizeHandleId): ResizeHandleId {
  return OPPOSITE_HANDLE[handle]
}

export function cursorForHandle(handle: ResizeHandleId): string {
  if (handle === 'n' || handle === 's') return 'ns-resize'
  if (handle === 'e' || handle === 'w') return 'ew-resize'
  if (handle === 'nw' || handle === 'se') return 'nwse-resize'
  return 'nesw-resize'
}

export function pointerToScene(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  scale: number,
  boardWidth: number,
  boardHeight: number
): { x: number; y: number } {
  const safeScale = scale > 0.01 ? scale : 0.01
  const x = (clientX - rect.left) / safeScale
  const y = (clientY - rect.top) / safeScale
  return {
    x: Math.max(0, Math.min(boardWidth, x)),
    y: Math.max(0, Math.min(boardHeight, y))
  }
}

// ── 吸附 ──

export function snapThresholdFor(boardWidth: number, boardHeight: number): number {
  return Math.max(8, Math.round(Math.min(boardWidth, boardHeight) * 0.0025))
}

const SNAP_DEADBAND = 0.25
const SNAP_STICKY_WINDOW = 0.5

interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

function objectBounds(object: DesignBoardObject): Bounds {
  return {
    left: object.x,
    top: object.y,
    right: object.x + object.width,
    bottom: object.y + object.height
  }
}

export interface SnapResult {
  dx: number
  dy: number
  guideX: number | null
  guideY: number | null
}

interface SnapCandidate {
  delta: number
  guide: number
  score: number
}

function bestSnapOnAxis(
  movingEdges: number[],
  targetLines: number[],
  threshold: number,
  prevGuide: number | null
): SnapCandidate | null {
  let best: SnapCandidate | null = null
  for (const edge of movingEdges) {
    for (const line of targetLines) {
      const delta = line - edge
      if (Math.abs(delta) >= threshold) continue
      const sticky = prevGuide !== null && Math.abs(line - prevGuide) < SNAP_STICKY_WINDOW
      const score = Math.abs(delta) - (sticky ? SNAP_STICKY_WINDOW : 0)
      if (!best || score < best.score) best = { delta, guide: line, score }
    }
  }
  return best
}

export function solveSnapDelta(
  moving: Bounds,
  targets: DesignBoardObject[],
  boardWidth: number,
  boardHeight: number,
  prevGuideX: number | null
): SnapResult {
  const threshold = snapThresholdFor(boardWidth, boardHeight)
  const movingXs = [moving.left, (moving.left + moving.right) / 2, moving.right]
  const movingYs = [moving.top, (moving.top + moving.bottom) / 2, moving.bottom]
  const targetXs: number[] = [0, boardWidth / 2, boardWidth]
  const targetYs: number[] = [0, boardHeight / 2, boardHeight]
  for (const target of targets) {
    const bounds = objectBounds(target)
    targetXs.push(bounds.left, (bounds.left + bounds.right) / 2, bounds.right)
    targetYs.push(bounds.top, (bounds.top + bounds.bottom) / 2, bounds.bottom)
  }
  const bestX = bestSnapOnAxis(movingXs, targetXs, threshold, prevGuideX)
  const bestY = bestSnapOnAxis(movingYs, targetYs, threshold, null)
  return {
    dx: bestX && Math.abs(bestX.delta) >= SNAP_DEADBAND ? bestX.delta : 0,
    dy: bestY && Math.abs(bestY.delta) >= SNAP_DEADBAND ? bestY.delta : 0,
    guideX: bestX ? bestX.guide : null,
    guideY: bestY ? bestY.guide : null
  }
}

// ── 缩放 ──

const MIN_SIZE = 12

export function resizeBoxWithHandle(
  initial: { x: number; y: number; width: number; height: number },
  handle: ResizeHandleId,
  pointer: { x: number; y: number },
  options: { keepRatio: boolean; centered?: boolean }
): { x: number; y: number; width: number; height: number } {
  const controlsX = handle !== 'n' && handle !== 's'
  const controlsY = handle !== 'e' && handle !== 'w'
  const anchorX = handle.includes('w') ? initial.x + initial.width : initial.x
  const anchorY = handle.includes('n') ? initial.y + initial.height : initial.y
  const centerX = initial.x + initial.width / 2
  const centerY = initial.y + initial.height / 2
  let width = controlsX ? Math.abs(pointer.x - anchorX) : initial.width
  let height = controlsY ? Math.abs(pointer.y - anchorY) : initial.height
  if (options.centered) {
    if (controlsX) width *= 2
    if (controlsY) height *= 2
  }
  if (options.keepRatio && controlsX && controlsY) {
    const initialRatio = initial.width / Math.max(1, initial.height)
    if (width / Math.max(1, height) > initialRatio) width = height * initialRatio
    else height = width / initialRatio
  }
  width = Math.max(MIN_SIZE, width)
  height = Math.max(MIN_SIZE, height)
  if (options.centered) {
    return {
      x: controlsX ? pointer.x - width / 2 : centerX - width / 2,
      y: controlsY ? pointer.y - height / 2 : centerY - height / 2,
      width,
      height
    }
  }
  const xDir = handle.includes('w') ? -1 : 1
  const yDir = handle.includes('n') ? -1 : 1
  return {
    x: anchorX + (xDir < 0 ? -width : 0),
    y: anchorY + (yDir < 0 ? -height : 0),
    width,
    height
  }
}
