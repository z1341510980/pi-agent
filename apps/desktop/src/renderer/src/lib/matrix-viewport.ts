/**
 * 矩阵视口计算纯函数
 *
 * 水平虚拟化：根据 scrollLeft / viewportWidth / cellWidth 计算可见章节列范围
 * 与 @tanstack/react-virtual 的 useVirtualizer 思路一致，但更轻量
 */

export interface VisibleRange {
  start: number // 起始章节号（1-based，含）
  end: number // 结束章节号（1-based，含）
  count: number // 可见列数
}

export interface ComputeVisibleChaptersParams {
  scrollLeft: number
  viewportWidth: number
  sidebarWidth: number
  cellWidth: number
  maxChapter: number
  overscan?: number // 两侧缓冲列数，默认 2
}

export function computeVisibleChapters(params: ComputeVisibleChaptersParams): VisibleRange {
  const { scrollLeft, viewportWidth, sidebarWidth, cellWidth, maxChapter, overscan = 2 } = params

  if (maxChapter <= 0 || cellWidth <= 0) {
    return { start: 1, end: 0, count: 0 }
  }

  // 内容区起始 x = sidebarWidth，章节列从 sidebarWidth 开始排布
  // 章节号 N 的 left = sidebarWidth + (N - 1) * cellWidth
  // 可见区 left = scrollLeft，right = scrollLeft + viewportWidth

  // 左侧第一个可见章节号（不考虑 sidebar）
  const contentScrollLeft = Math.max(0, scrollLeft - sidebarWidth)
  let startIdx = Math.floor(contentScrollLeft / cellWidth) // 0-based
  // 右侧最后一个可见章节号
  const visibleContentWidth = Math.max(0, viewportWidth - Math.max(0, sidebarWidth - scrollLeft))
  let endIdx = Math.floor((contentScrollLeft + visibleContentWidth) / cellWidth)

  // 加 overscan 缓冲
  startIdx = Math.max(0, startIdx - overscan)
  endIdx = Math.min(maxChapter - 1, endIdx + overscan)

  if (startIdx > endIdx) {
    return { start: 1, end: 0, count: 0 }
  }

  const start = startIdx + 1 // 1-based
  const end = endIdx + 1
  return { start, end, count: end - start + 1 }
}

/**
 * 计算章节列在内容区内的 left 偏移
 */
export function getChapterLeft(chapter: number, sidebarWidth: number, cellWidth: number): number {
  return sidebarWidth + (chapter - 1) * cellWidth
}

/**
 * 将章节标尺的方向键转换为目标章节号。
 * 返回 null 表示该按键不属于标尺导航，交还浏览器处理。
 */
export function getChapterNavigationTarget(
  key: string,
  currentChapter: number,
  maxChapter: number,
): number | null {
  if (maxChapter <= 0) return null

  switch (key) {
    case 'ArrowLeft':
      return Math.max(1, currentChapter - 1)
    case 'ArrowRight':
      return Math.min(maxChapter, currentChapter + 1)
    case 'Home':
      return 1
    case 'End':
      return maxChapter
    default:
      return null
  }
}
