import { describe, it, expect } from 'vitest'
import { clampMoveRange, clampResizeRightRange } from '../timeline-logic'

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
