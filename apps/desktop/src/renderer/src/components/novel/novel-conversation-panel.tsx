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

import { useCallback, useState, type ReactElement } from 'react'
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
import { StalledRunBanner } from './stalled-run-banner'
import { ChapterBeatBanner } from './chapter-beat-banner'
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
import type { ChatAgentOutput } from '@/hooks/use-chapter-chat'
import type { ChapterChatMessage } from '@/api/novel-client'
import { useTimelineRebuildStore } from '@/stores/timeline-rebuild-store'
import { useConversationMessages } from '@/hooks/use-conversation-messages'
import type { NovelCreationMode, NovelInterjectTargetAgent } from '@repo/shared/novel'
import { type NovelStyleExpert } from '@repo/shared/novel'
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
    label: '群聊',
    icon: MessagesSquare,
    description: '多角色群聊共创（高级）：适合谈判、博弈和高潮场景；调用轮次和耗时高于默认工作流'
  },
  { type: 'reverse', label: '反推', icon: RotateCcw },
  { type: 'arrange', label: '编排', icon: LayoutGrid }
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

/** 创作模式：4 个全部平铺（P1-3 可发现性——斜杠命令只是加速器，不是唯一通道） */
const PRIMARY_FLOW_TABS = FLOW_TABS

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
  acting: '角色演出中',
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

// ── 质量门修订失败卡片 ──
// 与通用 ErrorCard 的区别：失败不是基础设施故障，而是确定性质量门未通过。
// 展示具体未通过项 + 修订记录 + 原始报错，并提供「再次修订/手动编辑/保留草稿/取消」
// 四个出口 —— 成果与已花 token 不再因一次失败被整条丢弃。
// （检查点选项常量与消息合并逻辑已迁至 hooks/use-conversation-messages.ts）

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

// ── Props ──

export interface NovelConversationPanelProps {
  /** 当前项目 ID（用于查询本章是否有中断的可续跑创作） */
  projectId?: string
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
  /** 打开召集面板时重新拉取专家列表（新蒸馏的专家立即可见） */
  onStyleExpertsRefresh?: () => void
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
  projectId,
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
  styleExperts = [],
  selectedStyleExpertIds,
  onStyleExpertsChange,
  onOpenStyleExperts,
  onStyleExpertsRefresh,
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
  // 默认不召集：专家是本轮显式追加的能力，未选中时只跑项目文风基线。
  // 传 undefined（父组件未托管选择状态）时同样视为"未召集"，不再默认全选。
  const effectiveStyleExpertIds = selectedStyleExpertIds ?? []
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
  // P2-1a：消息合并逻辑已抽至 useConversationMessages（纯函数 + 单测）
  const messages = useConversationMessages({
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
  })

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

  const activeError = error
  const activeIsRunning = isRunning || chapterChatRunning

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── 单行 header：左流程模式 + 右章节徽章/状态（原两行合并，省出消息区高度）── */}
      <header className="shrink-0 border-b border-border/60 bg-surface-1">
        <div className="flex items-center gap-1.5 px-2 h-9">
          {isRunning ? (
            /* 运行中：锁定当前模式，显示名称 */
            <div className="flex items-center gap-1.5 h-6 px-2 rounded-lg bg-primary/8 text-primary shrink-0">
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
              {/* 四种流程全部平铺（P1-3）；运行中锁定显示当前模式 */}
              <div className="inline-flex items-center gap-0.5 p-0.5 bg-surface-2 rounded-lg shrink-0 min-w-0 overflow-x-auto scrollbar-none">
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

          {/* 右侧：章节徽章 + 状态（窄栏下状态文字优先截断） */}
          <div className="ml-auto flex items-center gap-1.5 min-w-0">
            {chapterNumber != null && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-surface-3 text-text-secondary text-nano font-medium tabular-nums shrink-0">
                第 {chapterNumber} 章
              </span>
            )}
            {activeIsRunning && (
              <motion.span
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                className="flex min-w-0 max-w-[200px] items-center gap-1 text-micro text-primary"
                title={progressMessage ?? PHASE_LABELS[phase] ?? phase}
              >
                <Loader2 className="size-3 shrink-0 animate-spin" />
                <span className="truncate">{progressMessage ?? PHASE_LABELS[phase] ?? phase}</span>
              </motion.span>
            )}
            {!activeIsRunning && isCompleted && (
              <span className="shrink-0 text-micro text-success">{completedActionLabel}完成</span>
            )}
            {!activeIsRunning && isError && (
              <span className="shrink-0 text-micro text-destructive">出错</span>
            )}
            {!activeIsRunning && phase === 'idle' && (
              <span className="shrink-0 text-micro text-muted-foreground">等待开始</span>
            )}
          </div>
        </div>
      </header>

      {/* ── 本章节拍横幅：创作目标章的卷级节拍约束（与大纲树共享数据源）── */}
      <ChapterBeatBanner projectId={projectId} chapterNumber={chapterNumber} />

      {/* ── 中断创作提示条：空闲且有可续跑快照时展示，解决"半成品不可见" ── */}
      <StalledRunBanner
        projectId={projectId}
        chapterNumber={chapterNumber}
        visible={!activeIsRunning && phase === 'idle'}
        onResume={(runId) => onResumeWorkflow?.(runId)}
      />

      {/* ── 消息流（错误卡经 stickyFooter 吸底，不再压缩消息可视区）── */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
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
          stickyFooter={
            (activeError || chapterChatError) ? (
              <div className="space-y-2 pb-1">
                {chapterChatError && !activeError && (
                  <div className="rounded-lg border border-destructive/45 bg-destructive/8 px-3 py-2 text-xs text-destructive backdrop-blur-sm">
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
            ) : undefined
          }
        />
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
          onStyleExpertsRefresh={onStyleExpertsRefresh}
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
