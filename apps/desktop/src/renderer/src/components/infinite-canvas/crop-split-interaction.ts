import { RESIZE_HANDLE_IDS, type ResizeHandleId } from './design-board/design-board-interaction'

export type CropHandle = ResizeHandleId
export const CROP_HANDLES: CropHandle[] = RESIZE_HANDLE_IDS

export type CropRect = { x: number; y: number; width: number; height: number }

export const MIN_CROP_PERCENT = 2
export const MIN_CUT_GAP = 5

export function clampCropRect(rect: CropRect): CropRect {
  const width = round2(Math.min(100, Math.max(MIN_CROP_PERCENT, rect.width)))
  const height = round2(Math.min(100, Math.max(MIN_CROP_PERCENT, rect.height)))
  return {
    x: round2(Math.min(100 - width, Math.max(0, rect.x))),
    y: round2(Math.min(100 - height, Math.max(0, rect.y))),
    width,
    height
  }
}

export function resizeCropRect(
  initial: CropRect,
  handle: CropHandle,
  pointer: { x: number; y: number },
  options: { ratio: number | null; natural: { width: number; height: number } }
): CropRect {
  const controlsX = handle !== 'n' && handle !== 's'
  const controlsY = handle !== 'e' && handle !== 'w'
  const anchorX = handle.includes('w') ? initial.x + initial.width : initial.x
  const anchorY = handle.includes('n') ? initial.y + initial.height : initial.y
  let width = initial.width
  let height = initial.height
  if (controlsX) width = Math.abs(pointer.x - anchorX)
  if (controlsY) height = Math.abs(pointer.y - anchorY)
  if (options.ratio !== null) {
    const safeWidth = Math.max(1, options.natural.width)
    const ratioPercent = (options.ratio * options.natural.height) / safeWidth
    if (controlsX && controlsY) {
      if (width > height * ratioPercent) height = width / ratioPercent
      else width = height * ratioPercent
    } else if (controlsX) {
      height = width / ratioPercent
    } else {
      width = height * ratioPercent
    }
  }
  width = Math.max(MIN_CROP_PERCENT, width)
  height = Math.max(MIN_CROP_PERCENT, height)
  let x = handle.includes('w') ? anchorX - width : anchorX
  let y = handle.includes('n') ? anchorY - height : anchorY
  if (options.ratio !== null && controlsX !== controlsY) {
    if (controlsX) y = initial.y + initial.height / 2 - height / 2
    else x = initial.x + initial.width / 2 - width / 2
  }
  return clampCropRect({ x, y, width, height })
}

export function moveCropRect(
  rect: CropRect,
  pointer: { x: number; y: number },
  grabOffset: { x: number; y: number }
): CropRect {
  return clampCropRect({
    x: pointer.x - grabOffset.x,
    y: pointer.y - grabOffset.y,
    width: rect.width,
    height: rect.height
  })
}

export function dragCropRect(
  anchor: { x: number; y: number },
  pointer: { x: number; y: number }
): CropRect {
  return clampCropRect({
    x: Math.min(anchor.x, pointer.x),
    y: Math.min(anchor.y, pointer.y),
    width: Math.abs(pointer.x - anchor.x),
    height: Math.abs(pointer.y - anchor.y)
  })
}

export function applyCropRatio(
  rect: CropRect,
  ratio: number,
  natural: { width: number; height: number }
): CropRect {
  const safeWidth = Math.max(1, natural.width)
  const ratioPercent = (ratio * natural.height) / safeWidth
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  let width = rect.width
  let height = width / ratioPercent
  if (height > rect.height) {
    height = rect.height
    width = height * ratioPercent
  }
  return clampCropRect({ x: centerX - width / 2, y: centerY - height / 2, width, height })
}

export function seedCuts(count: number): number[] {
  const safeCount = Math.max(1, Math.round(count))
  return Array.from({ length: safeCount - 1 }, (_, index) =>
    round2(((index + 1) * 100) / safeCount)
  )
}

export function normalizeCuts(values: number[]): number[] {
  const clamped = values.map((value) =>
    round2(Math.min(100 - MIN_CUT_GAP, Math.max(MIN_CUT_GAP, value)))
  )
  return [...new Set(clamped)].sort((a, b) => a - b)
}

export function addCut(cuts: number[]): number[] {
  const sorted = normalizeCuts(cuts)
  const boundaries = cutBoundaries(sorted)
  let bestIndex = 0
  let bestGap = -1
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const gap = boundaries[index + 1] - boundaries[index]
    if (gap > bestGap) {
      bestGap = gap
      bestIndex = index
    }
  }
  return normalizeCuts([...sorted, round2((boundaries[bestIndex] + boundaries[bestIndex + 1]) / 2)])
}

export function removeCut(cuts: number[]): number[] {
  if (!cuts.length) return cuts
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  cuts.forEach((cut, index) => {
    const distance = Math.abs(cut - 50)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return cuts.filter((_, index) => index !== bestIndex)
}

export function moveCut(cuts: number[], index: number, position: number): number[] {
  if (index < 0 || index >= cuts.length) return cuts
  const lower = index > 0 ? cuts[index - 1] + MIN_CUT_GAP : MIN_CUT_GAP
  const upper = index < cuts.length - 1 ? cuts[index + 1] - MIN_CUT_GAP : 100 - MIN_CUT_GAP
  const next = cuts.slice()
  next[index] = round2(Math.min(upper, Math.max(lower, position)))
  return next
}

export function adjustCutsToCount(cuts: number[], count: number): number[] {
  const target = Math.max(0, Math.round(count) - 1)
  let next = cuts.slice()
  while (next.length > target) next = removeCut(next)
  while (next.length < target) next = addCut(next)
  return next
}

export function cutBoundaries(cuts: number[]): number[] {
  return [0, ...cuts, 100]
}

export function piecePixelBounds(cuts: number[], totalPixels: number): number[] {
  const safeTotal = Math.max(1, Math.round(totalPixels))
  const sorted = [...new Set(cuts.map(round2))].sort((a, b) => a - b)
  const percentages = cutBoundaries(sorted)
  const bounds: number[] = []
  for (let index = 0; index < percentages.length; index += 1) {
    if (index === 0) {
      bounds.push(0)
      continue
    }
    if (index === percentages.length - 1) {
      bounds.push(safeTotal)
      continue
    }
    const bound = Math.round((percentages[index] / 100) * safeTotal)
    const remaining = percentages.length - 1 - index
    const previous = bounds[bounds.length - 1]
    bounds.push(Math.min(safeTotal - remaining, Math.max(previous + 1, bound)))
  }
  return bounds
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
