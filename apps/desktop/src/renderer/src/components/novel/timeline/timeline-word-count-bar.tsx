/**
 * TimelineWordCountBar：章节字数条形图
 *
 * 位置：时间轴底部 32px 独立条
 * 每章一个竖条，高度按 wordCount / maxWordCount * 32px
 * 颜色：< 1500 黄，> 5000 红，正常蓝
 */

import { type ReactElement } from 'react'
import type { NovelChapter } from '@/api/novel-client'

const BAR_HEIGHT = 32
const MIN_WORD_COUNT = 1500
const MAX_WORD_COUNT = 5000

export interface TimelineWordCountBarProps {
  chapters: NovelChapter[]
  chapterWidth: number
  maxChapter: number
  playheadChapter: number
  totalWidth?: number
  onChapterClick?: (chapter: number) => void
}

export function TimelineWordCountBar({
  chapters,
  chapterWidth,
  maxChapter,
  playheadChapter,
  totalWidth,
  onChapterClick,
}: TimelineWordCountBarProps): ReactElement {
  const wordCountMap = new Map<number, number>()
  let maxWordCount = 1
  for (const ch of chapters) {
    const wc = ch.wordCount ?? 0
    wordCountMap.set(ch.chapterNumber, wc)
    if (wc > maxWordCount) maxWordCount = wc
  }

  return (
    <div
      className="tl-word-count-bar"
      style={{ height: BAR_HEIGHT, width: totalWidth ?? '100%', minWidth: '100%' }}
    >
      {Array.from({ length: maxChapter }, (_, i) => i + 1).map((ch) => {
        const wc = wordCountMap.get(ch) ?? 0
        const heightRatio = Math.min(1, wc / Math.max(maxWordCount, MAX_WORD_COUNT))
        const height = Math.max(2, heightRatio * (BAR_HEIGHT - 4))
        const isCurrent = playheadChapter === ch
        let color = 'var(--color-primary)'
        if (wc > 0 && wc < MIN_WORD_COUNT) color = 'var(--color-warning, #f59e0b)'
        else if (wc > MAX_WORD_COUNT) color = 'var(--color-danger, #ef4444)'
        return (
          <div
            key={ch}
            className={`tl-word-count-bar-item ${isCurrent ? 'is-current' : ''} ${wc === 0 ? 'is-empty' : ''}`}
            style={{ width: chapterWidth, minWidth: chapterWidth }}
            onClick={() => onChapterClick?.(ch)}
            title={wc > 0 ? `第 ${ch} 章 · ${wc} 字` : `第 ${ch} 章 · 未生成`}
          >
            <div
              className="tl-word-count-bar-fill"
              style={{ height, background: color, opacity: wc === 0 ? 0.15 : 0.7 }}
            />
          </div>
        )
      })}
    </div>
  )
}
