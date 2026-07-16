import { describe, it, expect } from 'vitest'
import {
  computeVisibleChapters,
  getChapterLeft,
  getChapterNavigationTarget,
} from '@/lib/matrix-viewport'

describe('computeVisibleChapters', () => {
  const base = {
    sidebarWidth: 200,
    cellWidth: 36,
    maxChapter: 100,
  }

  it('scrollLeft=0 时返回前 N 个可见章节', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 0, viewportWidth: 800, overscan: 0 })
    // 0 - 200 = -200 → max(0) = 0; 可见宽度 = 800 - max(0, 200-0) = 600
    // startIdx = 0; endIdx = floor(600/36) = 16
    expect(r.start).toBe(1)
    expect(r.end).toBe(17) // 0-based 0..16 = 1..17
  })

  it('scrollLeft=500 时跳过左侧不可见章节', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 500, viewportWidth: 800, overscan: 0 })
    // contentScrollLeft = max(0, 500-200) = 300
    // startIdx = floor(300/36) = 8
    // visibleContentWidth = 800 - max(0, 200-500) = 800
    // endIdx = floor((300+800)/36) = floor(1100/36) = 30
    expect(r.start).toBe(9)
    expect(r.end).toBe(31)
  })

  it('overscan 默认 2，前后各加 2 列缓冲', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 0, viewportWidth: 800 })
    // 不带 overscan: start=1, end=17
    // 带 overscan=2: start=max(1, 1-2)=1, end=min(100, 17+2)=19
    expect(r.start).toBe(1)
    expect(r.end).toBe(19)
  })

  it('overscan 不超过边界', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 0, viewportWidth: 800, overscan: 100 })
    expect(r.start).toBe(1)
    expect(r.end).toBe(100)
  })

  it('scrollLeft 超出内容时返回空', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 99999, viewportWidth: 800 })
    expect(r.count).toBe(0)
  })

  it('maxChapter=0 返回空', () => {
    const r = computeVisibleChapters({ ...base, maxChapter: 0, scrollLeft: 0, viewportWidth: 800 })
    expect(r.count).toBe(0)
  })
})

describe('getChapterLeft', () => {
  it('章节 1 的 left = sidebarWidth', () => {
    expect(getChapterLeft(1, 200, 36)).toBe(200)
  })

  it('章节 N 的 left = sidebarWidth + (N-1) * cellWidth', () => {
    expect(getChapterLeft(5, 200, 36)).toBe(200 + 4 * 36)
  })
})

describe('getChapterNavigationTarget', () => {
  it('左右方向键逐章移动并限制在边界内', () => {
    expect(getChapterNavigationTarget('ArrowLeft', 1, 20)).toBe(1)
    expect(getChapterNavigationTarget('ArrowLeft', 8, 20)).toBe(7)
    expect(getChapterNavigationTarget('ArrowRight', 8, 20)).toBe(9)
    expect(getChapterNavigationTarget('ArrowRight', 20, 20)).toBe(20)
  })

  it('Home 和 End 分别跳到首章和末章', () => {
    expect(getChapterNavigationTarget('Home', 8, 20)).toBe(1)
    expect(getChapterNavigationTarget('End', 8, 20)).toBe(20)
  })

  it('忽略不属于标尺导航的按键', () => {
    expect(getChapterNavigationTarget('Enter', 8, 20)).toBeNull()
    expect(getChapterNavigationTarget('ArrowDown', 8, 20)).toBeNull()
  })
})
