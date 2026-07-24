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

import { useMemo, useCallback, useState, useRef, useEffect, type ReactElement } from 'react'
import { Loader2, Workflow, MessagesSquare, RotateCcw, LayoutGrid, MessageCircle, MoreHorizontal, type LucideIcon } from 'lucide-react'
import { motion } from 'framer-motion'
import { ErrorCard } from '@/components/chat/error-card'
import { cn } from '@/lib/utils'
import {
  ConversationStream,
  ConversationInput,
  ConversationEmptyState,
  type ConversationMessage,
  type ConversationAgentType,
  type MentionOption,
  type EmptyStateVariant,
} from '@/components/shared/conversation'
import type {
  CreationPhase,
  CreationResult,
  CheckpointData,
  CheckpointDecision,
  AgentOutput,
  UserMessage,
} from '@/hooks/use-novel-creation-flow'
import { formatDetailBubble } from '@/hooks/use-novel-creation-flow'
import type { ChapterChatMessage } from '@/api/novel-client'
import type { ChatAgentOutput } from '@/hooks/use-chapter-chat'

// ── 流程类型 ──

export type NovelFlowType = 'workflow' | 'discussion' | 'reverse' | 'arrange' | 'chat'

interface FlowTab {
  type: NovelFlowType
  label: string
  icon: LucideIcon
  description?: string
}

const FLOW_TABS: FlowTab[] = [
  { type: 'workflow', label: '工作流', icon: Workflow },
  {
    type: 'discussion',
    label: '群聊·高级',
    icon: MessagesSquare,
    description: '适合多角色谈判、博弈和高潮场景；调用轮次和耗时高于默认工作流',
  },
  { type: 'reverse', label: '反推', icon: RotateCcw },
  { type: 'arrange', label: '矩阵编排', icon: LayoutGrid },
  { type: 'chat', label: '聊天', icon: MessageCircle },
]

/** 高频模式：始终显示为 Segmented Control */
const PRIMARY_FLOW_TABS = FLOW_TABS.filter((t) => t.type === 'workflow' || t.type === 'chat')
/** 低频模式：收进 ··· Popover */
const SECONDARY_FLOW_TABS = FLOW_TABS.filter((t) => t.type !== 'workflow' && t.type !== 'chat')

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
  { label: '确认', action: 'approve', variant: 'default' as const, description: '按此叙事任务继续写作' },
  { label: '按意见重写', action: 'rewrite', variant: 'outline' as const, description: '提供修改意见后重新规划' },
  { label: '取消创作', action: 'reject', variant: 'destructive' as const, description: '中止本次创作流程' },
]

const REVIEW_OPTIONS = [
  { label: '通过', action: 'approve', variant: 'default' as const, description: '验收通过，进入下一阶段' },
  { label: '修订', action: 'revise', variant: 'outline' as const, description: '交由 Reviser 局部修订' },
  { label: '重写', action: 'rewrite', variant: 'ghost' as const, description: '退回 Writer 重新创作' },
]

// PostWriteGuard 命中后让用户选择是否重写 Writer
const POST_WRITE_GUARD_OPTIONS = [
  { label: '重写', action: 'rewrite', variant: 'default' as const, description: '退回 Writer 按守护意见重写' },
  { label: '接受草稿', action: 'approve', variant: 'outline' as const, description: '忽略守护警告，保留当前草稿' },
  { label: '转 Reviser', action: 'revise', variant: 'ghost' as const, description: '交由 Reviser 局部修正' },
  { label: '取消', action: 'reject', variant: 'destructive' as const, description: '中止本次创作流程' },
]

// Writer 推回 Director 时让用户选择是否同意推回
const WRITER_PUSHBACK_OPTIONS = [
  { label: '同意推回', action: 'approve', variant: 'default' as const, description: '接受 Writer 的推回建议' },
  { label: '强制继续', action: 'rewrite', variant: 'outline' as const, description: '忽略推回，按原任务继续' },
  { label: '取消创作', action: 'reject', variant: 'destructive' as const, description: '中止本次创作流程' },
]

// Guard 达上限后让用户选择是否接受当前草稿
const GUARD_DEGRADED_OPTIONS = [
  { label: '接受草稿', action: 'approve', variant: 'default' as const, description: '守护已达重试上限，接受当前版本' },
  { label: '从头重写', action: 'rewrite', variant: 'outline' as const, description: '不计重试次数，重新创作' },
  { label: '转 Reviser', action: 'revise', variant: 'ghost' as const, description: '交由 Reviser 尝试局部修正' },
  { label: '取消', action: 'reject', variant: 'destructive' as const, description: '中止本次创作流程' },
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
    // ⚠️ 工具化方案：若 data 携带 kind 字段（如 narrative_task），
    // 复用 formatDetailBubble 格式化为可读 markdown，与 emitProgress 推送的 detail 气泡保持一致展示。
    // 避免 CheckpointMessage 直接展示 LLM 原始文本（如"叙事任务已通过工具提交"这种解释性回复）。
    const detailRecord = data as Record<string, unknown>
    if (typeof detailRecord.kind === 'string') {
      const formatted = formatDetailBubble(detailRecord)
      if (formatted.content) return formatted.content
    }

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
function mapAgentType(agentType: string): ConversationAgentType {
  const knownTypes: ConversationAgentType[] = [
    'director', 'writer', 'reviewer', 'reviser', 'memory',
    'arranger', 'context', 'extractor', 'moderator', 'character',
  ]
  return knownTypes.includes(agentType as ConversationAgentType)
    ? agentType as ConversationAgentType
    : 'context'
}

// ── Props ──

export interface NovelConversationPanelProps {
  /** 当前阶段 */
  phase: CreationPhase
  /** 是否正在运行 */
  isRunning: boolean
  /** SSE 当前详细进度；同一位置原位更新，不作为聊天消息展示 */
  progressMessage?: string | null
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
  /** 从持久化群聊快照继续 */
  onResumeDiscussion?: (runId: string) => void
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

  // ── 章节自由聊天（"聊天" Tab）──
  /** 章节聊天历史消息（含创作流程持久化 + 自由聊天） */
  chapterChatMessages?: ChapterChatMessage[]
  /** 自由聊天中正在流式生成的 Agent 输出 */
  chapterChatAgentOutputs?: ChatAgentOutput[]
  /** 自由聊天是否正在运行 */
  chapterChatRunning?: boolean
  /** 自由聊天错误信息 */
  chapterChatError?: string | null
  /** 发送自由聊天消息 */
  onSendChapterChat?: (message: string, mentionedAgents?: string[]) => void
  /** 中断自由聊天 */
  onAbortChapterChat?: () => void
  /** 自由聊天可 @ 提及的 Agent 列表 */
  chatMentionOptions?: MentionOption[]
}

/** 低频创作模式 Popover：点击 ··· 展开完整列表 */
function SecondaryFlowPopover({
  flowType,
  onFlowTypeChange,
}: {
  flowType: NovelFlowType
  onFlowTypeChange: (type: NovelFlowType) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const isSecondaryActive = SECONDARY_FLOW_TABS.some((t) => t.type === flowType)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="更多创作方式"
        className={cn(
          'inline-flex items-center justify-center size-6 rounded-[6px]',
          'transition-all duration-200 ease-out active:scale-[0.96]',
          isSecondaryActive
            ? 'bg-surface-1 text-primary shadow-sm'
            : 'text-subtle hover:text-text hover:bg-surface-1/50',
        )}
      >
        <MoreHorizontal className="size-3.5" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[180px] py-1 rounded-lg bg-surface-1 border border-border/60 shadow-lg">
          {SECONDARY_FLOW_TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = flowType === tab.type
            return (
              <button
                key={tab.type}
                onClick={() => { onFlowTypeChange(tab.type); setOpen(false) }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium transition-colors',
                  isActive ? 'text-primary bg-primary/8' : 'text-text hover:bg-surface-2',
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="flex-1">{tab.label}</span>
              </button>
            )
          })}
          {/* 描述区：当前 hover 或 active 的 description */}
          {SECONDARY_FLOW_TABS.find((t) => t.type === flowType)?.description && (
            <div className="px-3 pt-1.5 pb-1 text-[10px] text-subtle leading-relaxed border-t border-border/40 mt-1">
              {SECONDARY_FLOW_TABS.find((t) => t.type === flowType)!.description}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function NovelConversationPanel({
  phase,
  isRunning,
  progressMessage,
  chapterContent,
  agentOutputs,
  chapterNumber,
  currentCheckpoint,
  result,
  error,
  onRetry,
  onDismissError,
  onResumeDiscussion,
  onSubmitCheckpoint,
  onSave,
  onDiscard,
  onSendMessage,
  userMessages,
  flowType,
  onFlowTypeChange,
  onStartFlow,
  onCancelFlow,
  chapterChatMessages,
  chapterChatAgentOutputs,
  chapterChatRunning,
  chapterChatError,
  onSendChapterChat,
  onAbortChapterChat,
  chatMentionOptions,
}: NovelConversationPanelProps): ReactElement {
  const isArrangeMode = flowType === 'arrange'
  const isReverseMode = flowType === 'reverse'
  const isChatMode = flowType === 'chat'
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

  // ── 数据映射 ──
  const messages = useMemo<ConversationMessage[]>(() => {
    // 聊天模式：映射 chapterChatMessages + chapterChatAgentOutputs
    if (isChatMode) {
      const msgs: ConversationMessage[] = []

      // 持久化历史消息
      for (const msg of chapterChatMessages ?? []) {
        if (msg.role === 'user') {
          msgs.push({
            id: `chat-${msg.id}`,
            role: 'user',
            content: msg.content,
            status: 'complete',
            timestamp: msg.createdAt,
          })
        } else if (msg.role === 'agent') {
          msgs.push({
            id: `chat-${msg.id}`,
            role: 'assistant',
            agentName: msg.fromName,
            agentType: mapAgentType(msg.metadata?.agentType ?? 'unknown'),
            content: msg.content,
            status: 'complete',
            timestamp: msg.createdAt,
          })
        } else {
          msgs.push({
            id: `chat-${msg.id}`,
            role: 'system',
            content: msg.content,
            status: 'complete',
            timestamp: msg.createdAt,
          })
        }
      }

      // 流式 Agent 输出（正在生成中）
      for (const output of chapterChatAgentOutputs ?? []) {
        msgs.push({
          id: `chat-stream-${output.messageId ?? output.timestamp}`,
          role: 'assistant',
          agentName: output.agentName,
          agentType: mapAgentType(output.agentType),
          content: output.streaming ? output.preview : output.content,
          streamingBuffer: output.streaming ? output.content : undefined,
          status: output.streaming ? 'streaming' : 'complete',
          timestamp: output.timestamp,
        })
      }

      return msgs.sort((a, b) => a.timestamp - b.timestamp)
    }

    // 创作流程模式：agentOutputs + userMessages + checkpoint → ConversationMessage[]
    const msgs: ConversationMessage[] = []

    // 群聊历史已按章节持久化。切换章节、重启应用或 reset 后，仍可在“群聊”Tab 复盘。
    if (flowType === 'discussion') {
      for (const msg of chapterChatMessages ?? []) {
        if (msg.phase !== 'discussion' || msg.metadata?.flowMode !== 'discussion') continue
        if (msg.role === 'user') {
          msgs.push({
            id: `discussion-history-${msg.id}`,
            role: 'user',
            content: msg.content,
            status: 'complete',
            timestamp: msg.createdAt,
          })
        } else if (msg.role === 'agent') {
          msgs.push({
            id: `discussion-history-${msg.id}`,
            role: 'assistant',
            agentName: msg.fromName,
            agentType: mapAgentType(msg.metadata?.agentType ?? 'unknown'),
            content: msg.content,
            status: 'complete',
            timestamp: msg.createdAt,
          })
        } else {
          const resumeRunId = msg.metadata?.discussionMessageType === 'run_end'
            && msg.metadata.discussionRunStatus === 'error'
            && msg.metadata.discussionCanResume === true
            ? msg.metadata.discussionRunId
            : undefined
          msgs.push({
            id: `discussion-history-${msg.id}`,
            role: 'system',
            content: msg.content,
            status: 'complete',
            timestamp: msg.createdAt,
            systemActions: resumeRunId
              ? [{ label: '从中断处继续', action: `resume-discussion:${resumeRunId}`, variant: 'default' as const }]
              : undefined,
          })
        }
      }
    }

    // Agent 输出 → assistant 消息
    // ⚠️ id 需保证唯一：同一毫秒可能推送多条同 agentType 的 detail 气泡（如节奏+约束+详情均为 'context'），
    // 仅用 timestamp+agentType 会冲突，故追加数组索引作为兜底。
    // 优先用 messageId（流式输出有此字段），否则用 timestamp+agentType+index 组合。
    agentOutputs.forEach((output, index) => {
      msgs.push({
        id: output.messageId
          ? `agent-${output.messageId}`
          : `agent-${output.timestamp}-${output.agentType}-${index}`,
        role: 'assistant',
        agentName: output.agentName,
        agentType: mapAgentType(output.agentType),
        content: output.streaming ? output.preview : output.content,
        streamingBuffer: output.streaming ? output.content : undefined,
        status: output.streaming ? 'streaming' : 'complete',
        timestamp: output.timestamp,
      })
    })

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
      // 按 checkpoint.type 选取选项和展示类型
      // 旧逻辑只支持 narrative_task / review 两类，新增 3 类静默重写场景的检查点
      let checkpointType: NonNullable<ConversationMessage['checkpointType']> = 'review'
      let checkpointOptions: NonNullable<ConversationMessage['checkpointOptions']> = REVIEW_OPTIONS
      switch (currentCheckpoint.type) {
        case 'narrative_task':
          checkpointType = 'narrative_task'
          checkpointOptions = NARRATIVE_OPTIONS
          break
        case 'post_write_guard':
          checkpointType = 'post_write_guard'
          checkpointOptions = POST_WRITE_GUARD_OPTIONS
          break
        case 'writer_pushback':
          checkpointType = 'writer_pushback'
          checkpointOptions = WRITER_PUSHBACK_OPTIONS
          break
        case 'guard_degraded':
          checkpointType = 'guard_degraded'
          checkpointOptions = GUARD_DEGRADED_OPTIONS
          break
        case 'review':
        default:
          checkpointType = 'review'
          checkpointOptions = REVIEW_OPTIONS
          break
      }
      msgs.push({
        id: `checkpoint-${currentCheckpoint.checkpointId ?? currentCheckpoint.phase}`,
        role: 'checkpoint',
        content: renderCheckpointContent(currentCheckpoint),
        status: 'complete',
        timestamp: Date.now(),
        checkpointType,
        checkpointOptions,
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
  }, [isChatMode, flowType, chapterChatMessages, chapterChatAgentOutputs, agentOutputs, userMessages, currentCheckpoint, isCompleted, completedActionLabel, canSave, chapterNumber])

  // ── 回调 ──
  const handleSend = useCallback((text: string) => {
    if (isChatMode) {
      onSendChapterChat?.(text)
    } else if (isRunning) {
      onSendMessage?.(text)
    }
  }, [isChatMode, isRunning, onSendMessage, onSendChapterChat])

  const handleSendWithMentions = useCallback((text: string, mentionedIds: string[]) => {
    if (isChatMode) {
      onSendChapterChat?.(text, mentionedIds.length > 0 ? mentionedIds : undefined)
    }
  }, [isChatMode, onSendChapterChat])

  const handleAbort = useCallback(() => {
    if (isChatMode) {
      onAbortChapterChat?.()
    } else if (phase !== 'cancelling') {
      // onCancelFlow 是 async（等待后端真实断开），void 明确忽略返回的 Promise
      // cancelling 状态下禁用重复取消
      void onCancelFlow()
    }
  }, [isChatMode, onAbortChapterChat, onCancelFlow, phase])

  const handleCheckpointResolve = useCallback((action: string) => {
    onSubmitCheckpoint(action as CheckpointDecision)
  }, [onSubmitCheckpoint])

  const handleSystemAction = useCallback((action: string) => {
    if (action === 'save') {
      if (chapterContent) void onSave(chapterContent)
    } else if (action === 'discard' && phase !== 'cancelling') {
      // onDiscard 是 async（等待后端真实断开），void 明确忽略返回的 Promise
      // cancelling 状态下禁用重复 discard
      void onDiscard()
    } else if (action.startsWith('resume-discussion:')) {
      onResumeDiscussion?.(action.slice('resume-discussion:'.length))
    }
  }, [chapterContent, onSave, onDiscard, onResumeDiscussion, phase])

  // 空状态提示
  const emptyHint = isChatMode
    ? '输入消息与 Agent 自由对话，或 @ 指定 Agent 回复'
    : isReverseMode
      ? '点击"开始"从章节正文反向提取实体到矩阵'
      : isArrangeMode
        ? '点击"开始"让 AI 自动编排本章矩阵实体'
        : flowType === 'discussion'
          ? '用于多角色谈判、博弈和高潮场景。普通章节优先使用工作流'
          : '点击"开始"启动创作流程'

  // 空状态标题
  const emptyTitle = isChatMode
    ? '章节聊天'
    : isReverseMode
      ? '反推实体'
      : isArrangeMode
        ? 'AI 矩阵编排'
        : flowType === 'discussion'
          ? '高级群聊共创'
          : '开始创作'

  // 空状态插图变体
  const emptyVariant: EmptyStateVariant = isChatMode
    ? 'chat'
    : isReverseMode
      ? 'reverse'
      : isArrangeMode
        ? 'arrange'
        : flowType === 'discussion'
          ? 'discussion'
          : 'workflow'

  const isEmpty = messages.length === 0
  const activeError = isChatMode ? chapterChatError : error
  const activeIsRunning = isChatMode ? !!chapterChatRunning : isRunning

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── 流程模式分级入口：高频 Segmented + 低频 Popover ── */}
      <header className="shrink-0 border-b border-border/60 bg-surface-1">
        <div className="flex items-center gap-1.5 px-2 pt-2 pb-0">
          {isRunning ? (
            /* 运行中：锁定当前模式，显示名称 + 阶段 */
            <div className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-primary/8 text-primary">
              {(() => { const tab = FLOW_TABS.find((t) => t.type === flowType); const Icon = tab?.icon ?? Workflow; return <Icon className="size-3.5" /> })()}
              <span className="text-[11px] font-medium whitespace-nowrap">
                {FLOW_TABS.find((t) => t.type === flowType)?.label ?? flowType}
              </span>
            </div>
          ) : (
            <>
              {/* 高频模式 Segmented Control */}
              <div className="inline-flex items-center gap-0.5 p-0.5 bg-surface-2 rounded-lg">
                {PRIMARY_FLOW_TABS.map((tab) => {
                  const Icon = tab.icon
                  const isActive = flowType === tab.type
                  return (
                    <button
                      key={tab.type}
                      onClick={() => onFlowTypeChange(tab.type)}
                      title={tab.description ?? tab.label}
                      className={cn(
                        'inline-flex items-center gap-1.5 h-6 px-2.5 text-[11px] font-medium rounded-[6px]',
                        'transition-all duration-200 ease-out active:scale-[0.96]',
                        isActive
                          ? 'bg-surface-1 text-text shadow-sm'
                          : 'text-subtle hover:text-text hover:bg-surface-1/50',
                      )}
                    >
                      <Icon className="size-3" />
                      <span className="leading-none">{tab.label}</span>
                    </button>
                  )
                })}
              </div>
              {/* 低频模式 ··· Popover */}
              <SecondaryFlowPopover
                flowType={flowType}
                onFlowTypeChange={onFlowTypeChange}
              />
            </>
          )}
        </div>
        {/* 状态栏：独立圆角卡片样式（对齐原型 status-bar + status-badge 胶囊 + 语义状态色） */}
        <div className="mx-2 mt-2 mb-3 flex items-center gap-2 px-3 py-1.5 bg-surface-2 rounded-lg">
          {chapterNumber != null && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-surface-3 text-text-secondary text-[10px] font-medium tabular-nums shrink-0">
              第 {chapterNumber} 章
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {activeIsRunning && (
              <motion.span
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                className="flex min-w-0 max-w-[240px] items-center gap-1 text-[11px] text-primary"
                title={isChatMode ? 'Agent 回复中' : (progressMessage ?? PHASE_LABELS[phase] ?? phase)}
              >
                <Loader2 className="size-3 shrink-0 animate-spin" />
                <span className="truncate">
                  {isChatMode ? 'Agent 回复中' : (progressMessage ?? PHASE_LABELS[phase] ?? phase)}
                </span>
              </motion.span>
            )}
            {!activeIsRunning && isChatMode && (
              <span className="text-[11px] text-muted-foreground">就绪</span>
            )}
            {!activeIsRunning && !isChatMode && isCompleted && (
              <span className="text-[11px] text-success">
                {completedActionLabel}完成
              </span>
            )}
            {!activeIsRunning && !isChatMode && isError && (
              <span className="text-[11px] text-destructive">出错</span>
            )}
            {!activeIsRunning && !isChatMode && phase === 'idle' && (
              <span className="text-[11px] text-muted-foreground">等待开始</span>
            )}
          </div>
        </div>
      </header>

      {/* ── 消息流 ── */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {activeError && (
          <div className="p-3 shrink-0">
            <ErrorCard
              message={activeError}
              onRetry={!isChatMode
                ? result?.canResume && result.discussionRunId
                  ? () => onResumeDiscussion?.(result.discussionRunId!)
                  : onRetry
                : undefined}
              retryLabel={result?.canResume ? '从中断处继续' : '重试'}
              onDismiss={!isChatMode ? onDismissError : undefined}
            />
          </div>
        )}
        {isEmpty ? (
          /* 空状态：SVG 插图 + 标题 + 引导文案 */
          <ConversationEmptyState
            variant={emptyVariant}
            title={emptyTitle}
            hint={emptyHint}
          />
        ) : (
          <ConversationStream
            messages={messages}
            onCheckpointResolve={handleCheckpointResolve}
            onSystemAction={handleSystemAction}
            emptyHint={emptyHint}
            emptyTitle={emptyTitle}
            emptyVariant={emptyVariant}
          />
        )}
      </div>

      {/* ── 输入区 ── */}
      <div className="shrink-0 border-t border-border">
        <ConversationInput
          onSend={handleSend}
          onAbort={handleAbort}
          isRunning={activeIsRunning}
          allowSendWhileRunning={!isChatMode && !isReverseMode && !isArrangeMode}
          // 反推和AI编排时用户不参与，输入框始终禁用；聊天模式始终可用
          disabled={!isChatMode && (isReverseMode || isArrangeMode)}
          placeholder={
            isChatMode
              ? '输入消息与 Agent 对话，@ 指定 Agent...'
              : isReverseMode
                ? '反推流程进行中...'
                : isArrangeMode
                  ? 'AI编排进行中...'
                  : isRunning
                    ? '输入补充意见参与创作...'
                    : '点击开始按钮启动流程'
          }
          showStart={!isChatMode && !isRunning && phase === 'idle'}
          startLabel="开始"
          onStart={onStartFlow}
          mentionOptions={isChatMode ? chatMentionOptions : undefined}
          onSendWithMentions={isChatMode ? handleSendWithMentions : undefined}
        />
      </div>
    </div>
  )
}
