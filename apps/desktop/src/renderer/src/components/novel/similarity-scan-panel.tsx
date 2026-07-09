/**
 * 相似度扫描实时进度面板（内嵌于右侧栏）
 *
 * 在 LLM 相似度扫描进行时以右侧栏内嵌面板形式展示：
 * - 扫描阶段指示器（preparing/generating/parsing/completed/fallback）
 * - 进度事件时间线
 * - 扫描完成后的统计摘要
 * - 取消按钮
 */

import { type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkle, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SimilarityScanProgressEvent } from '@/api/novel-client'
import type { SimilarityScanPhase } from '@/hooks/use-novel-similarity-scan'

// ── 阶段标签 + 图标 ──

const PHASE_META: Record<SimilarityScanPhase, { label: string; color: string }> = {
  idle: { label: '待机', color: 'text-muted-foreground' },
  scanning: { label: '扫描中', color: 'text-blue-500' },
  completed: { label: '扫描完成', color: 'text-emerald-500' },
  cancelled: { label: '已取消', color: 'text-muted-foreground' },
  error: { label: '出错', color: 'text-red-500' },
}

/** 进度事件阶段图标 */
function ProgressEventIcon({ phase }: { phase: SimilarityScanProgressEvent['phase'] }): ReactElement {
  if (phase === 'completed') return <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
  if (phase === 'fallback') return <AlertCircle className="size-3.5 text-amber-500 shrink-0" />
  return <Loader2 className="size-3.5 text-blue-500 shrink-0 animate-spin" />
}

// ── 组件 ──

export interface SimilarityScanPanelProps {
  phase: SimilarityScanPhase
  isScanning: boolean
  progressEvents: SimilarityScanProgressEvent[]
  /** 扫描完成后的相似组数量 */
  groupCount: number
  error: string | null
  onCancel: () => void
  onReset: () => void
}

export function SimilarityScanPanel({
  phase,
  isScanning,
  progressEvents,
  groupCount,
  error,
  onCancel,
  onReset,
}: SimilarityScanPanelProps): ReactElement {
  const meta = PHASE_META[phase] ?? PHASE_META.idle

  return (
    <div className="h-full flex flex-col bg-surface-1">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkle className="size-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-text truncate">AI 相似度整理</div>
            <div className={`text-[11px] ${meta.color} font-medium`}>{meta.label}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isScanning && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              className="h-7 text-xs text-muted-foreground hover:text-text"
            >
              <X className="size-3.5" />
              取消
            </Button>
          )}
          {!isScanning && phase !== 'idle' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onReset}
              className="h-7 text-xs text-muted-foreground hover:text-text"
            >
              关闭
            </Button>
          )}
        </div>
      </div>

      {/* 进度事件时间线 */}
      <div className="flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3">
            <AlertCircle className="size-4 text-red-500 shrink-0 mt-0.5" />
            <div className="text-xs text-red-600 leading-relaxed">{error}</div>
          </div>
        ) : progressEvents.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            {isScanning ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                等待扫描进度...
              </span>
            ) : (
              '等待启动扫描'
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {progressEvents.map((evt, idx) => (
                <motion.div
                  key={`evt-${idx}`}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 rounded-md bg-surface-2/50 border border-border/60 p-2.5"
                >
                  <ProgressEventIcon phase={evt.phase} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium mb-0.5">
                      {evt.phase}
                    </div>
                    <div className="text-xs text-text leading-relaxed break-words">
                      {evt.message}
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* 底部统计 */}
      {phase === 'completed' && (
        <div className="px-4 py-3 border-t border-border bg-surface-2/50 shrink-0">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">发现相似组</span>
            <span className="text-text font-medium tabular-nums">
              {groupCount} 组{groupCount > 0 ? '（请在弹框中勾选合并）' : '，无需整理'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
