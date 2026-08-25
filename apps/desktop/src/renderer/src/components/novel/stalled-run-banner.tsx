/**
 * StalledRunBanner：章节视图的"未完成创作"提示条。
 *
 * 背景：工作流断点续跑能力后端早已完备（resume 端点支持 runId='latest'），
 * 但入口不可见 —— 只有错误卡还在屏幕上时才能继续；应用重启/切页后，
 * 用户不知道本章有半成品（实测 30 次 run 仅 6 次续跑）。
 *
 * 本组件在会话面板空闲时查询当前章节是否有可续跑快照：
 * 有则展示停在哪一阶段、草稿字数、失败原因，提供「从断点继续」「弃用」。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { CircleAlert, PlayIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { discardResumableRun, listResumableRuns, type ResumableRunInfo } from '@/api/novel-client'

/** 阶段边界 → 用户可读描述（与 WorkflowRunPhase 对应） */
const PHASE_DESCRIPTIONS: Record<string, string> = {
  writing: '叙事任务已确认，正文尚未生成',
  reviewing: '草稿已成稿，停在审校阶段',
  memory: '正文已定稿，只差保存与记忆提取',
}

export interface StalledRunBannerProps {
  projectId?: string
  /** 当前章节号；null 表示无章节上下文，不展示 */
  chapterNumber?: number
  /** 创作流程运行中时不展示 */
  visible: boolean
  /** 点击"从断点继续"（父级调 resumeWorkflow） */
  onResume: (runId: string) => void
  /** 续跑启动时由父级置忙，本组件随之隐藏 */
}

function formatUpdatedAt(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export function StalledRunBanner({
  projectId,
  chapterNumber,
  visible,
  onResume,
}: StalledRunBannerProps): ReactElement | null {
  const [stalled, setStalled] = useState<ResumableRunInfo | null>(null)
  const [discarding, setDiscarding] = useState(false)

  const refresh = useCallback(async () => {
    if (!projectId || chapterNumber == null) {
      setStalled(null)
      return
    }
    try {
      const runs = await listResumableRuns(projectId)
      setStalled(runs.find((r) => r.chapterNumber === chapterNumber) ?? null)
    } catch {
      // 查询失败静默：提示条是增强功能，不应阻塞创作面板
      setStalled(null)
    }
  }, [projectId, chapterNumber])

  useEffect(() => {
    if (!visible) return
    void refresh()
  }, [visible, refresh])

  const handleDiscard = useCallback(async () => {
    if (!projectId || !stalled || discarding) return
    setDiscarding(true)
    try {
      await discardResumableRun(projectId, stalled.chapterNumber, stalled.runId)
      setStalled(null)
    } finally {
      setDiscarding(false)
    }
  }, [projectId, stalled, discarding])

  if (!visible || !stalled) return null

  const draftLength = Math.max(stalled.writerDraftLength, stalled.finalContentLength)
  const phaseText = PHASE_DESCRIPTIONS[stalled.phase] ?? `停在 ${stalled.phase} 阶段`

  return (
    <div
      data-tour="stalled-run-banner"
      className="mx-2 mt-2 shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/8 px-3 py-2"
    >
      <div className="flex items-center gap-2 min-w-0">
        <CircleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-text m-0">
            本章有一次未完成的创作
            <span className="ml-1.5 text-nano text-muted-foreground">{formatUpdatedAt(stalled.updatedAt)}</span>
          </p>
          <p className="text-nano text-muted-foreground m-0 mt-0.5 truncate">
            {phaseText}
            {draftLength > 0 && ` · 已有 ${draftLength.toLocaleString()} 字草稿`}
            {stalled.error ? ` · ${stalled.error.slice(0, 80)}` : ''}
          </p>
        </div>
        <Button
          size="sm"
          className="shrink-0 h-7"
          onClick={() => onResume(stalled.runId)}
          aria-label="从断点继续创作"
        >
          <PlayIcon className="size-3" />
          从断点继续
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 h-7 text-muted-foreground hover:text-destructive"
          onClick={() => void handleDiscard()}
          disabled={discarding}
          aria-label={`弃用第 ${stalled.chapterNumber} 章的中断记录`}
          title="放弃这份半成品（草稿将不再可恢复）"
        >
          <Trash2Icon className="size-3" />
          {discarding ? '弃用中…' : '弃用'}
        </Button>
      </div>
    </div>
  )
}
