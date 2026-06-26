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

import { useMemo, useState, type ReactElement } from 'react'
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
  ChevronDown,
  ChevronUp,
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
import { cn } from '@/lib/utils'
import type {
  CreationPhase,
  CreationResult,
  CheckpointData,
  CheckpointDecision,
  AgentOutput,
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

// ── Agent 颜色映射 ──

const AGENT_COLOR_CLASSES: Record<AgentOutput['agentType'], string> = {
  director: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40',
  writer: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
  reviewer: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40',
  reviser: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40',
  memory: 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/40',
}

/** 格式化时间戳为 HH:mm:ss */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ── Agent 输出卡片（参考主聊天 MessageBubble 左对齐样式） ──

interface AgentOutputCardProps {
  output: AgentOutput
}

function AgentOutputCard({ output }: AgentOutputCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const showToggle = output.content.length > output.preview.length

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Badge
          variant="outline"
          className={cn('text-[10px] font-medium', AGENT_COLOR_CLASSES[output.agentType])}
        >
          {output.agentName}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          {formatTime(output.timestamp)}
        </span>
        {showToggle && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-5 px-1.5 text-[10px]"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3" />
                收起
              </>
            ) : (
              <>
                <ChevronDown className="size-3" />
                展开
              </>
            )}
          </Button>
        )}
      </div>
      <div className={cn('overflow-hidden', !expanded && 'max-h-32')}>
        <div className="prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed text-text-secondary
          prose-p:my-1.5 prose-p:leading-relaxed
          prose-headings:my-2 prose-headings:leading-tight
          prose-h1:text-sm prose-h2:text-xs prose-h3:text-xs
          prose-ul:my-1.5 prose-ol:my-1.5
          prose-li:my-0.5
          prose-pre:my-2 prose-pre:rounded-md prose-pre:bg-muted/60 prose-pre:border prose-pre:border-border prose-pre:overflow-x-auto
          prose-code:before:content-none prose-code:after:content-none prose-code:text-primary prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
          prose-blockquote:my-1.5 prose-blockquote:border-l-primary
          prose-a:text-primary
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {expanded ? output.content : output.preview}
          </ReactMarkdown>
        </div>
      </div>
      {!expanded && showToggle && (
        <Button
          size="sm"
          variant="link"
          className="h-5 px-0 text-[10px]"
          onClick={() => setExpanded(true)}
        >
          查看全部 {output.content.length} 字
        </Button>
      )}
    </div>
  )
}

// ── 检查点内容渲染 ──

/** 渲染 checkpoint.data.data 的实际内容（叙事任务/验收报告） */
function renderCheckpointData(checkpoint: CheckpointData): ReactElement | null {
  const outer = checkpoint.data as { message?: string; data?: unknown } | undefined
  if (!outer) return null

  const inner = outer.data

  if (typeof inner === 'string' && inner.trim()) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed text-text
        prose-p:my-1.5 prose-headings:my-2
        prose-h1:text-sm prose-h2:text-xs prose-h3:text-xs
        prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
        prose-pre:my-2 prose-pre:rounded-md prose-pre:bg-muted/60 prose-pre:border prose-pre:border-border prose-pre:overflow-x-auto
        prose-code:before:content-none prose-code:after:content-none prose-code:text-primary prose-code:bg-muted/60
        prose-blockquote:my-1.5 prose-blockquote:border-l-primary
        prose-a:text-primary
      ">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{inner}</ReactMarkdown>
      </div>
    )
  }

  if (inner && typeof inner === 'object') {
    return (
      <pre className="text-[11px] leading-relaxed bg-muted/40 border border-border rounded-md p-2 overflow-x-auto max-h-48">
        {JSON.stringify(inner, null, 2)}
      </pre>
    )
  }

  if (outer.message) {
    return <p className="text-xs text-text-secondary">{outer.message}</p>
  }

  return null
}

// ── 主组件 ──

export interface ChapterLiveViewProps {
  open: boolean
  phase: CreationPhase
  isRunning: boolean
  chapterContent: string
  /** 各 Agent 的输出时间线 */
  agentOutputs: AgentOutput[]
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
  agentOutputs,
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

  // 检查点的实际内容（叙事任务/验收报告）
  const checkpointContent = currentCheckpoint ? renderCheckpointData(currentCheckpoint) : null

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

        {/* Agent 输出时间线（参考主聊天消息流，左对齐卡片） */}
        {agentOutputs.length > 0 && (
          <div className="shrink-0 rounded-lg border border-border bg-background/50 p-2">
            <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
              <PenLine className="size-3" />
              <span>Agent 输出时间线</span>
              <Badge variant="secondary" className="text-[10px] h-4 px-1">
                {agentOutputs.length}
              </Badge>
            </div>
            <div className="space-y-2 max-h-[200px] overflow-y-auto pr-0.5">
              {agentOutputs.map((out, idx) => (
                <AgentOutputCard key={`${out.timestamp}-${idx}`} output={out} />
              ))}
            </div>
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto min-h-[160px] max-h-[40vh] rounded-lg border border-border bg-background p-4">
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

        {/* 检查点决策区：渲染实际叙事任务/验收报告内容 */}
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
              {checkpointContent && (
                <div className="mb-3 max-h-[180px] overflow-y-auto rounded-md bg-background/60 p-2">
                  {checkpointContent}
                </div>
              )}
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
