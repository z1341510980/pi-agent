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
 * - interjectMessages → user 气泡 + 插话状态徽标（已排队/已注入/已丢弃）
 * - currentCheckpoint → checkpoint 消息卡片（含修改意见输入，已决策灰化）
 * - 流程完成 → system 消息 + 操作按钮
 *
 * 输入框常开（对话化交互形态 §3.2）：flow 运行中（含检查点等待）保持可用，
 * 发送分流到插话端点（§3.1），检查点等待期间可先插话再确认，二者互不竞态。
 */

import { useMemo, useCallback, useState, type ReactElement } from 'react'
import {
  Loader2,
  Workflow,
  MessagesSquare,
  RotateCcw,
  LayoutGrid,
  AlertCircle,
  ChevronDown,
  RefreshCw,
  Pencil,
  Archive,
  X,
  type LucideIcon
} from 'lucide-react'
import { motion } from 'framer-motion'
import { ErrorCard } from '@/components/chat/error-card'
import { type ModelRef } from './model-picker'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  ConversationStream,
  ConversationInput,
  ConversationEmptyState,
  type ConversationMessage,
  type ConversationAgentType,
  type EmptyStateVariant,
  type CommandOption
} from '@/components/shared/conversation'
import type {
  CreationPhase,
  CreationResult,
  CheckpointData,
  CheckpointDecision,
  AgentOutput,
  UserMessage,
  InterjectMessage
} from '@/hooks/use-novel-creation-flow'
import { formatDetailBubble } from '@/hooks/use-novel-creation-flow'
import type { ChatAgentOutput } from '@/hooks/use-chapter-chat'
import type { ChapterChatMessage } from '@/api/novel-client'
import { useTimelineRebuildStore } from '@/stores/timeline-rebuild-store'
import type { NovelCreationMode, NovelInterjectTargetAgent } from '@repo/shared/novel'
import { DEFAULT_NOVEL_STYLE_EXPERTS, type NovelStyleExpert } from '@repo/shared/novel'
import type { MentionOption } from '@/components/shared/conversation'
import { parseCommand } from './command-parser'
import { toastError, toastInfo, toastWarning } from '@/hooks/use-toast'
import { useNovelUiStore } from '@/stores/novel-ui-store'

// ── 流程类型 ──

export type NovelFlowType = NovelCreationMode | 'chat'

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
    description: '适合多角色谈判、博弈和高潮场景；调用轮次和耗时高于默认工作流'
  },
  { type: 'reverse', label: '反推', icon: RotateCcw },
  { type: 'arrange', label: '矩阵编排', icon: LayoutGrid }
]

const INTERJECT_TARGET_OPTIONS: Array<{
  value: NovelInterjectTargetAgent | 'next'
  label: string
}> = [
  { value: 'next', label: '下一位 Agent' },
  { value: 'director', label: '导演' },
  { value: 'writer', label: '写作' },
  { value: 'reviewer', label: '审稿' },
  { value: 'reviser', label: '修订' },
  { value: 'memory', label: '记忆' }
]

/** 创作模式：4 个全部平铺展示（工作流/群聊/反推/编排） */
const PRIMARY_FLOW_TABS = FLOW_TABS.filter((tab) => tab.type === 'reverse' || tab.type === 'arrange')

const SESSION_COMMANDS: CommandOption[] = [
  { id: 'write', label: '/写 N', insertText: '/写 ', description: '启动指定章节的默认工作流' },
  { id: 'rewrite', label: '/重写 N', insertText: '/重写 ', description: '重新生成已有章节' },
  { id: 'discuss', label: '/群聊 N', insertText: '/群聊 ', description: '启动多角色群聊共创' },
  { id: 'resume', label: '/继续', insertText: '/继续', description: '恢复最近一次可续跑流程' },
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
  error: '出错'
}

// ── 检查点决策选项 ──

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

function getCheckpointPresentation(checkpoint: Pick<CheckpointData, 'type' | 'options'>): {
  checkpointType: NonNullable<ConversationMessage['checkpointType']>
  checkpointOptions: NonNullable<ConversationMessage['checkpointOptions']>
} {
  let presentation
  switch (checkpoint.type) {
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
        checkpointOptions: presentation.checkpointOptions.filter((option) =>
          checkpoint.options!.includes(option.action as CheckpointDecision)
        )
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
function renderCheckpointContent(checkpoint: CheckpointData): string {
  const data = checkpoint.data
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
      const arranged = record.arrangedEntities as Record<string, unknown> | undefined
      const model = record.model as { provider?: string; modelId?: string } | undefined
      const counts = arranged
        ? [
            ['角色', arranged.characterIds],
            ['冲突', arranged.conflictIds],
            ['伏笔', arranged.foreshadowIds],
            ['线索', arranged.clueIds],
            ['势力', arranged.factionIds],
            ['地点', arranged.locationIds],
            ['物品', arranged.itemIds]
          ]
            .filter(([, ids]) => Array.isArray(ids))
            .map(([label, ids]) => `- ${label}：${(ids as unknown[]).length}`)
        : []
      return [
        '## AI 编排结果待确认',
        '',
        `本次共生成 **${String(record.total ?? 0)}** 个矩阵实体。确认前不会写入正式矩阵。`,
        ...(model?.provider && model.modelId ? ['', `**本次模型：** ${model.provider}/${model.modelId}`] : []),
        ...(counts.length > 0 ? ['', ...counts] : []),
        '',
        '如果不满意，请在下方填写意见并点击「按意见修改」。当前草稿会先回滚，再根据意见重新调用 AI。'
      ].join('\n')
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

// ── 质量门修订失败卡片 ──
// 与通用 ErrorCard 的区别：失败不是基础设施故障，而是确定性质量门未通过。
// 展示具体未通过项 + 修订记录 + 原始报错，并提供「再次修订/手动编辑/保留草稿/取消」
// 四个出口 —— 成果与已花 token 不再因一次失败被整条丢弃。

const QUALITY_GATE_LABELS: Record<string, string> = {
  'cliche-patterns': 'AI 腔句式',
  'prose-shape': '正文形态',
  'character-voice': '角色声音'
}

function QualityGateFailureCard({
  result,
  error,
  onReRevise,
  onKeepDraft,
  onDiscard
}: {
  result: CreationResult
  error: string | null
  onReRevise?: () => void
  onKeepDraft?: () => void
  onDiscard?: () => void
}): ReactElement {
  const [detailOpen, setDetailOpen] = useState(false)
  const failedItems = result.failedItems ?? []
  const rounds = result.revisionRounds ?? []

  return (
    <div className="rounded-xl border border-destructive/45 bg-destructive/8 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium text-destructive">正文质量门未通过</p>
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-nano text-hint">
              内容未落库
            </span>
          </div>
          <p className="mt-1 text-caption leading-relaxed text-text-secondary">
            修订稿已保留在编辑器中，可直接修改后再保存；也可对未通过项再次定向修订（不重跑生成流程，只消耗修订调用）。
          </p>

          {/* 未通过项明细 */}
          {failedItems.length > 0 && (
            <div className="mt-2 rounded-lg bg-surface-1/70 px-2.5 py-2">
              <p className="text-nano font-medium text-text-secondary">
                未通过项（{failedItems.length}）
              </p>
              <ul className="mt-1 space-y-1">
                {failedItems.map((item, index) => (
                  <li
                    key={`${item.gateId}-${index}`}
                    className="text-nano leading-relaxed text-text-secondary"
                  >
                    <span className="font-medium text-destructive">
                      【{QUALITY_GATE_LABELS[item.gateId] ?? item.gateId}】
                    </span>
                    {item.reason}
                    {item.details ? <span className="text-hint">（{item.details}）</span> : null}
                    {item.excerpts && item.excerpts.length > 0 && (
                      <span className="mt-0.5 block text-hint">
                        原文示例：
                        {item.excerpts
                          .slice(0, 2)
                          .map((e) => `"${e}"`)
                          .join('、')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 修订记录 */}
          {rounds.length > 0 && (
            <div className="mt-2 overflow-hidden rounded-lg bg-surface-1/70 px-2.5 py-2">
              <p className="text-nano font-medium text-text-secondary">
                修订记录（{rounds.length} 轮）
              </p>
              <ul className="mt-1 space-y-1">
                {rounds.map((round) => (
                  <li key={round.round} className="text-nano leading-relaxed text-text-secondary">
                    第 {round.round} 轮：应用 {round.appliedPatches} 处、定位失败{' '}
                    {round.failedPatches} 处
                    {round.remainingFailures.length > 0
                      ? `，剩余 ${round.remainingFailures.length} 项未通过`
                      : '，已通过'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {result.canReviseAgain && onReRevise && (
              <Button
                variant="default"
                size="sm"
                onClick={onReRevise}
                className="h-7 gap-1 px-2 text-xs"
              >
                <RefreshCw className="size-3" />
                再次修订
              </Button>
            )}
            {onKeepDraft && (
              <Button
                variant="outline"
                size="sm"
                onClick={onKeepDraft}
                className="h-7 gap-1 px-2 text-xs"
              >
                <Pencil className="size-3" />
                手动编辑
              </Button>
            )}
            {onKeepDraft && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onKeepDraft}
                className="h-7 gap-1 px-2 text-xs text-text-secondary hover:bg-surface-3"
              >
                <Archive className="size-3" />
                保留草稿
              </Button>
            )}
            {error && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDetailOpen((v) => !v)}
                aria-expanded={detailOpen}
                className="h-7 gap-1 px-2 text-xs text-hint hover:bg-surface-3 hover:text-text"
              >
                <ChevronDown
                  className={cn('size-3 transition-transform', detailOpen && 'rotate-180')}
                />
                技术细节
              </Button>
            )}
            {onDiscard && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDiscard}
                title="丢弃本次创作成果（清空修订稿）"
                className="ml-auto h-7 gap-1 px-2 text-xs text-destructive hover:bg-destructive/15"
              >
                <X className="size-3" />
                取消
              </Button>
            )}
          </div>

          {detailOpen && error && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-surface-1/70 px-2.5 py-2 font-mono text-nano leading-relaxed whitespace-pre-wrap break-words text-text-secondary">
              {error}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Agent 类型映射 ──

/** 将 creationFlow 的 agentType 映射到 ConversationAgentType */
function mapAgentType(agentType: string): ConversationAgentType {
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
  checkpointHistory: CheckpointData[]
  /** 最终结果 */
  result: CreationResult | null
  /** 错误信息 */
  error: string | null
  /** 错误后重试回调 */
  onRetry?: () => void
  /** 错误后丢弃回调 */
  onDismissError?: () => void
  /** 质量门失败后：对未通过项再次定向修订（不重跑生成流程） */
  onReRevise?: () => void
  /** 质量门失败后：保留修订稿为草稿（内容留在编辑器，不落库不丢弃） */
  onKeepDraft?: () => void
  /** 从持久化群聊快照继续 */
  onResumeDiscussion?: (runId: string) => void
  /** 工作流断点续跑（runId='latest' 时取最近一条可续跑快照） */
  onResumeWorkflow?: (runId: string) => void
  /** 章节自由聊天的流式 Agent 输出，共用本面板时间线 */
  chapterChatAgentOutputs?: ChatAgentOutput[]
  /** 章节自由聊天是否正在运行 */
  chapterChatRunning?: boolean
  /** 章节自由聊天错误 */
  chapterChatError?: string | null
  /** 空闲状态普通文本进入章节自由聊天 */
  onSendChapterChat?: (message: string, mentionedAgents?: string[], modelId?: ModelRef | null, styleExpertIds?: string[]) => void
  /** 中止章节自由聊天 */
  onAbortChapterChat?: () => void
  /** 自由聊天 @ 提及候选 */
  chatMentionOptions?: MentionOption[]
  /** 当前项目文风专家团；本轮选择在输入框附近完成 */
  styleExperts?: NovelStyleExpert[]
  /** 本轮召集的文风专家 ID */
  selectedStyleExpertIds?: string[]
  /** 更新本轮召集专家 */
  onStyleExpertsChange?: (expertIds: string[]) => void
  /** 打开文风专家团长期配置 */
  onOpenStyleExperts?: () => void
  /** 创作模式 */
  creationMode?: 'manual' | 'ai-arrange' | null
  /** 提交检查点决策（comment 为卡片内修改意见，随既有 decision 端点一并提交）；async 时卡片跟踪提交完成做防抖 */
  onSubmitCheckpoint: (decision: CheckpointDecision, comment?: string) => void | Promise<void>
  /** 保存章节 */
  onSave: (content: string) => Promise<void>
  /** 丢弃 */
  onDiscard: () => void
  /** 用户发送消息 */
  onSendMessage?: (message: string) => void
  /** 用户消息历史 */
  userMessages?: UserMessage[]
  /** 插话消息（flow 运行中用户中途反馈，SSE novel:user-message 驱动状态流转） */
  interjectMessages?: InterjectMessage[]
  /** 发送插话（flow 运行中输入框发送分流到此；toast 由调用方负责） */
  onSendInterject?: (content: string, targetAgent?: NovelInterjectTargetAgent) => void
  /** 当前流程类型 */
  flowType: NovelFlowType
  /** 切换流程类型 */
  onFlowTypeChange: (type: NovelFlowType) => void
  /** 启动流程（可带 per-call 模型与思考强度，输入框旁选择器传入） */
  onStartFlow: (modelId?: ModelRef | null) => void
  /**
    * 输入框命令启动 flow（/写 N、/重写 N、/群聊 N）：按命令解析出的章节号
   * 启动对应创作流程，与 onStartFlow（playhead 章节）互补；由 workspace 提供。
   */
  onStartFlowCommand?: (
    command: 'write' | 'rewrite' | 'discuss',
    chapterNumber: number,
    modelId?: ModelRef | null
  ) => void
  /** 取消流程 */
  onCancelFlow: () => void

  // ── 创作流程历史恢复 ──
  // 工作流/群聊的持久化消息存于章节聊天存储；无实时状态时据此恢复对话历史。
  // 自由聊天和结构化创作共用本面板时间线。
  chapterChatMessages?: ChapterChatMessage[]
}

export function NovelConversationPanel({
  phase,
  isRunning,
  progressMessage,
  chapterContent,
  agentOutputs,
  chapterNumber,
  currentCheckpoint,
  checkpointHistory,
  result,
  error,
  onRetry,
  onDismissError,
  onReRevise,
  onKeepDraft,
  onResumeDiscussion,
  onResumeWorkflow,
  chapterChatAgentOutputs,
  chapterChatRunning = false,
  chapterChatError = null,
  onSendChapterChat,
  onAbortChapterChat,
  chatMentionOptions,
  styleExperts = DEFAULT_NOVEL_STYLE_EXPERTS,
  selectedStyleExpertIds,
  onStyleExpertsChange,
  onOpenStyleExperts,
  onSubmitCheckpoint,
  onSave,
  onDiscard,
  onSendMessage,
  userMessages,
  interjectMessages,
  onSendInterject,
  flowType,
  onFlowTypeChange,
  onStartFlow,
  onStartFlowCommand,
  onCancelFlow,
  chapterChatMessages
}: NovelConversationPanelProps): ReactElement {
  const effectiveStyleExpertIds = selectedStyleExpertIds
    ?? styleExperts.filter((expert) => expert.enabled).map((expert) => expert.id)
  // 右栏会话面板在切换到详情/设置时会卸载；模型偏好放在持久化 store，
  // 避免切页后回到会话又回到“默认模型”。
  const creationModelRef = useNovelUiStore((state) => state.selectedAgentModel)
  const [interjectTarget, setInterjectTarget] = useState<NovelInterjectTargetAgent | 'next'>('next')
  const isArrangeMode = flowType === 'arrange'
  const isReverseMode = flowType === 'reverse'
  const isCompleted = phase === 'completed'
  const isError = phase === 'error'
  // 反推和 AI 编排不生成正文，不显示"保存到章节"。
  // AI 编排的落库由 arrange_review 的确认按钮完成，不是流程结束后的额外保存。
  const canSave = isCompleted && !!chapterContent && !isArrangeMode && !isReverseMode
  // 时间线重建的对话流可见化状态（由顶栏 TimelineRebuildControl 同步写入）
  const timelineStatus = useTimelineRebuildStore((s) => s.status)

  // ── 完成时的动作标签 ──
  const completedActionLabel = isArrangeMode ? '编排' : isReverseMode ? '反推' : '创作'

  // ── 数据映射 ──
  const messages = useMemo<ConversationMessage[]>(() => {
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
      msgs.push({
        id: output.messageId
          ? `agent-${output.messageId}`
          : `agent-${output.timestamp}-${output.agentType}-${index}`,
        role: 'assistant',
        agentName: output.agentName,
        agentType: mapAgentType(output.agentType),
        content: output.streaming ? output.preview : (thinkingText ?? output.content),
        streamingBuffer: output.streaming
          ? output.hasStreamedText
            ? output.content
            : (thinkingText ?? output.content)
          : undefined,
        status: output.streaming ? 'streaming' : 'complete',
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
  }, [
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
  ])

  // ── 回调 ──
  // 输入框常开（含检查点等待），发送分流（任务 5）：
  // - 运行中：普通文本 → 插话端点（注入下一个 Agent）；以 / 开头的命令一律拦截
  //   （运行中打命令属误操作，作为插话注入会误导 Agent，故不发送只 toast）。
  //   未接插话通道的调用方回退旧的 onSendMessage（本地暂存、随检查点决策一并提交）。
  // - 空闲：斜杠命令（/写 N、/继续、/重写 N、/群聊 N）直达 flow；章节号越界的命令
  //   （/写 0）toast 提示范围；普通文本不发送不启动，toast 引导到「聊天」面板
  //   （自由聊天在独立"聊天"视图，静默丢弃会让用户以为已发出）。
  const handleSend = useCallback(
    (text: string) => {
      if (isRunning) {
        if (text.trim().startsWith('/')) {
          toastWarning('流程运行中命令不可用', '命令未发送；如需中途反馈请输入普通文本')
          return
        }
        if (onSendInterject) {
          if (flowType === 'workflow' && interjectTarget !== 'next') {
            onSendInterject(text, interjectTarget)
          } else {
            onSendInterject(text)
          }
          return
        }
        onSendMessage?.(text)
        return
      }

      const parsed = parseCommand(text)
      if (!parsed) return
      switch (parsed.kind) {
        case 'write':
        case 'rewrite':
        case 'discuss':
          onStartFlowCommand?.(parsed.kind, parsed.chapterNumber, creationModelRef)
          return
        case 'resume':
          // 断点续跑：优先用 result 携带的 runId（群聊/工作流），
          // 与 ErrorCard「从中断处继续」复用同一恢复通道。
          // 工作流无 result 时回退 'latest'（后端取该章最近一条可续跑快照，
          // 覆盖应用重启后 result 丢失的场景）。
          if (result?.canResume && result.discussionRunId && onResumeDiscussion) {
            onResumeDiscussion(result.discussionRunId)
          } else if (result?.canResume && result.workflowRunId && onResumeWorkflow) {
            onResumeWorkflow(result.workflowRunId)
          } else if (onResumeWorkflow && (flowType === 'workflow' || result?.workflowRunId)) {
            onResumeWorkflow('latest')
          } else {
            toastInfo('暂无可恢复的流程', '中断的工作流/群聊支持 /继续 恢复；也可 /写 N 重新开始')
          }
          return
        case 'unknown':
          toastError(`未知命令：${parsed.raw}`, '支持 /写 N、/继续、/重写 N、/群聊 N')
          return
        case 'invalid-chapter':
          toastWarning('章节号需在 1-9999 之间', parsed.raw)
          return
        case 'chat':
          // 空闲态普通文本进入同一章节会话；斜杠命令仍由上面的分支控制流程。
          if (onSendChapterChat) {
            onSendChapterChat(text, undefined, creationModelRef, effectiveStyleExpertIds)
          } else {
            toastInfo('自由对话请切换到「聊天」面板', '输入 /写 N 可启动创作')
          }
          return
      }
    },
    [
      isRunning,
      interjectTarget,
      onSendInterject,
      onSendMessage,
      onStartFlowCommand,
      creationModelRef,
      result,
      onResumeDiscussion,
      onResumeWorkflow,
      flowType,
      onSendChapterChat,
      effectiveStyleExpertIds
    ]
  )

  const handleAbort = useCallback(() => {
    if (phase !== 'cancelling') {
      // onCancelFlow 是 async（等待后端真实断开），void 明确忽略返回的 Promise
      // cancelling 状态下禁用重复取消
      void onCancelFlow()
    }
  }, [onCancelFlow, phase])

  const handleCheckpointResolve = useCallback(
    (action: string, comment?: string) => {
      // 返回提交链的 promise，供 CheckpointMessage 跟踪 in-flight 状态（防重复提交）
      return onSubmitCheckpoint(action as CheckpointDecision, comment)
    },
    [onSubmitCheckpoint]
  )

  const handleSystemAction = useCallback(
    (action: string) => {
      if (action === 'save') {
        if (chapterContent) void onSave(chapterContent)
      } else if (action === 'discard' && phase !== 'cancelling') {
        // onDiscard 是 async（等待后端真实断开），void 明确忽略返回的 Promise
        // cancelling 状态下禁用重复 discard
        void onDiscard()
      } else if (action.startsWith('resume-discussion:')) {
        onResumeDiscussion?.(action.slice('resume-discussion:'.length))
      } else if (action.startsWith('resume-workflow:')) {
        onResumeWorkflow?.(action.slice('resume-workflow:'.length))
      }
    },
    [chapterContent, onSave, onDiscard, onResumeDiscussion, onResumeWorkflow, phase]
  )

  // 空状态提示
  const emptyHint = isReverseMode
    ? '点击"开始"从章节正文反向提取实体到矩阵'
    : isArrangeMode
      ? '点击"开始"让 AI 自动编排本章矩阵实体'
      : flowType === 'discussion'
        ? '用于多角色谈判、博弈和高潮场景。普通章节优先使用工作流'
        : '点击"开始"启动创作流程'

  // 空状态标题
  const emptyTitle = isReverseMode
    ? '反推实体'
    : isArrangeMode
      ? 'AI 矩阵编排'
      : flowType === 'discussion'
        ? '高级群聊共创'
        : '开始创作'

  // 空状态插图变体
  const emptyVariant: EmptyStateVariant = isReverseMode
    ? 'reverse'
    : isArrangeMode
      ? 'arrange'
      : flowType === 'discussion'
        ? 'discussion'
        : 'workflow'

  const isEmpty = messages.length === 0
  const activeError = error
  const activeIsRunning = isRunning || chapterChatRunning

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── 流程模式分级入口：高频 Segmented + 低频 Popover ── */}
      <header className="shrink-0 border-b border-border/60 bg-surface-1">
        <div className="flex items-center gap-1.5 px-2 pt-2 pb-0">
          {isRunning ? (
            /* 运行中：锁定当前模式，显示名称 + 阶段 */
            <div className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-primary/8 text-primary">
              {(() => {
                const tab = FLOW_TABS.find((t) => t.type === flowType)
                const Icon = tab?.icon ?? Workflow
                return <Icon className="size-3.5" />
              })()}
              <span className="text-micro font-medium whitespace-nowrap">
                {FLOW_TABS.find((t) => t.type === flowType)?.label ?? flowType}
              </span>
            </div>
          ) : (
            <>
              {/* 工作流和群聊统一由会话命令选择；这里仅保留反推与矩阵编排 */}
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
                        'inline-flex items-center gap-1.5 h-6 px-2.5 text-micro font-medium rounded-[6px]',
                        'transition-all duration-200 ease-out active:scale-[0.96]',
                        isActive
                          ? 'bg-surface-1 text-text shadow-sm'
                          : 'text-subtle hover:text-text hover:bg-surface-1/50'
                      )}
                    >
                      <Icon className="size-3" />
                      <span className="leading-none">{tab.label}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
        {/* 状态栏：独立圆角卡片样式（对齐原型 status-bar + status-badge 胶囊 + 语义状态色） */}
        <div className="mx-2 mt-2 mb-3 flex items-center gap-2 px-3 py-1.5 bg-surface-2 rounded-lg">
          {chapterNumber != null && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-surface-3 text-text-secondary text-nano font-medium tabular-nums shrink-0">
              第 {chapterNumber} 章
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {activeIsRunning && (
              <motion.span
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                className="flex min-w-0 max-w-[240px] items-center gap-1 text-micro text-primary"
                title={progressMessage ?? PHASE_LABELS[phase] ?? phase}
              >
                <Loader2 className="size-3 shrink-0 animate-spin" />
                <span className="truncate">{progressMessage ?? PHASE_LABELS[phase] ?? phase}</span>
              </motion.span>
            )}
            {!activeIsRunning && isCompleted && (
              <span className="text-micro text-success">{completedActionLabel}完成</span>
            )}
            {!activeIsRunning && isError && (
              <span className="text-micro text-destructive">出错</span>
            )}
            {!activeIsRunning && phase === 'idle' && (
              <span className="text-micro text-muted-foreground">等待开始</span>
            )}
          </div>
        </div>
      </header>

      {/* ── 消息流 ── */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {(activeError || chapterChatError) && (
          <div className="p-3 shrink-0">
            {chapterChatError && !activeError && (
              <div className="mb-2 rounded-lg border border-destructive/45 bg-destructive/8 px-3 py-2 text-xs text-destructive">
                {chapterChatError}
              </div>
            )}
            {activeError && (result?.errorCode === 'quality_gate_revision_incomplete' ? (
              // 质量门修订失败：展示具体未通过项 + 修订记录 + 原始报错，
              // 并提供再次修订/手动编辑/保留草稿/取消，避免整条重跑。
              <QualityGateFailureCard
                result={result}
                error={error}
                onReRevise={onReRevise}
                onKeepDraft={onKeepDraft}
                onDiscard={onDismissError}
              />
            ) : (
              <ErrorCard
                message={activeError}
                onRetry={
                  result?.canResume && result.discussionRunId
                    ? () => onResumeDiscussion?.(result.discussionRunId!)
                    : result?.canResume && result.workflowRunId
                      ? () => onResumeWorkflow?.(result.workflowRunId!)
                      : onRetry
                }
                retryLabel={result?.canResume ? '从中断处继续' : '重试'}
                onDismiss={onDismissError}
              />
            ))}
          </div>
        )}
        {isEmpty ? (
          /* 空状态：SVG 插图 + 标题 + 引导文案 */
          <ConversationEmptyState variant={emptyVariant} title={emptyTitle} hint={emptyHint} />
        ) : (
          <ConversationStream
            messages={messages}
            onCheckpointResolve={handleCheckpointResolve}
            // 群聊检查点不提供修改意见输入：decision 端点 discussion 分支不消费
            // userMessages（意见会被静默丢弃），反馈走底部常开插话输入
             allowCheckpointComment={flowType !== 'discussion'}
            onSystemAction={handleSystemAction}
            emptyHint={emptyHint}
            emptyTitle={emptyTitle}
            emptyVariant={emptyVariant}
          />
        )}
      </div>

      {/* ── 输入区 ── */}
      <div className="shrink-0 border-t border-border">
        {isRunning && flowType === 'workflow' && (
          <div className="flex items-center gap-2 px-2 pt-1.5">
            <span className="text-xs text-muted-foreground">反馈给</span>
            <Select
              value={interjectTarget}
              onValueChange={(value) => setInterjectTarget(value as NovelInterjectTargetAgent | 'next')}
            >
              <SelectTrigger size="sm" className="min-w-32" aria-label="插话目标 Agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERJECT_TARGET_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <ConversationInput
          onSend={handleSend}
           onSendWithMentions={(text, mentionedIds) => {
            if (text.trim().startsWith('/')) {
              handleSend(text)
              return
            }
             if (isRunning) {
               handleSend(text)
             } else if (onSendChapterChat) {
              onSendChapterChat(text, mentionedIds, creationModelRef, effectiveStyleExpertIds)
            }
          }}
          mentionOptions={chatMentionOptions}
          commandOptions={SESSION_COMMANDS}
          styleExperts={styleExperts}
          selectedStyleExpertIds={effectiveStyleExpertIds}
          onStyleExpertsChange={onStyleExpertsChange}
          onOpenStyleExperts={onOpenStyleExperts}
            onAbort={() => {
              if (isRunning) handleAbort()
              else onAbortChapterChat?.()
            }}
          isRunning={activeIsRunning}
           allowSendWhileRunning={!isReverseMode && !isArrangeMode}
           // AI 编排意见通过确认卡内输入框随「按意见修改」提交，避免误走工作流插话端点。
           disabled={isReverseMode || (isArrangeMode && !currentCheckpoint)}
           placeholder={
             isReverseMode
               ? '反推流程进行中...'
               : isArrangeMode && !currentCheckpoint
                 ? 'AI编排进行中...'
                 : isArrangeMode
                   ? '填写意见后点击「按意见修改」...'
                 : chapterChatRunning
                  ? 'Agent 正在回复…'
                  : isRunning && currentCheckpoint
                  ? '可先反馈再确认检查点'
                  : isRunning
                    ? '发送反馈将注入下一个 Agent…'
                    : '/写 11 启动创作…'
          }
          showStart={!isRunning && !chapterChatRunning && phase === 'idle'}
          startLabel="开始"
          onStart={() => onStartFlow(creationModelRef)}
        />
      </div>
    </div>
  )
}
