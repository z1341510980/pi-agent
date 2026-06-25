/**
 * 创作流程进度浮层
 *
 * 在画布右上角显示当前 Agent 阶段、进度条与已用时间。
 * 使用 Framer Motion 做入场/退场动画。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Clapperboard,
  PenLine,
  CheckCircle,
  RefreshCw,
  Brain,
  Clock,
  X,
  CheckCircle2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { CreationPhase } from '@/hooks/use-novel-creation-flow'

// ── 阶段元数据 ──

interface PhaseMeta {
  label: string
  icon: typeof Clapperboard
  /** 进度百分比 */
  progress: number
  /** 主题色（Tailwind 类） */
  color: string
}

const PHASE_META: Partial<Record<CreationPhase, PhaseMeta>> = {
  directing: { label: '导演分析', icon: Clapperboard, progress: 10, color: 'text-violet-500' },
  checkpoint_narrative: { label: '等待确认叙事任务', icon: Clapperboard, progress: 20, color: 'text-violet-500' },
  writing: { label: '写作创作中', icon: PenLine, progress: 40, color: 'text-emerald-500' },
  reviewing: { label: '审稿检查中', icon: CheckCircle, progress: 60, color: 'text-blue-500' },
  checkpoint_review: { label: '等待确认验收', icon: CheckCircle, progress: 65, color: 'text-blue-500' },
  revising: { label: '修订重写中', icon: RefreshCw, progress: 75, color: 'text-amber-500' },
  rewriting: { label: '重新创作中', icon: RefreshCw, progress: 30, color: 'text-amber-500' },
  memory: { label: '记忆提取中', icon: Brain, progress: 90, color: 'text-cyan-500' },
  completed: { label: '创作完成', icon: CheckCircle2, progress: 100, color: 'text-success' },
  cancelled: { label: '已取消', icon: X, progress: 0, color: 'text-muted-foreground' },
  error: { label: '出错', icon: X, progress: 0, color: 'text-destructive' },
}

export interface CreationProgressOverlayProps {
  phase: CreationPhase
  isRunning: boolean
  error: string | null
  onCancel: () => void
}

/** 格式化已用时间 mm:ss */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function CreationProgressOverlay({
  phase,
  isRunning,
  error,
  onCancel,
}: CreationProgressOverlayProps): ReactElement | null {
  const meta = PHASE_META[phase]
  const [elapsed, setElapsed] = useState(0)

  // 计时器：运行中每秒更新已用时间
  useEffect(() => {
    if (!isRunning) {
      setElapsed(0)
      return
    }
    const start = Date.now()
    const timer = setInterval(() => {
      setElapsed(Date.now() - start)
    }, 1000)
    return () => clearInterval(timer)
  }, [isRunning])

  const visible = isRunning || phase === 'completed' || phase === 'error' || phase === 'cancelled'

  const progress = useMemo(() => meta?.progress ?? 0, [meta])

  if (!visible || !meta) return null

  const Icon = meta.icon
  const isCheckpoint = phase === 'checkpoint_narrative' || phase === 'checkpoint_review'

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -12, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -12, scale: 0.95 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="absolute top-3 right-3 z-20 w-72 rounded-xl border border-border bg-card/95 backdrop-blur-sm shadow-lg"
      >
        {/* 头部：阶段名 + 图标 */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/60">
          <motion.div
            animate={isRunning && !isCheckpoint ? { scale: [1, 1.15, 1] } : {}}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
            className={cn('shrink-0', meta.color)}
          >
            <Icon className="size-4" />
          </motion.div>
          <span className="text-sm font-medium text-text flex-1 truncate">{meta.label}</span>
          {isRunning && (
            <Button size="icon-xs" variant="ghost" onClick={onCancel} title="取消" aria-label="取消创作">
              <X className="size-3" />
            </Button>
          )}
        </div>

        {/* 进度条 */}
        <div className="px-3 py-2.5 space-y-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <motion.div
              className={cn('h-full rounded-full', meta.color.replace('text-', 'bg-'))}
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>

          {/* 底部：百分比 + 已用时间 */}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{progress}%</span>
            {isRunning && (
              <span className="flex items-center gap-1">
                <Clock className="size-2.5" />
                {formatElapsed(elapsed)}
              </span>
            )}
          </div>

          {/* 检查点提示 */}
          {isCheckpoint && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-300"
            >
              请在章节实时预览面板中确认或修改
            </motion.div>
          )}

          {/* 错误信息 */}
          {phase === 'error' && error && (
            <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-[10px] text-destructive line-clamp-2">
              {error}
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
