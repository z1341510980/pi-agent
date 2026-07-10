/**
 * NovelConversationPanel：小说右栏对话面板
 *
 * 替换 ChapterLivePanel，用对话气泡流展示编排/群聊/反推/AI编排四个流程。
 * - 顶部 Tab 切换流程类型
 * - 中间 ConversationStream 展示消息气泡流
 * - 底部 ConversationInput 输入区
 *
 * 数据映射：
 * - agentOutputs → assistant 消息气泡
 * - userMessages → user 消息气泡
 * - currentCheckpoint → checkpoint 消息卡片
 * - 流程完成 → system 消息 + 操作按钮
 */

import { useMemo, useCallback, type ReactElement } from 'react'
import { Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { Badge } from '@/components/ui/badge'
import { ErrorCard } from '@/components/chat/error-card'
import { cn } from '@/lib/utils'
import {
  ConversationStream,
  ConversationInput,
  type ConversationMessage,
  type ConversationAgentType,
} from '@/components/shared/conversation'
import type {
  CreationPhase,
  CreationResult,
  CheckpointData,
  CheckpointDecision,
  AgentOutput,
  UserMessage,
} from '@/hooks/use-novel-creation-flow'

// ── 流程类型 ──

export type NovelFlowType = 'workflow' | 'discussion' | 'reverse' | 'arrange'

interface FlowTab {
  type: NovelFlowType
  label: string
}

const FLOW_TABS: FlowTab[] = [
  { type: 'workflow', label: '工作流' },
  { type: 'discussion', label: '群聊' },
  { type: 'reverse', label: '反推' },
  { type: 'arrange', label: '矩阵编排' },
]

// ── 阶段标签 ──

const PHASE_LABELS: Partial<Record<CreationPhase, string>> = {
  idle: '等待开始',
  directing: '导演分析中',
  checkpoint_narrative: '等待确认叙事任务',
  writing: '写作创作中',
  reviewing: '审稿检查中',
  checkpoint_review: '等待确认验收',
  revising: '修订重写中',
  rewriting: '重新创作中',
  memory: '记忆提取中',
  arranging: 'AI 编排矩阵中',
  completed: '完成',
  cancelled: '已取消',
  error: '出错',
}

// ── 检查点决策选项 ──

const NARRATIVE_OPTIONS = [
  { label: '确认', action: 'approve', variant: 'default' as const },
  { label: '按意见重写', action: 'rewrite', variant: 'outline' as const },
  { label: '取消创作', action: 'reject', variant: 'destructive' as const },
]

const REVIEW_OPTIONS = [
  { label: '通过', action: 'approve', variant: 'default' as const },
  { label: '修订', action: 'revise', variant: 'outline' as const },
  { label: '重写', action: 'rewrite', variant: 'ghost' as const },
]

// ── 检查点内容渲染 ──

/** 渲染 checkpoint.data 的实际内容 */
function renderCheckpointContent(checkpoint: CheckpointData): string {
  const data = checkpoint.data
  if (data == null) return ''

  if (typeof data === 'string') {
    return data
  }

  if (typeof data === 'object') {
    const outer = data as { message?: string; data?: unknown }
    const inner = outer.data
    if (typeof inner === 'string') return inner
    if (inner && typeof inner === 'object') return '```json\n' + JSON.stringify(inner, null, 2) + '\n```'
    if (outer.message) return outer.message
  }

  return ''
}

// ── Agent 类型映射 ──

/** 将 creationFlow 的 agentType 映射到 ConversationAgentType */
function mapAgentType(agentType: AgentOutput['agentType']): ConversationAgentType {
  // creationFlow 的 agentType 已与 ConversationAgentType 兼容
  return agentType as ConversationAgentType
}

// ── Props ──

export interface NovelConversationPanelProps {
  /** 当前阶段 */
  phase: CreationPhase
  /** 是否正在运行 */
  isRunning: boolean
  /** 累积的章节内容 */
  chapterContent: string
  /** 各 Agent 的输出时间线 */
  agentOutputs: AgentOutput[]
  /** 当前章节号 */
  chapterNumber?: number
  /** 待处理的检查点 */
  currentCheckpoint: CheckpointData | null
  /** 最终结果 */
  result: CreationResult | null
  /** 错误信息 */
  error: string | null
  /** 错误后重试回调 */
  onRetry?: () => void
  /** 错误后丢弃回调 */
  onDismissError?: () => void
  /** 创作模式 */
  creationMode?: 'manual' | 'ai-arrange' | null
  /** 提交检查点决策 */
  onSubmitCheckpoint: (decision: CheckpointDecision) => void
  /** 保存章节 */
  onSave: (content: string) => Promise<void>
  /** 丢弃 */
  onDiscard: () => void
  /** 用户发送消息 */
  onSendMessage?: (message: string) => void
  /** 用户消息历史 */
  userMessages?: UserMessage[]
  /** 当前流程类型 */
  flowType: NovelFlowType
  /** 切换流程类型 */
  onFlowTypeChange: (type: NovelFlowType) => void
  /** 启动流程 */
  onStartFlow: () => void
  /** 取消流程 */
  onCancelFlow: () => void
}

export function NovelConversationPanel({
  phase,
  isRunning,
  chapterContent,
  agentOutputs,
  chapterNumber,
  currentCheckpoint,
  error,
  onRetry,
  onDismissError,
  onSubmitCheckpoint,
  onSave,
  onDiscard,
  onSendMessage,
  userMessages,
  flowType,
  onFlowTypeChange,
  onStartFlow,
  onCancelFlow,
}: NovelConversationPanelProps): ReactElement {
  const isArrangeMode = flowType === 'arrange'
  const isReverseMode = flowType === 'reverse'
  const isCompleted = phase === 'completed'
  const isError = phase === 'error'
  // 反推和AI编排不生成正文，不显示"保存到章节"
  const canSave = isCompleted && !!chapterContent && !isArrangeMode && !isReverseMode

  // ── 完成时的动作标签 ──
  const completedActionLabel = isArrangeMode
    ? '编排'
    : isReverseMode
      ? '反推'
      : '创作'

  // ── 数据映射：agentOutputs + userMessages + checkpoint → ConversationMessage[] ──
  const messages = useMemo<ConversationMessage[]>(() => {
    const msgs: ConversationMessage[] = []

    // Agent 输出 → assistant 消息
    for (const output of agentOutputs) {
      msgs.push({
        id: `agent-${output.timestamp}-${output.agentType}`,
        role: 'assistant',
        agentName: output.agentName,
        agentType: mapAgentType(output.agentType),
        content: output.streaming ? output.preview : output.content,
        streamingBuffer: output.streaming ? output.content : undefined,
        status: output.streaming ? 'streaming' : 'complete',
        timestamp: output.timestamp,
      })
    }

    // 用户消息 → user 消息
    for (const msg of userMessages ?? []) {
      msgs.push({
        id: `user-${msg.id}`,
        role: 'user',
        content: msg.content,
        status: 'complete',
        timestamp: msg.timestamp,
      })
    }

    // 检查点 → checkpoint 消息
    if (currentCheckpoint) {
      const isNarrative = currentCheckpoint.type === 'narrative_task'
      msgs.push({
        id: `checkpoint-${currentCheckpoint.checkpointId ?? currentCheckpoint.phase}`,
        role: 'checkpoint',
        content: renderCheckpointContent(currentCheckpoint),
        status: 'complete',
        timestamp: Date.now(),
        checkpointType: isNarrative ? 'narrative' : 'review',
        checkpointOptions: isNarrative ? NARRATIVE_OPTIONS : REVIEW_OPTIONS,
        checkpointResolved: currentCheckpoint.decision,
      })
    }

    // 流程完成 → system 消息
    if (isCompleted) {
      msgs.push({
        id: 'system-completed',
        role: 'system',
        content: `第 ${chapterNumber ?? ''} 章${completedActionLabel}完成`,
        status: 'complete',
        timestamp: Date.now(),
        systemActions: canSave
          ? [
              { label: '保存到章节', action: 'save', variant: 'default' as const },
              { label: '丢弃', action: 'discard', variant: 'outline' as const },
            ]
          : [{ label: '完成', action: 'discard', variant: 'outline' as const }],
      })
    }

    // 按时间戳排序
    return msgs.sort((a, b) => a.timestamp - b.timestamp)
  }, [agentOutputs, userMessages, currentCheckpoint, isCompleted, completedActionLabel, canSave, chapterNumber])

  // ── 回调 ──
  const handleSend = useCallback((text: string) => {
    if (isRunning) {
      onSendMessage?.(text)
    }
  }, [isRunning, onSendMessage])

  const handleAbort = useCallback(() => {
    onCancelFlow()
  }, [onCancelFlow])

  const handleCheckpointResolve = useCallback((action: string) => {
    onSubmitCheckpoint(action as CheckpointDecision)
  }, [onSubmitCheckpoint])

  const handleSystemAction = useCallback((action: string) => {
    if (action === 'save') {
      if (chapterContent) void onSave(chapterContent)
    } else if (action === 'discard') {
      onDiscard()
    }
  }, [chapterContent, onSave, onDiscard])

  // 空状态提示
  const emptyHint = isReverseMode
    ? '点击"开始"从章节正文反向提取实体到矩阵'
    : isArrangeMode
      ? '点击"开始"让 AI 自动编排本章矩阵实体'
      : '点击"开始"启动创作流程'

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── 流程 Tab ── */}
      <header className="shrink-0 border-b border-border bg-surface-1">
        <div className="flex items-center gap-1 px-2 pt-2">
          {FLOW_TABS.map((tab) => (
            <button
              key={tab.type}
              onClick={() => !isRunning && onFlowTypeChange(tab.type)}
              disabled={isRunning}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
                flowType === tab.type
                  ? 'bg-background text-text border-x border-t border-border -mb-px'
                  : 'text-muted-foreground hover:text-text hover:bg-surface-2',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {/* 状态栏 */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-background border-t border-border">
          {chapterNumber != null && (
            <Badge variant="secondary" className="text-[10px] shrink-0 tabular-nums">
              第 {chapterNumber} 章
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {isRunning && (
              <motion.span
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                className="flex items-center gap-1 text-[11px] text-muted-foreground"
              >
                <Loader2 className="size-3 animate-spin" />
                {PHASE_LABELS[phase] ?? phase}
              </motion.span>
            )}
            {!isRunning && isCompleted && (
              <span className="text-[11px] text-emerald-600">
                {completedActionLabel}完成
              </span>
            )}
            {!isRunning && isError && (
              <span className="text-[11px] text-destructive">出错</span>
            )}
            {!isRunning && phase === 'idle' && (
              <span className="text-[11px] text-muted-foreground">等待开始</span>
            )}
          </div>
        </div>
      </header>

      {/* ── 消息流 ── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {error ? (
          <div className="p-3">
            <ErrorCard message={error} onRetry={onRetry} onDismiss={onDismissError} />
          </div>
        ) : (
          <ConversationStream
            messages={messages}
            onCheckpointResolve={handleCheckpointResolve}
            onSystemAction={handleSystemAction}
            emptyHint={emptyHint}
          />
        )}
      </div>

      {/* ── 输入区 ── */}
      <div className="shrink-0 border-t border-border">
        <ConversationInput
          onSend={handleSend}
          onAbort={handleAbort}
          isRunning={isRunning}
          // 反推和AI编排时用户不参与，输入框始终禁用
          disabled={isReverseMode || isArrangeMode}
          placeholder={
            isReverseMode
              ? '反推流程进行中...'
              : isArrangeMode
                ? 'AI编排进行中...'
                : isRunning
                  ? '输入补充意见参与创作...'
                  : '点击开始按钮启动流程'
          }
          showStart={!isRunning && phase === 'idle'}
          startLabel="开始"
          onStart={onStartFlow}
        />
      </div>
    </div>
  )
}
