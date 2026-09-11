import { describe, expect, it } from 'vitest'
import {
  addCut,
  adjustCutsToCount,
  applyCropRatio,
  clampCropRect,
  cutBoundaries,
  dragCropRect,
  moveCropRect,
  moveCut,
  normalizeCuts,
  piecePixelBounds,
  removeCut,
  resizeCropRect,
  seedCuts,
  MIN_CUT_GAP
} from '../crop-split-interaction'

const square = { width: 800, height: 800 }
const wide = { width: 800, height: 600 }

describe('crop rect helpers', () => {
  it('clamps position, size and rounds to two decimals', () => {
    expect(clampCropRect({ x: -5, y: 120, width: 40, height: 0.5 })).toEqual({
      x: 0,
      y: 98,
      width: 40,
      height: 2
    })
    expect(clampCropRect({ x: 33.333333, y: 10, width: 10, height: 10 })).toEqual({
      x: 33.33,
      y: 10,
      width: 10,
      height: 10
    })
  })

  it('resizes freely from the se handle with the nw corner anchored', () => {
    const next = resizeCropRect({ x: 0, y: 0, width: 100, height: 100 }, 'se', { x: 50, y: 40 }, {
      ratio: null,
      natural: square
    })
    expect(next).toEqual({ x: 0, y: 0, width: 50, height: 40 })
  })

  it('resizes from the nw handle with the se corner anchored', () => {
    const next = resizeCropRect({ x: 10, y: 10, width: 40, height: 40 }, 'nw', { x: 30, y: 20 }, {
      ratio: null,
      natural: square
    })
    expect(next).toEqual({ x: 30, y: 20, width: 20, height: 30 })
  })

  it('keeps a 1:1 ratio on corner handles by expanding the smaller axis', () => {
    const next = resizeCropRect({ x: 0, y: 0, width: 20, height: 20 }, 'se', { x: 50, y: 40 }, {
      ratio: 1,
      natural: square
    })
    expect(next).toEqual({ x: 0, y: 0, width: 50, height: 50 })
  })

  it('keeps ratio on edge handles and centers the other axis', () => {
    const next = resizeCropRect({ x: 0, y: 0, width: 100, height: 100 }, 'e', { x: 50, y: 50 }, {
      ratio: 1,
      natural: wide
    })
    // ratioPercent = 1 * 600 / 800 = 0.75 -> width 50 -> height 66.67
    expect(next).toEqual({ x: 0, y: 16.67, width: 50, height: 66.67 })
  })

  it('clamps the resized rect into the image bounds', () => {
    const next = resizeCropRect({ x: 0, y: 0, width: 100, height: 100 }, 'se', { x: 150, y: 150 }, {
      ratio: null,
      natural: square
    })
    expect(next).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('moves the rect and clamps it into bounds', () => {
    const next = moveCropRect({ x: 0, y: 0, width: 40, height: 40 }, { x: 90, y: 90 }, { x: 20, y: 20 })
    expect(next).toEqual({ x: 60, y: 60, width: 40, height: 40 })
  })

  it('builds a new rect from an anchor and pointer in any direction', () => {
    expect(dragCropRect({ x: 10, y: 10 }, { x: 60, y: 40 })).toEqual({
      x: 10,
      y: 10,
      width: 50,
      height: 30
    })
    expect(dragCropRect({ x: 70, y: 90 }, { x: 20, y: 30 })).toEqual({
      x: 20,
      y: 30,
      width: 50,
      height: 60
    })
  })

  it('reshapes the rect to a ratio around its center', () => {
    const next = applyCropRatio({ x: 0, y: 0, width: 100, height: 100 }, 1, wide)
    // ratioPercent = 0.75 -> full height 100 -> width 75, centered
    expect(next).toEqual({ x: 12.5, y: 0, width: 75, height: 100 })
  })
})

describe('cut line helpers', () => {
  it('seeds uniform cuts', () => {
    expect(seedCuts(1)).toEqual([])
    expect(seedCuts(2)).toEqual([50])
    expect(seedCuts(3)).toEqual([33.33, 66.67])
    expect(seedCuts(6)).toEqual([16.67, 33.33, 50, 66.67, 83.33])
  })

  it('normalizes cuts by sorting, clamping and deduplicating', () => {
    expect(normalizeCuts([60, 30, 30, 1, 120])).toEqual([5, 30, 60, 95])
  })

  it('adds a cut at the midpoint of the largest gap', () => {
    expect(addCut([])).toEqual([50])
    expect(addCut([25])).toEqual([25, 62.5])
    expect(addCut([25, 50])).toEqual([25, 50, 75])
  })

  it('removes the cut closest to the middle', () => {
    expect(removeCut([25, 50])).toEqual([25])
    expect(removeCut([20, 70])).toEqual([20])
    expect(removeCut([])).toEqual([])
  })

  it('moves a cut with a minimum gap to neighbours and borders', () => {
    expect(moveCut([50], 0, 0)).toEqual([MIN_CUT_GAP])
    expect(moveCut([50], 0, 100)).toEqual([100 - MIN_CUT_GAP])
    expect(moveCut([25, 50, 75], 1, 90)).toEqual([25, 70, 75])
    expect(moveCut([25, 50], 5, 60)).toEqual([25, 50])
  })

  it('adjusts cut count while keeping user positions', () => {
    expect(adjustCutsToCount([50], 3)).toEqual([25, 50])
    expect(adjustCutsToCount([25, 50], 2)).toEqual([25])
    expect(adjustCutsToCount([20, 80], 1)).toEqual([])
    expect(adjustCutsToCount([20, 80], 2)).toEqual([80])
  })

  it('exposes cut boundaries including image borders', () => {
    expect(cutBoundaries([25, 75])).toEqual([0, 25, 75, 100])
  })

  it('maps cuts to monotonically increasing pixel boundaries', () => {
    expect(piecePixelBounds([25, 75], 1000)).toEqual([0, 250, 750, 1000])
    expect(piecePixelBounds([], 600)).toEqual([0, 600])
    expect(piecePixelBounds([95, 99], 100)).toEqual([0, 95, 99, 100])
  })
})
