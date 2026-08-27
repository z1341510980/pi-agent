/**
 * ChapterBeatBanner：创作面板的卷级节拍横幅。
 *
 * 创作流程启动后显示本章将服从的节拍约束（Director 决策顺序第 0 条），
 * 让用户在流程进行中随时能看到该章在整卷结构中的职责。
 * 数据源与大纲树章节行共享 useNovelBeatStore，编辑/重生成节拍后横幅实时同步。
 */
import type { ReactElement } from 'react'
import { Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNovelBeatStore } from '@/stores/novel-beat-store'
import { BEAT_FUNCTION_LABELS, BEAT_FUNCTION_ACCENTS } from './sidebar/beat-labels'

export interface ChapterBeatBannerProps {
  projectId?: string
  chapterNumber?: number
}

export function ChapterBeatBanner({
  projectId,
  chapterNumber
}: ChapterBeatBannerProps): ReactElement | null {
  const loadedProjectId = useNovelBeatStore((s) => s.loadedProjectId)
  const beat = useNovelBeatStore((s) =>
    chapterNumber != null
      ? s.beats.find((item) => item.chapterNumber === chapterNumber)
      : undefined
  )

  // 节拍数据未加载（共享 store 尚未拉取）或无目标章节时不渲染，避免误报「未规划」
  if (!projectId || chapterNumber == null || loadedProjectId !== projectId) return null

  const tooltip = beat
    ? [
        beat.emotionalDebt ? `情绪债务：${beat.emotionalDebt}` : '',
        beat.payoff ? `本章爽点：${beat.payoff}` : '',
        beat.summary ? `核心走向：${beat.summary}` : ''
      ]
      .filter(Boolean)
      .join('\n')
    : undefined

  return (
    <div
      className="shrink-0 border-b border-border/60 bg-muted/30 px-2.5 py-1.5 flex items-center gap-1.5 text-nano"
      title={tooltip}
    >
      <Zap
        className={cn(
          'size-3 shrink-0',
          beat ? BEAT_FUNCTION_ACCENTS[beat.dramaticFunction] : 'text-muted-foreground'
        )}
      />
      <span className="shrink-0 text-muted-foreground">本章节拍</span>
      {beat ? (
        <>
          <span
            className={cn('shrink-0 font-medium', BEAT_FUNCTION_ACCENTS[beat.dramaticFunction])}
          >
            {BEAT_FUNCTION_LABELS[beat.dramaticFunction]}
          </span>
          {beat.arcPosition && (
            <span className="shrink-0 text-muted-foreground">（{beat.arcPosition}）</span>
          )}
          {beat.summary && (
            <span className="truncate text-text-secondary">{beat.summary}</span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground">
          未规划——可在左侧大纲树章节行生成，或在节拍表分组整卷规划
        </span>
      )}
    </div>
  )
}
