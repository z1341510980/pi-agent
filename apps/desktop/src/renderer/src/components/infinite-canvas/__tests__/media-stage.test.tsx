import { describe, expect, it } from 'vitest'
import { fitStageSize, pointerToPercent } from '../media-stage'

describe('fitStageSize', () => {
  it('fits inside the container without distortion', () => {
    expect(fitStageSize({ width: 800, height: 600 }, { width: 480, height: 384 })).toEqual({
      width: 480,
      height: 360
    })
  })

  it('caps by container height when the image is tall', () => {
    expect(fitStageSize({ width: 600, height: 800 }, { width: 480, height: 300 })).toEqual({
      width: 225,
      height: 300
    })
  })

  it('keeps at least one pixel', () => {
    expect(fitStageSize({ width: 0, height: 0 }, { width: 480, height: 300 })).toEqual({
      width: 1,
      height: 1
    })
  })
})

describe('pointerToPercent', () => {
  it('maps pointer coordinates to clamped percentages', () => {
    expect(
      pointerToPercent({ x: 240, y: 90 }, { left: 0, top: 0, width: 480, height: 360 })
    ).toEqual({ x: 50, y: 25 })
    expect(
      pointerToPercent({ x: -10, y: 400 }, { left: 0, top: 0, width: 480, height: 360 })
    ).toEqual({ x: 0, y: 100 })
  })
})
