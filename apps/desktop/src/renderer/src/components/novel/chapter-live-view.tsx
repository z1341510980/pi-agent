/**
 * 章节实时预览面板
 *
 * 在创作流程运行时以模态弹窗形式展示：
 * - writing 阶段：流式/打字指示器
 * - result 到达后：Markdown 渲染最终内容
 * - checkpoint 阶段：检查点决策按钮（approve/reject/revise/rewrite）
 * - 字数统计、预计阅读时间
 * - 保存到章节 / 丢弃按钮
 */

import { useMemo, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { motion, AnimatePresence } from 'framer-motion'
import {
  PenLine,
  Check,
  X,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  FileText,
  Clock,
  Loader2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type {
  CreationPhase,
  CreationResult,
  CheckpointData,
  CheckpointDecision,
} from '@/hooks/use-novel-creation-flow'

// ── 阶段标签 ──

const PHASE_LABELS: Partial<Record<CreationPhase, string>> = {
  directing: '导演分析中',
  checkpoint_narrative: '等待确认叙事任务',
  writing: '写作创作中',
  reviewing: '审稿检查中',
  checkpoint_review: '等待确认验收',
  revising: '修订重写中',
  rewriting: '重新创作中',
  memory: '记忆提取中',
  completed: '创作完成',
  cancelled: '已取消',
  error: '出错',
}

// ── 工具函数 ──

/** 计算中文字数（按字符计） */
function countWords(text: string): number {
  if (!text) return 0
  // 去除空白与 Markdown 标记后按字符计数
  const cleaned = text.replace(/[#*`>\-\[\]()!]/g, '').replace(/\s+/g, '')
  return cleaned.length
}

/** 预计阅读时间（中文约 400 字/分钟） */
function estimateReadTime(words: number): string {
  if (words === 0) return '0 分钟'
  const minutes = Math.max(1, Math.ceil(words / 400))
  return `${minutes} 分钟`
}

// ── 检查点决策按钮 ──

interface DecisionButton {
  decision: CheckpointDecision
  label: string
  icon: typeof Check
  variant: 'default' | 'outline' | 'destructive' | 'ghost'
}

const NARRATIVE_DECISIONS: DecisionButton[] = [
  { decision: 'approve', label: '确认', icon: Check, variant: 'default' },
  { decision: 'reject', label: '取消创作', icon: X, variant: 'destructive' },
]

const REVIEW_DECISIONS: DecisionButton[] = [
  { decision: 'approve', label: '通过', icon: Check, variant: 'default' },
  { decision: 'revise', label: '修订', icon: RefreshCw, variant: 'outline' },
  { decision: 'rewrite', label: '重写', icon: RotateCcw, variant: 'ghost' },
]

// ── 主组件 ──

export interface ChapterLiveViewProps {
  open: boolean
  phase: CreationPhase
  isRunning: boolean
  chapterContent: string
  chapterNumber?: number
  currentCheckpoint: CheckpointData | null
  result: CreationResult | null
  error: string | null
  onSubmitCheckpoint: (decision: CheckpointDecision) => void
  onSave: (content: string) => Promise<void>
  onDiscard: () => void
  onClose: () => void
}

export function ChapterLiveView({
  open,
  phase,
  isRunning,
  chapterContent,
  chapterNumber,
  currentCheckpoint,
  result,
  error,
  onSubmitCheckpoint,
  onSave,
  onDiscard,
  onClose,
}: ChapterLiveViewProps): ReactElement {
  const wordCount = useMemo(() => countWords(chapterContent), [chapterContent])
  const readTime = useMemo(() => estimateReadTime(wordCount), [wordCount])

  const isWriting = phase === 'writing'
  const isCheckpoint = phase === 'checkpoint_narrative' || phase === 'checkpoint_review'
  const isCompleted = phase === 'completed' && !!result?.content
  const canSave = isCompleted && !!chapterContent

  const decisions = currentCheckpoint?.type === 'narrative_task'
    ? NARRATIVE_DECISIONS
    : currentCheckpoint?.type === 'review'
      ? REVIEW_DECISIONS
      : []

  const handleSave = async (): Promise<void> => {
    if (!chapterContent) return
    await onSave(chapterContent)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4 text-emerald-500" />
            <span>章节实时预览</span>
            {chapterNumber != null && (
              <Badge variant="secondary" className="text-[10px]">第 {chapterNumber} 章</Badge>
            )}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            {isRunning && (
              <motion.span
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                className="flex items-center gap-1 text-xs"
              >
                <Loader2 className="size-3 animate-spin" />
                {PHASE_LABELS[phase] ?? phase}
              </motion.span>
            )}
            {!isRunning && phase === 'completed' && (
              <span className="text-xs text-success">创作完成</span>
            )}
            {!isRunning && phase === 'error' && (
              <span className="text-xs text-destructive">创作出错</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto min-h-[200px] max-h-[55vh] rounded-lg border border-border bg-background p-4">
          {/* 写作中：流式指示器 */}
          {isWriting && !chapterContent && (
            <div className="flex h-full items-center justify-center">
              <motion.div
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1.2, repeat: Infinity }}
                className="flex flex-col items-center gap-2 text-muted-foreground"
              >
                <PenLine className="size-6 text-emerald-500" />
                <span className="text-xs">写作 Agent 正在创作...</span>
              </motion.div>
            </div>
          )}

          {/* 写作中：部分内容 + 光标 */}
          {isWriting && chapterContent && (
            <div className="text-sm leading-relaxed text-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{chapterContent}</ReactMarkdown>
              <motion.span
                animate={{ opacity: [0, 1, 0] }}
                transition={{ duration: 1, repeat: Infinity }}
                className="inline-block w-0.5 h-4 bg-emerald-500 ml-0.5 align-middle"
                aria-hidden="true"
              />
            </div>
          )}

          {/* 完成：最终内容 */}
          {!isWriting && chapterContent && (
            <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed text-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{chapterContent}</ReactMarkdown>
            </div>
          )}

          {/* 空状态 */}
          {!isWriting && !chapterContent && !error && (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              等待创作流程启动...
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* 底部统计 */}
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <FileText className="size-2.5" />
            {wordCount} 字
          </span>
          <span className="flex items-center gap-1">
            <Clock className="size-2.5" />
            {readTime}
          </span>
          {result?.stateChanges && result.stateChanges.length > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {result.stateChanges.length} 项状态变更
            </Badge>
          )}
        </div>

        {/* 检查点决策按钮 */}
        <AnimatePresence>
          {isCheckpoint && currentCheckpoint && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
            >
              <p className="text-xs text-amber-700 dark:text-amber-300 mb-2">
                {currentCheckpoint.type === 'narrative_task'
                  ? '请确认导演 Agent 规划的叙事任务：'
                  : '请确认审稿 Agent 的验收报告：'}
              </p>
              <div className="flex items-center gap-2">
                {decisions.map((d) => (
                  <Button
                    key={d.decision}
                    size="sm"
                    variant={d.variant}
                    onClick={() => onSubmitCheckpoint(d.decision)}
                  >
                    <d.icon className="size-3" />
                    {d.label}
                  </Button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {isRunning && (
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              <Trash2 className="size-3" />
              丢弃
            </Button>
          )}
          {canSave && (
            <Button size="sm" onClick={handleSave} disabled={!chapterContent}>
              <Save className="size-3" />
              保存到章节
            </Button>
          )}
          {!isRunning && (
            <Button size="sm" variant="outline" onClick={onClose}>
              关闭
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
