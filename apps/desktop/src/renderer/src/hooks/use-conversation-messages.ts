/**
 * useConversationMessages：章节统一会话时间线的消息合并逻辑（P2-1a）
 *
 * 从 novel-conversation-panel 抽出 —— 此前这是面板内一个 360 行的 useMemo，
 * 混合了 7 类来源的合并规则与渲染细节，无法单测。
 *
 * 结构：
 * - buildConversationMessages：纯函数，输入各来源数据，输出按时间排序的消息列表
 * - useConversationMessages：薄壳，useMemo 包装纯函数
 *
 * 合并来源：
 * 1. 章节聊天存储的自由聊天历史 + 文风审查系统消息
 * 2. workflow 历史恢复（无实时状态时）+ decision 回填 checkpoint
 * 3. discussion 历史恢复（含可续跑 run_end 的系统动作）
 * 4. 实时 agentOutputs / chapterChat 流式输出 / userMessages / interjectMessages
 * 5. checkpoint 历史 + 当前检查点
 * 6. 完成系统消息 / 时间线重建状态消息
 */
import { useMemo } from 'react'
import type {
  AgentOutput,
  UserMessage,
  InterjectMessage,
} from '@/hooks/use-novel-creation-flow'
import { formatDetailBubble } from '@/hooks/use-novel-creation-flow'
import type { ChatAgentOutput } from '@/hooks/use-chapter-chat'
import type { ChapterChatMessage } from '@/api/novel-client'
import type {
  ConversationAgentType,
  ConversationMessage
} from '@/components/shared/conversation'
import type {
  CheckpointData,
  CheckpointDecision
} from '@/hooks/use-novel-creation-flow'
import type { TimelineRebuildStatus } from '@/stores/timeline-rebuild-store'
import type { NovelFlowType } from '@/components/novel/novel-conversation-panel'

// ── 检查点选项常量 ──

const NARRATIVE_OPTIONS = [
  {
    label: '确认',
    action: 'approve',
    variant: 'default' as const,
    description: '按此叙事任务继续写作'
  },
  {
    label: '按意见重写',
    action: 'rewrite',
    variant: 'outline' as const,
    description: '提供修改意见后重新规划'
  },
  {
    label: '取消创作',
    action: 'reject',
    variant: 'destructive' as const,
    description: '中止本次创作流程'
  }
]

/**
 * 验收检查点的选项。
 *
 * ## 文案为什么写成这样
 *
 * 原来是「通过 / 修订 / 重写」。问题出在检查点卡片展示的是审稿 Agent 的结论原文，
 * 而那句话经常是「验收已提交，**结论为需修订**」。用户看到"需修订"，把「通过」
 * 读成"通过这个需修订的结论"，实际点下去的语义是"接受当前正文、跳过 Reviser
 * 直接落库" —— 于是 Reviser 从不运行，用户以为选了修订却永远等不到新正文。
 *
 * 结论：**按钮要说清后果，不能只表达态度。**「通过」这类词在有结论的上下文里
 * 一定会被读成"认可结论"。
 */
const REVIEW_OPTIONS = [
  {
    label: '接受这一版',
    action: 'approve',
    variant: 'default' as const,
    description: '不再修订，直接落库进入记忆提取'
  },
  {
    label: '交给 Reviser 修订',
    action: 'revise',
    variant: 'outline' as const,
    description: '按审稿意见局部修改正文（正文会变）'
  },
  {
    label: '退回重写',
    action: 'rewrite',
    variant: 'ghost' as const,
    description: '整章退回 Writer 重新创作（成本最高）'
  }
]

const ARRANGE_REVIEW_OPTIONS = [
  {
    label: '确认落库',
    action: 'approve',
    variant: 'default' as const,
    description: '将本次 AI 编排结果正式写入矩阵'
  },
  {
    label: '按意见修改',
    action: 'revise',
    variant: 'outline' as const,
    description: '发送修改意见，回滚当前草稿后重新编排'
  },
  {
    label: '拒绝落库',
    action: 'reject',
    variant: 'destructive' as const,
    description: '丢弃本次编排结果，不修改矩阵'
  }
]

// PostWriteGuard 命中后让用户选择是否重写 Writer
const POST_WRITE_GUARD_OPTIONS = [
  {
    label: '重写',
    action: 'rewrite',
    variant: 'default' as const,
    description: '退回 Writer 按守护意见重写'
  },
  {
    label: '接受草稿',
    action: 'approve',
    variant: 'outline' as const,
    description: '忽略守护警告，保留当前草稿'
  },
  {
    label: '转 Reviser',
    action: 'revise',
    variant: 'ghost' as const,
    description: '交由 Reviser 局部修正'
  },
  {
    label: '取消',
    action: 'reject',
    variant: 'destructive' as const,
    description: '中止本次创作流程'
  }
]

// Writer 推回 Director 时让用户选择是否同意推回
const WRITER_PUSHBACK_OPTIONS = [
  {
    label: '同意推回',
    action: 'approve',
    variant: 'default' as const,
    description: '接受 Writer 的推回建议'
  },
  {
    label: '强制继续',
    action: 'rewrite',
    variant: 'outline' as const,
    description: '忽略推回，按原任务继续'
  },
  {
    label: '取消创作',
    action: 'reject',
    variant: 'destructive' as const,
    description: '中止本次创作流程'
  }
]

// Guard 达上限后让用户选择是否接受当前草稿
const GUARD_DEGRADED_OPTIONS = [
  {
    label: '接受草稿',
    action: 'approve',
    variant: 'default' as const,
    description: '守护已达重试上限，接受当前版本'
  },
  {
    label: '从头重写',
    action: 'rewrite',
    variant: 'outline' as const,
    description: '重新创作整章（计入本章重写上限）'
  },
  {
    label: '转 Reviser',
    action: 'revise',
    variant: 'ghost' as const,
    description: '交由 Reviser 尝试局部修正'
  },
  {
    label: '取消',
    action: 'reject',
    variant: 'destructive' as const,
    description: '中止本次创作流程'
  }
]

// 单章成本超出预算：不硬停，让用户决定继续或停止
const CHAPTER_BUDGET_OPTIONS = [
  {
    label: '继续创作',
    action: 'approve',
    variant: 'default' as const,
    description: '知晓成本，继续完成本章（本章不再提示）'
  },
  {
    label: '停止',
    action: 'reject',
    variant: 'destructive' as const,
    description: '中止本次创作（已生成内容保留）'
  }
]

// 群聊 Moderator 暂停：LLM 的候选项文本只作内容展示，可执行按钮固定两值
const DISCUSSION_PAUSE_OPTIONS = [
  {
    label: '继续',
    action: 'approve',
    variant: 'default' as const,
    description: '按你的意见继续推演/编织'
  },
  {
    label: '终止',
    action: 'reject',
    variant: 'destructive' as const,
    description: '中止本次群聊创作'
  }
]

export function getCheckpointPresentation(checkpoint: Pick<CheckpointData, 'type' | 'options'>): {
  checkpointType: NonNullable<ConversationMessage['checkpointType']>
  checkpointOptions: NonNullable<ConversationMessage['checkpointOptions']>
} {
  let presentation
  switch (checkpoint.type) {
    case 'discussion_pause':
      presentation = {
        checkpointType: 'discussion_pause' as const,
        checkpointOptions: DISCUSSION_PAUSE_OPTIONS
      }
      break
    case 'arrange_review':
      presentation = {
        checkpointType: 'arrange_review' as const,
        checkpointOptions: ARRANGE_REVIEW_OPTIONS
      }
      break
    case 'narrative_task':
      presentation = {
        checkpointType: 'narrative_task' as const,
        checkpointOptions: NARRATIVE_OPTIONS
      }
      break
    case 'post_write_guard':
      presentation = {
        checkpointType: 'post_write_guard' as const,
        checkpointOptions: POST_WRITE_GUARD_OPTIONS
      }
      break
    case 'writer_pushback':
      presentation = {
        checkpointType: 'writer_pushback' as const,
        checkpointOptions: WRITER_PUSHBACK_OPTIONS
      }
      break
    case 'guard_degraded':
      presentation = {
        checkpointType: 'guard_degraded' as const,
        checkpointOptions: GUARD_DEGRADED_OPTIONS
      }
      break
    case 'chapter_budget':
      presentation = {
        checkpointType: 'chapter_budget' as const,
        checkpointOptions: CHAPTER_BUDGET_OPTIONS
      }
      break
    case 'review':
    default:
      presentation = { checkpointType: 'review' as const, checkpointOptions: REVIEW_OPTIONS }
      break
  }
  return checkpoint.options
    ? {
        ...presentation,
        checkpointOptions: (() => {
          const filtered = presentation.checkpointOptions.filter((option) =>
            checkpoint.options!.includes(option.action as CheckpointDecision)
          )
          // 服务端下发的 options 若全部匹配不上固定动作（如 LLM 自由文本），
          // 保留默认按钮组，绝不渲染空按钮区（2026-08-24 空检查点修复）
          return filtered.length > 0 ? filtered : presentation.checkpointOptions
        })()
      }
    : presentation
}

// ── 检查点内容渲染 ──

function formatTokenCount(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return value >= 10_000 ? `${Math.round(value / 10_000)} 万` : String(value)
}

function formatMinutes(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${Math.round(value / 60_000)} 分钟`
}

/** 渲染 checkpoint.data 的实际内容 */
export function renderCheckpointContent(checkpoint: CheckpointData): string {
  const data = checkpoint.data

  // 群聊 Moderator 暂停（2026-08-24 空检查点修复）：展示提问与 LLM 候选项。
  // 旧载荷没有 data 字段（只有 question），必须先于 data 空值检查处理。
  if (checkpoint.type === 'discussion_pause') {
    const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
    const lines: string[] = []
    if (typeof record.message === 'string' && record.message.trim()) {
      lines.push(record.message)
    } else if (typeof checkpoint.question === 'string' && checkpoint.question.trim()) {
      lines.push(checkpoint.question)
    }
    if (Array.isArray(record.choices) && record.choices.length > 0) {
      lines.push('', '**主持人给出的候选项：**')
      for (const choice of record.choices) lines.push(`- ${String(choice)}`)
    }
    return lines.join('\n')
  }

  if (data == null) return ''

  if (typeof data === 'string') {
    return data
  }

  if (typeof data === 'object') {
    const record = data as Record<string, unknown>

    if (checkpoint.type === 'post_write_guard' || checkpoint.type === 'guard_degraded') {
      const lines = [
        checkpoint.type === 'post_write_guard' ? '## 写作守护触发原因' : '## 写作守护降级原因',
        '',
        `**原因：** ${String(record.reason ?? '未提供')}`
      ]
      if (record.details) lines.push('', `**具体问题：** ${String(record.details)}`)
      if (typeof record.wordCount === 'number') lines.push('', `**当前字数：** ${record.wordCount}`)
      if (typeof record.rewriteCount === 'number' && typeof record.maxRewrite === 'number') {
        lines.push('', `**重写次数：** ${record.rewriteCount} / ${record.maxRewrite}`)
      }
      if (record.advisory) lines.push('', '该检查为建议项，可接受当前草稿继续。')
      return lines.join('\n')
    }

    if (checkpoint.type === 'writer_pushback') {
      return [
        '## Writer 推回原因',
        '',
        String(record.pushbackReason ?? 'Writer 未提供具体原因'),
        '',
        `**推回次数：** ${String(record.pushbackCount ?? 0)} / ${String(record.maxPushback ?? 0)}`
      ].join('\n')
    }

    if (checkpoint.type === 'review') {
      // 审稿报告 + （质量门强制修订时的）修订操作与消耗预估
      const lines: string[] = []
      if (typeof record.review === 'string') lines.push(record.review)
      const estimate = record.revisionEstimate as
        | {
            maxRounds?: number
            callsPerRound?: number
            estimatedTokens?: number
            failedItems?: Array<{ gateId?: string; reason?: string; details?: string }>
          }
        | undefined
      if (estimate) {
        lines.push(
          '',
          '## 修订预估（点击「修订」后）',
          '',
          `- 自动修订轮次：最多 ${estimate.maxRounds ?? 2} 轮（第 1 轮按审稿意见修订；仍有问题则第 2 轮只针对未通过项定向修补）`,
          `- 每轮 AI 调用：${estimate.callsPerRound ?? 1} 次（修订 Agent）`,
          `- 预计消耗：约 ${formatTokenCount(estimate.estimatedTokens)} token（估算，不含缓存命中）`
        )
        const items = estimate.failedItems ?? []
        if (items.length > 0) {
          lines.push('', '**将处理的未通过项：**')
          for (const item of items) {
            lines.push(
              `- ${item.reason ?? item.gateId}${item.details ? `（${item.details}）` : ''}`
            )
          }
        }
        lines.push(
          '',
          '修订后会自动复检；两轮仍未通过会停止并保留修订稿，届时可选择再次修订、手动编辑或保留草稿，不会丢失成果。'
        )
      }
      return lines.join('\n')
    }

    if (checkpoint.type === 'arrange_review') {
      const formatted = formatDetailBubble({ ...record, kind: 'arrange_summary' })
      if (formatted.content) {
        const model = record.model as { provider?: string; modelId?: string } | undefined
        return [
          '## AI 编排结果待确认',
          '',
          ...(model?.provider && model.modelId ? [`**本次模型：** ${model.provider}/${model.modelId}`, ''] : []),
          formatted.content,
          '',
          '如果不满意，请在下方填写意见并点击「按意见修改」。当前草稿会先回滚，再根据意见重新调用 AI。'
        ].join('\n')
      }
      return '## AI 编排结果待确认'
    }

    if (checkpoint.type === 'chapter_budget') {
      const dimensionLabel: Record<string, string> = {
        llmCalls: 'AI 调用次数',
        inputTokens: '输入 token',
        wallClock: '耗时'
      }
      const lines = [
        '## 本章成本已达预算上限',
        '',
        String(record.message ?? ''),
        '',
        `**触发维度：** ${dimensionLabel[String(record.dimension)] ?? String(record.dimension)}`,
        '',
        '| 维度 | 当前 | 上限 |',
        '| --- | --- | --- |',
        `| AI 调用 | ${String(record.llmCalls ?? '-')} 次 | ${String(record.maxLlmCalls ?? '-')} 次 |`,
        `| 输入 token | ${formatTokenCount(record.inputTokens)} | ${formatTokenCount(record.maxInputTokens)} |`,
        `| 耗时 | ${formatMinutes(record.elapsedMs)} | ${formatMinutes(record.maxWallClockMs)} |`,
        '',
        '已生成的内容不会丢失。选择「继续创作」后本章不再提示。'
      ]
      return lines.join('\n')
    }

    // ⚠️ 工具化方案：若 data 携带 kind 字段（如 narrative_task），
    // 复用 formatDetailBubble 格式化为可读 markdown，与 emitProgress 推送的 detail 气泡保持一致展示。
    // 避免 CheckpointMessage 直接展示 LLM 原始文本（如"叙事任务已通过工具提交"这种解释性回复）。
    const detailRecord = record
    if (typeof detailRecord.kind === 'string') {
      const formatted = formatDetailBubble(detailRecord)
      if (formatted.content) return formatted.content
    }

    const outer = data as { message?: string; data?: unknown }
    const inner = outer.data
    if (typeof inner === 'string') return inner
    if (inner && typeof inner === 'object')
      return '```json\n' + JSON.stringify(inner, null, 2) + '\n```'
    if (outer.message) return outer.message
  }

  return ''
}

/** 将 creationFlow 的 agentType 映射到 ConversationAgentType */
export function mapAgentType(agentType: string): ConversationAgentType {
  const knownTypes: ConversationAgentType[] = [
    'director',
    'writer',
    'reviewer',
    'reviser',
    'memory',
    'arranger',
    'context',
    'extractor',
    'moderator',
    'character'
  ]
  return knownTypes.includes(agentType as ConversationAgentType)
    ? (agentType as ConversationAgentType)
    : 'context'
}

// ── 输入契约 ──

export interface ConversationMessagesInput {
  flowType: NovelFlowType
  /** 章节聊天存储历史（自由聊天 + workflow/discussion 落库消息共用） */
  chapterChatMessages?: ChapterChatMessage[]
  agentOutputs: AgentOutput[]
  chapterChatAgentOutputs?: ChatAgentOutput[]
  userMessages?: UserMessage[]
  interjectMessages?: InterjectMessage[]
  checkpointHistory: CheckpointData[]
  currentCheckpoint: CheckpointData | null
  isRunning: boolean
  isCompleted: boolean
  completedActionLabel: string
  canSave: boolean
  chapterNumber?: number
  timelineStatus: TimelineRebuildStatus
}

/**
 * 纯函数版消息合并（导出仅为单测；React 侧用 useConversationMessages）。
 */
export function buildConversationMessages(input: ConversationMessagesInput): ConversationMessage[] {
  const {
    flowType,
    chapterChatMessages,
    agentOutputs,
    chapterChatAgentOutputs,
    userMessages,
    interjectMessages,
    checkpointHistory,
    currentCheckpoint,
    isRunning,
    isCompleted,
    completedActionLabel,
    canSave,
    chapterNumber,
    timelineStatus
  } = input

  // 创作流程模式：agentOutputs + userMessages + checkpoint → ConversationMessage[]
  const msgs: ConversationMessage[] = []

  // 自由聊天和结构化创作共用 ChapterChatStore，但只在这里渲染 free_chat，
  // workflow/discussion 历史仍由下面各自分支恢复，避免消息重复。
  for (const message of chapterChatMessages ?? []) {
    if (message.phase !== 'free_chat') continue
    msgs.push({
      id: `chat-history-${message.id}`,
      role: message.role === 'user' ? 'user' : 'assistant',
      ...(message.role === 'agent'
        ? {
            agentName: message.fromName,
            agentType: mapAgentType(message.metadata?.agentType ?? 'context')
          }
        : {}),
      content: message.content,
      status: 'complete',
      timestamp: message.createdAt
    })
  }

  for (const message of chapterChatMessages ?? []) {
    if (message.metadata?.workflowMessageType !== 'style_technique_checks') continue
    const checks = (message.metadata.styleTechniqueChecks ?? []) as Array<{ techniqueName?: string; dimension?: string; verdict?: string; evidence?: string; note?: string }>
    msgs.push({
      id: `style-review-${message.id}`,
      role: 'system',
      content: [message.content, ...checks.map((check) => `${check.verdict === 'present' ? '✓' : check.verdict === 'absent' ? '✕' : '—'} ${check.dimension ?? ''} · ${check.techniqueName ?? ''}${check.evidence ? `：${check.evidence}` : ''}${check.note ? `（${check.note}）` : ''}`)].join('\n'),
      status: 'complete',
      timestamp: message.createdAt,
    })
  }

  for (const message of chapterChatMessages ?? []) {
    if (message.metadata?.workflowMessageType !== 'run_start') continue
    const ids = message.metadata.styleExpertIds ?? []
    if (ids.length === 0) continue
    msgs.push({
      id: `style-run-start-${message.id}`,
      role: 'system',
      content: `本次召集文风专家：${ids.join('、')}`,
      status: 'complete',
      timestamp: message.createdAt,
    })
  }

  // 没有实时状态时，从章节聊天存储恢复工作流对话。decision 消息不单独展示，
  // 而是合并回对应 checkpoint，让历史卡片保留用户当时的选择。
  const hasLiveWorkflowState =
    agentOutputs.length > 0 ||
    (userMessages?.length ?? 0) > 0 ||
    checkpointHistory.length > 0 ||
    currentCheckpoint != null ||
    isRunning
  if (flowType === 'workflow' && !hasLiveWorkflowState) {
    const workflowMessages = (chapterChatMessages ?? []).filter(
      (message) => message.metadata?.flowMode === 'workflow'
    )
    const decisionsByCheckpoint = new Map<string, string>()
    for (const message of workflowMessages) {
      if (
        message.metadata?.workflowMessageType === 'decision' &&
        message.metadata.checkpointId &&
        message.metadata.decision
      ) {
        decisionsByCheckpoint.set(message.metadata.checkpointId, message.metadata.decision)
      }
    }

    for (const message of workflowMessages) {
      const messageType = message.metadata?.workflowMessageType
      if (messageType === 'decision') continue

      if (messageType === 'checkpoint' && message.metadata?.checkpointType) {
        const checkpoint: CheckpointData = {
          type: message.metadata.checkpointType,
          phase: 'checkpoint_review',
          data: message.metadata.checkpointData ?? message.content,
          options: message.metadata.checkpointOptions,
          checkpointId: message.metadata.checkpointId,
          createdAt: message.createdAt,
          decision: message.metadata.checkpointId
            ? (decisionsByCheckpoint.get(message.metadata.checkpointId) as
                | CheckpointDecision
                | undefined)
            : undefined
        }
        const presentation = getCheckpointPresentation(checkpoint)
        msgs.push({
          id: `workflow-history-checkpoint-${message.id}`,
          role: 'checkpoint',
          content: renderCheckpointContent(checkpoint),
          status: 'complete',
          timestamp: message.createdAt,
          ...presentation,
          checkpointResolved: checkpoint.decision
        })
        continue
      }

      if (message.role === 'user') {
        msgs.push({
          id: `workflow-history-${message.id}`,
          role: 'user',
          content: message.content,
          status: 'complete',
          timestamp: message.createdAt,
          // 状态由后端随 SSE 生命周期同步落库；旧记录没有该字段时才回退 queued。
          ...(message.metadata?.interject === true
            ? { interjectStatus: message.metadata.interjectStatus ?? 'queued' as const }
            : {})
        })
      } else if (message.role === 'agent') {
        msgs.push({
          id: `workflow-history-${message.id}`,
          role: 'assistant',
          agentName: message.fromName,
          agentType: mapAgentType(message.metadata?.agentType ?? 'unknown'),
          content: message.content,
          status: 'complete',
          timestamp: message.createdAt
        })
      } else {
        const detail = message.metadata?.detail
        const content = detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).kind === 'string'
          ? formatDetailBubble(detail as Record<string, unknown>).content
          : message.content
        msgs.push({
          id: `workflow-history-${message.id}`,
          role: 'system',
          content,
          status: 'complete',
          timestamp: message.createdAt
        })
      }
    }
  }

  // 群聊历史已按章节持久化。切换章节、重启应用或 reset 后，仍可在“群聊”Tab 复盘。
  // 与 workflow 分支的 hasLiveWorkflowState 守卫同义：运行中切换章节再切回时
  // loadHistory 拉回已落库的插话，而本地实时插话状态（queued/injected/dropped
  // 流转）仍在，同一条会渲染两条（历史 queued + 实时态）。有本地实时插话时
  // 跳过历史插话条目，以实时态为准。
  const hasLiveInterjectState = (interjectMessages?.length ?? 0) > 0
  if (flowType === 'discussion') {
    for (const msg of chapterChatMessages ?? []) {
      if (msg.phase !== 'discussion' || msg.metadata?.flowMode !== 'discussion') continue
      if (msg.role === 'user') {
        if (hasLiveInterjectState && msg.metadata?.interject === true) continue
        msgs.push({
          id: `discussion-history-${msg.id}`,
          role: 'user',
          content: msg.content,
          status: 'complete',
          timestamp: msg.createdAt,
          ...(msg.metadata?.interject === true
            ? { interjectStatus: msg.metadata.interjectStatus ?? 'queued' as const }
            : {})
        })
      } else if (msg.role === 'agent') {
        msgs.push({
          id: `discussion-history-${msg.id}`,
          role: 'assistant',
          agentName: msg.fromName,
          agentType: mapAgentType(msg.metadata?.agentType ?? 'unknown'),
          content: msg.content,
          actorTurn: msg.metadata?.actorTurn,
          status: 'complete',
          timestamp: msg.createdAt
        })
      } else {
        const resumeRunId =
          msg.metadata?.discussionMessageType === 'run_end' &&
          msg.metadata.discussionRunStatus === 'error' &&
          msg.metadata.discussionCanResume === true
            ? msg.metadata.discussionRunId
            : undefined
        msgs.push({
          id: `discussion-history-${msg.id}`,
          role: 'system',
          content: msg.content,
          status: 'complete',
          timestamp: msg.createdAt,
          systemActions: resumeRunId
            ? [
                {
                  label: '从中断处继续',
                  action: `resume-discussion:${resumeRunId}`,
                  variant: 'default' as const
                }
              ]
            : undefined
        })
      }
    }
  }

  // Agent 输出 → assistant 消息
  // ⚠️ id 需保证唯一：同一毫秒可能推送多条同 agentType 的 detail 气泡（如节奏+约束+详情均为 'context'），
  // 仅用 timestamp+agentType 会冲突，故追加数组索引作为兜底。
  // 优先用 messageId（流式输出有此字段），否则用 timestamp+agentType+index 组合。
  agentOutputs.forEach((output, index) => {
    // 思考流展示（推理模型）：正文 delta 未到达时用 thinking 充当气泡内容，
    // 避免"已启动"占位气泡在长思考期间看似卡死；正文开始（或完成且有正文）后展示正文。
    const thinkingText =
      !output.hasStreamedText && output.thinking
        ? `**思考过程**\n\n${output.thinking}`
        : undefined
    const actorTurnText = output.actorTurn
      ? `\n\n<details><summary>角色判断与应对</summary>\n\n${[
          output.actorTurn.innerThought ? `**内心判断**：${output.actorTurn.innerThought}` : '',
          output.actorTurn.conflictReading ? `**冲突判断**：${output.actorTurn.conflictReading}` : '',
          output.actorTurn.responsePlan ? `**应对方案**：${output.actorTurn.responsePlan}` : '',
          output.actorTurn.consequence ? `**即时后果**：${output.actorTurn.consequence}` : '',
        ].filter(Boolean).join('\n\n')}\n\n</details>`
      : ''
    msgs.push({
      id: output.messageId
        ? `agent-${output.messageId}`
        : `agent-${output.timestamp}-${output.agentType}-${index}`,
      role: 'assistant',
      agentName: output.agentName,
      agentType: mapAgentType(output.agentType),
      content: output.streaming ? output.preview : `${thinkingText ?? output.content}${actorTurnText}`,
      actorTurn: output.actorTurn,
      streamingBuffer: output.streaming
        ? output.hasStreamedText
          ? output.content
          : (thinkingText ?? output.content)
        : undefined,
      status: output.streaming ? 'streaming' : 'complete',
      // 2026-08-24：思考过程随气泡保留，正文区上方渲染可展开区块
      thinking: output.thinking || undefined,
      timestamp: output.timestamp
    })
  })

  // 自由聊天流式输出 → 同一条章节会话时间线
  for (const output of chapterChatAgentOutputs ?? []) {
    msgs.push({
      id: `chat-stream-${output.messageId ?? output.timestamp}`,
      role: 'assistant',
      agentName: output.agentName,
      agentType: mapAgentType(output.agentType),
      content: output.streaming ? output.preview : output.content,
      streamingBuffer: output.streaming ? output.content : undefined,
      status: output.streaming ? 'streaming' : 'complete',
      timestamp: output.timestamp
    })
  }

  // 用户消息 → user 消息
  for (const msg of userMessages ?? []) {
    msgs.push({
      id: `user-${msg.id}`,
      role: 'user',
      content: msg.content,
      status: 'complete',
      timestamp: msg.timestamp
    })
  }

  // 插话消息 → user 气泡 + 状态徽标（SSE novel:user-message 驱动 queued/injected/dropped 流转）
  for (const msg of interjectMessages ?? []) {
    msgs.push({
      id: `interject-${msg.messageId}`,
      role: 'user',
      content: msg.content,
      status: 'complete',
      timestamp: msg.timestamp,
      interjectStatus: msg.status,
      interjectAgentType: msg.agentType
    })
  }

  // 已处理检查点仍保留在时间线，当前检查点继续显示可操作按钮。
  for (const checkpoint of [
    ...checkpointHistory,
    ...(currentCheckpoint ? [currentCheckpoint] : [])
  ]) {
    const presentation = getCheckpointPresentation(checkpoint)
    msgs.push({
      id: `checkpoint-${checkpoint.checkpointId ?? `${checkpoint.phase}-${checkpoint.createdAt ?? 0}`}`,
      role: 'checkpoint',
      content: renderCheckpointContent(checkpoint),
      status: 'complete',
      timestamp: checkpoint.createdAt ?? checkpoint.resolvedAt ?? 0,
      ...presentation,
      checkpointResolved: checkpoint.decision
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
            { label: '丢弃', action: 'discard', variant: 'outline' as const }
          ]
        : [{ label: '完成', action: 'discard', variant: 'outline' as const }]
    })
  }

  // 时间线重建状态 → 对话流可见的系统消息（进度/待应用/完成/失败）
  if (timelineStatus.phase !== 'idle') {
    const start = timelineStatus.startChapterNumber
    const range = timelineStatus.total > 0 ? `第 ${start} 章起 ${timelineStatus.total} 章` : ''
    let content: string
    let actions: ConversationMessage['systemActions']
    switch (timelineStatus.phase) {
      case 'invalidated':
        content = `检测到时间线失效（${range}）。后续章节的派生状态基于旧正文，继续生成前建议重建。`
        if (!timelineStatus.error) {
          actions = [{ label: '开始重建', action: 'timeline-start', variant: 'default' as const }]
        } else {
          content += `\n当前不能自动重建：${timelineStatus.error}`
        }
        break
      case 'analyzing':
        content = `时间线重建进行中（${range}）：已完成 ${timelineStatus.completed}/${timelineStatus.total} 章的隔离分析。`
        break
      case 'awaiting_apply':
        content = `时间线分析完成（${range}）：${timelineStatus.total - timelineStatus.completed} 章重建结果待应用。应用后将恢复派生状态并解除创作限制。`
        actions = [{ label: '应用重建结果', action: 'timeline-apply-all', variant: 'default' as const }]
        break
      case 'applying':
        content = `正在应用时间线重建结果（${timelineStatus.completed}/${timelineStatus.total} 章）…`
        break
      case 'completed':
        content = `时间线重建完成：${range}的派生状态已按重放结果恢复，创作与发布限制已解除。`
        break
      case 'failed':
        content = `时间线重建失败${timelineStatus.error ? `：${timelineStatus.error}` : ''}。可重试；若持续失败请检查模型配置。`
        actions = [{ label: '重试重建', action: 'timeline-start', variant: 'default' as const }]
        break
      default:
        content = ''
    }
    if (content) {
      msgs.push({
        id: 'timeline-rebuild-status',
        role: 'system',
        content,
        status: 'complete',
        timestamp: timelineStatus.updatedAt || Date.now(),
        systemActions: actions,
      })
    }
  }

  // 按时间戳排序
  return msgs.sort((a, b) => a.timestamp - b.timestamp)
}

/** 章节统一会话时间线：合并七类来源并按时间排序 */
export function useConversationMessages(input: ConversationMessagesInput): ConversationMessage[] {
  return useMemo(() => buildConversationMessages(input), [
    input.flowType,
    input.chapterChatMessages,
    input.agentOutputs,
    input.chapterChatAgentOutputs,
    input.userMessages,
    input.interjectMessages,
    input.checkpointHistory,
    input.currentCheckpoint,
    input.isRunning,
    input.isCompleted,
    input.completedActionLabel,
    input.canSave,
    input.chapterNumber,
    input.timelineStatus
  ])
}
