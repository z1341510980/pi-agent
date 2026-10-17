/**
 * 小说多 Agent 创作流程 SSE Hook（ag-ui 协议）
 *
 * 与 chat 共用同一套 ag-ui 技术栈：通过 `@/api/agui-client` 的 `parseSseStream`
 * 解析 SSE 流，按 `BaseEvent.type` 与 `CustomEvent.name` 分发事件。
 * chat 是底座，小说是插件，二者使用同一个 SSE 解析器与事件协议。
 *
 * 后端端点：
 *   POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/create-flow
 *   POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/ai-arrange
 *
 * ag-ui 事件格式（data: 行后跟 JSON）：
 *   - { type: 'RUN_STARTED',  threadId, runId }                      流开始
 *   - { type: 'CUSTOM', name: 'novel:progress',  value: CreationFlowEvent }   阶段变更/Agent 事件
 *   - { type: 'CUSTOM', name: 'novel:checkpoint', value: CheckpointData }     等待用户决策
 *   - { type: 'CUSTOM', name: 'novel:result',    value: CreationResult }      流程结束
 *   - { type: 'RUN_FINISHED', threadId, runId }                       流结束（result 后紧跟）
 *   - { type: 'RUN_ERROR', message: string }                          错误
 *
 * 检查点决策端点：
 *   POST /api/plugins/novel/projects/:projectId/checkpoint/:type/decision
 *   body: { decision: 'approve' | 'reject' | 'revise' | 'rewrite' }
 */

import { useCallback, useRef, useState } from 'react'
import { browserConfig } from '@repo/config/browser'
import { creationFlowCommands } from './creation-flow-commands'
import { parseSseStream } from '@/api/agui-client'
import type { BaseEvent, CustomEvent } from '@repo/protocol/events'

// 创作流程事件协议类型（CreationPhase/CheckpointType/CheckpointData/CheckpointDecision/
// CreationFlowEvent/AgentOutput/CreationResult）已迁入 @repo/shared/novel 共享包，
// 此处 re-export 供组件层沿用 hook 路径引入。
export type {
  CreationPhase,
  CheckpointType,
  CheckpointDecision,
  CheckpointData,
  CreationFlowEvent,
  AgentOutput,
  CreationResult
} from '@repo/shared/novel'

import type {
  CreationPhase,
  CheckpointData,
  CheckpointDecision,
  CreationFlowEvent,
  AgentOutput,
  CreationResult,
  NovelUserMessageEvent,
  NovelInterjectTargetAgent
} from '@repo/shared/novel'
import { applyUserMessageEvent, streamsChapterContent, type InterjectMessage } from './creation-flow-reducer'
export { applyUserMessageEvent, streamsChapterContent }
export type { InterjectMessage }

/** 用户在创作过程中发送的消息（参与创作的指令，前端 UI 独有类型） */
export interface UserMessage {
  id: string
  content: string
  timestamp: number
}

/** sendInterject 结果：成功返回 messageId（已排队），失败附 HTTP 状态码（409=无运行中流程） */
export type SendInterjectOutcome =
  | { ok: true; messageId: string }
  | { ok: false; error: string; statusCode?: number }

/**
 * 统一占位覆盖辅助（2026-08-28 控制平面重排 T3）：
 * director / character / moderator 三类 agent_output 共用的"覆盖占位或追加"逻辑。
 *
 * 工具主路径的终答常为空 stop，没有 TEXT_MESSAGE_* 去关闭 agent_start 的
 * 「已启动」占位气泡；必须靠后端补发的 agent_output 事件覆盖占位，否则出现
 * 空气泡、重复气泡、永久 streaming 三种症状。覆盖时保留占位气泡的时间戳，
 * 不改写时间线顺序。
 */
function upsertAgentOutput(
  prev: AgentOutput[],
  input: {
    agentType: AgentOutput['agentType']
    agentName: string
    content: string
    /** 仅追加路径使用；覆盖占位时沿用占位气泡原时间戳。 */
    timestamp: number
    /** 角色回合的私有判断层，与公开正文同气泡分层展示。 */
    actorTurn?: AgentOutput['actorTurn']
    /** 预览截断长度（导演场景计划较长取 200，其余 100）。 */
    previewLength?: number
    /** 连续同类型输出合并进最后一条气泡（主持人点名防刷屏）。 */
    mergeConsecutive?: boolean
    /** 覆盖同类型最后一个「已启动且无正文」的占位气泡（工具主路径）。 */
    overwritePlaceholder?: boolean
  },
): AgentOutput[] {
  const preview = input.content.slice(0, input.previewLength ?? 100)
  if (input.mergeConsecutive) {
    const last = prev[prev.length - 1]
    if (last && last.agentType === input.agentType && !last.streaming) {
      return [
        ...prev.slice(0, -1),
        { ...last, content: `${last.content}\n\n${input.content}`, preview },
      ]
    }
  }
  const patch: AgentOutput = {
    agentType: input.agentType,
    agentName: input.agentName,
    content: input.content,
    preview,
    timestamp: input.timestamp,
    streaming: false,
    ...(input.actorTurn ? { actorTurn: input.actorTurn } : {}),
  }
  if (input.overwritePlaceholder) {
    const placeholderIndex = prev.findLastIndex(
      (output) => output.agentType === input.agentType && output.streaming && !output.hasStreamedText,
    )
    if (placeholderIndex !== -1) {
      const updated = [...prev]
      updated[placeholderIndex] = { ...updated[placeholderIndex], ...patch }
      return updated
    }
  }
  return [...prev, patch]
}

type StreamAgentMeta = Pick<AgentOutput, 'agentType' | 'agentName'>

const PHASE_AGENT_META: Record<string, StreamAgentMeta> = {
  directing: { agentType: 'director', agentName: '导演' },
  acting: { agentType: 'character', agentName: '角色演出' },
  writing: { agentType: 'writer', agentName: '写作' },
  rewriting: { agentType: 'writer', agentName: '写作' },
  reviewing: { agentType: 'reviewer', agentName: '审稿' },
  revising: { agentType: 'reviser', agentName: '修订' },
  memory: { agentType: 'memory', agentName: '记忆' },
  chapter_weaving: { agentType: 'writer', agentName: '编织' },
}

function inferStreamAgentMeta(phase: string | undefined): StreamAgentMeta | undefined {
  return phase ? PHASE_AGENT_META[phase] : undefined
}

// ── Hook 返回值 ──

/**
 * 传给 create-flow / create-discussion 的矩阵编排实体。
 *
 * itemIds 与 characterFunctions 早期缺失，导致后端已就绪的
 * “本章登场物品”约束段与角色短卡的“本章作用”行永不渲染。
 */
export interface ArrangedEntitiesPayload {
  characterIds: string[]
  conflictIds: string[]
  foreshadowIds: string[]
  clueIds: string[]
  factionIds: string[]
  locationIds: string[]
  itemIds?: string[]
  narrativeIds?: string[]
  characterFunctions?: Array<{ characterId: string; function: string; note?: string }>
}

export interface UseNovelCreationFlowReturn {
  /** 当前阶段 */
  phase: CreationPhase
  /** 是否正在运行 */
  isRunning: boolean
  /** 当前可覆盖的流程进度文案（纯 phase_change 不进入对话时间线） */
  progressMessage: string | null
  /** 所有已收到的事件（用于回放/调试） */
  events: CreationFlowEvent[]
  /** 待处理的检查点（用户需决策） */
  currentCheckpoint: CheckpointData | null
  /** 本次运行中已处理的检查点，保留用户选择供时间线回看 */
  checkpointHistory: CheckpointData[]
  /** 最终结果 */
  result: CreationResult | null
  /** 错误信息 */
  error: string | null
  /** 累积的章节内容 */
  chapterContent: string
  /** 各 Agent 的输出时间线（按到达顺序） */
  agentOutputs: AgentOutput[]
  /** 用户在创作过程中发送的消息（参与创作的指令） */
  userMessages: UserMessage[]
  /** flow 运行中的插话消息（SSE novel:user-message 驱动状态流转） */
  interjectMessages: InterjectMessage[]
  /** 启动创作流程 */
  startCreation: (
    projectId: string,
    chapterNumber: number,
    options?: {
      arrangedEntities?: ArrangedEntitiesPayload
      /** per-call 模型（输入框旁选择器传入，本次创作统一使用） */
      modelId?: { provider: string; modelId: string; thinkingLevel?: import('./../stores/session-store').ThinkingLevel | null }
      styleExpertIds?: string[]
    }
  ) => Promise<void>
  /**
   * 启动群聊模式创作流程。
   *
   * 与 startCreation 结构一致，仅后端端点不同（/create-discussion），
   * ag-ui 事件格式与状态机共用同一 handleEvent。
   */
  startDiscussion: (
    projectId: string,
    chapterNumber: number,
    options?: {
      arrangedEntities?: ArrangedEntitiesPayload
      styleExpertIds?: string[]
    }
  ) => Promise<void>
  /** 从失败的群聊快照直接恢复 Writer 全章编织阶段 */
  resumeDiscussion: (projectId: string, chapterNumber: number, runId: string) => Promise<void>
  /**
   * 工作流断点续跑：从失败快照恢复，跳过已完成阶段。
   * runId 传 'latest' 取该章最近一条可续跑快照（应用重启后使用）。
   */
  resumeWorkflow: (projectId: string, chapterNumber: number, runId: string) => Promise<void>
  /**
   * 启动 AI 编排流程（模式2）
   *
   * 后端按章纲 AI 编排实体并落库，不生成正文。
   * ag-ui 事件格式与 startCreation 共用同一 handleEvent 状态机；额外增加 arrange_start/arrange_progress/arrange_done
   * 进度事件会以 CUSTOM(novel:progress) 流入 events 时间线（value.type 区分）。
   */
  aiArrange: (
    projectId: string,
    chapterNumber: number,
    options?: { modelId?: { provider: string; modelId: string; thinkingLevel?: import('./../stores/session-store').ThinkingLevel | null } },
  ) => Promise<void>
  /**
   * 启动反推流程（模式3）
   *
   * 后端从已写好的章节正文反推实体（角色/冲突/伏笔/势力/地点）并落库到矩阵。
   * ag-ui 事件格式与 aiArrange 共用同一 runFlow + handleEvent 状态机；
   * arrange_start/arrange_progress/arrange_done 进度事件以 CUSTOM(novel:progress) 流入时间线。
   * 需要章节已有正文，否则后端返回错误。
   */
  reverseArrange: (
    projectId: string,
    chapterNumber: number,
    options?: { modelId?: { provider: string; modelId: string; thinkingLevel?: import('./../stores/session-store').ThinkingLevel | null } },
  ) => Promise<void>
  /**
   * 取出最近一次 AI 编排产出的角色功能位（本章作用）。
   *
   * characterFunctions 不落库，只在编排返回值里存在；触发 create-flow 时需要显式带上，
   * 否则 Writer 拿不到"每个角色本章负责推动什么"。取出后即清空。
   */
  takeArrangedCharacterFunctions: (
    chapterNumber: number
  ) => Array<{ characterId: string; function: string; note?: string }> | undefined
  /** 查看最近一次 AI 编排产出的角色功能位，但不清空缓存。 */
  peekArrangedCharacterFunctions: (
    chapterNumber: number
  ) => Array<{ characterId: string; function: string; note?: string }> | undefined
  /** 提交检查点决策（comment 为检查点卡片内修改意见，随 userMessages 一并提交既有 decision 端点） */
  submitCheckpoint: (decision: CheckpointDecision, comment?: string) => Promise<void>
  /** 用户发送消息参与创作（存入本地 state，在下一个检查点决策时一并发送） */
  sendMessage: (content: string) => void
  /**
   * 发送插话（对话化交互形态 §3.1）：flow 运行中用户的中途反馈，
   * 经插话端点入队，注入下一个被调用的 Agent（或 targetAgent 定向 Agent）。
   * 状态流转由 SSE novel:user-message 事件推回 interjectMessages。
   * 返回结果供调用方 toast：成功「已排队」；409 表示当前无运行中流程。
   */
  sendInterject: (
    content: string,
    targetAgent?: NovelInterjectTargetAgent
  ) => Promise<SendInterjectOutcome>
  /**
   * 质量门修订失败后，对已保留修订稿的未通过项**再次定向修订**。
   *
   * 与 startCreation 的本质区别：不复跑 Director/Writer/Reviewer，只针对
   * 后端返回的 failedItems 跑有界修订循环（最多 2 轮），避免失败后整条
   * 重跑烧掉大量 token。通过后返回修订稿（**不自动落库**，由用户决定保存）。
   */
  reRevise: (
    projectId: string,
    chapterNumber: number,
    content: string,
    options?: {
      arrangedEntities?: ArrangedEntitiesPayload
      modelId?: { provider: string; modelId: string; thinkingLevel?: import('./../stores/session-store').ThinkingLevel | null }
    }
  ) => Promise<void>
  /**
   * 保留当前修订稿为草稿：清空错误提示与结果，但**不丢内容**——
   * 正文继续留在编辑器可手动编辑，也不触发落库。
   */
  keepDraft: () => void
  /** 取消流程（async：等待后端真实断开后再取消 SSE） */
  cancel: () => Promise<void>
  /** 重置到 idle 状态（用于创作完成后切回节点详情面板） */
  reset: () => void
}

// ── 详情格式化（将后端 detail payload 转为可读 markdown 气泡内容）──

import { BEAT_FUNCTION_LABELS } from '@/components/novel/sidebar/beat-labels'

const RHYTHM_LABELS: Record<string, string> = {
  setup: '铺垫',
  rising: '上升',
  climax: '高潮',
  falling: '下降',
  resolution: '收束',
  twist: '转折',
  breather: '舒缓',
  suspense: '悬念'
}
const CLIMAX_INTENSITY_LABELS: Record<string, string> = {
  minor: '小高潮',
  medium: '中高潮',
  major: '大高潮'
}
const CLIMAX_TYPE_LABELS: Record<string, string> = {
  emotional: '情感',
  fate: '命运',
  character: '性格',
  combat: '打斗',
  theme: '主题',
  composite: '复合'
}
const TASK_TYPE_LABELS: Record<string, string> = {
  advance_mainline: '推进主线',
  advance_subline: '推进副线',
  create_conflict: '创建冲突',
  escalate_conflict: '升级冲突',
  release_info: '释放信息',
  hide_info: '隐藏信息',
  reinforce_foreshadow: '强化伏笔',
  recover_foreshadow: '回收伏笔',
  change_relationship: '改变关系',
  change_cognition: '改变认知',
  create_reversal: '制造突转',
  create_suspense: '制造悬念',
  phase_closure: '阶段收束',
  introduce_problem: '引入问题'
}
const PRIORITY_LABELS: Record<string, string> = { high: '高', medium: '中', low: '低' }
const CONFLICT_STAGE_LABELS: Record<string, string> = {
  latent: '潜伏',
  emerging: '浮现',
  escalating: '升级',
  erupting: '爆发',
  reversing: '逆转',
  resolved: '已解决',
  transformed: '转化'
}
const SUSPENSE_STATUS_LABELS: Record<string, string> = {
  planting: '埋设',
  sustaining: '维持',
  releasing: '释放'
}
const POSITIONING_LABELS: Record<string, string> = {
  high_pressure: '高压章',
  advancement: '推进章',
  cultivation: '修炼试错章',
  relationship: '关系回收章',
  low_pressure: '低压生活章',
  information: '信息整理章'
}
const CHAPTER_ENDING_HOOK_LABELS: Record<string, string> = {
  suspense: '悬念',
  reversal: '突转',
  emotional: '情感',
  action: '动作',
  none: '无'
}

/** 将后端 detail 事件 payload 格式化为 markdown 气泡内容
 *
 * ⚠️ 工具化方案：此函数同时被两处复用：
 * 1. useNovelCreationFlow 内部：处理 emitProgress 推送的 detail 事件（实时进度气泡）
 * 2. novel-conversation-panel 的 renderCheckpointContent：处理 checkpoint.data（检查点卡片）
 *
 * 因此本函数需要 export，避免在 CheckpointMessage 中重复格式化逻辑。
 */
export function formatDetailBubble(detail: Record<string, unknown>): {
  agentType: 'director' | 'context' | 'memory' | 'arranger' | 'reviser'
  agentName: string
  content: string
} {
  const kind = detail.kind as string
  if (kind === 'rhythm_suggestion') {
    const rhythm = detail.rhythm as string
    const climaxIntensity = detail.climaxIntensity as string | undefined
    const climaxType = detail.climaxType as string | undefined
    let md = `## 本章节奏建议\n\n**节奏**：${RHYTHM_LABELS[rhythm] ?? rhythm}`
    if (climaxIntensity)
      md += `\n**高潮强度**：${CLIMAX_INTENSITY_LABELS[climaxIntensity] ?? climaxIntensity}`
    if (climaxType) md += `\n**高潮类型**：${CLIMAX_TYPE_LABELS[climaxType] ?? climaxType}高潮`
    md += `\n\n**说明**：${detail.description as string}\n\n**原因**：${detail.reason as string}`
    return { agentType: 'context', agentName: '节奏', content: md }
  }
  if (kind === 'narrative_task') {
    // ⚠️ 工具化方案：Director 通过 novel_submit_narrative_task 工具提交完整 NarrativeTask 对象，
    // 这里把全部字段都展示出来，让用户看到提交的完整内容而不是一句话。
    const description = detail.description as string | undefined
    const taskType = detail.taskType as string
    const priority = detail.priority as string
    const secondaryTasks = (detail.secondaryTasks as string[] | undefined) ?? []
    const targetEntity = detail.targetEntity as string | null | undefined
    const climaxTarget = detail.climaxTarget as { type: string; intensity: string } | undefined
    const suspenseDuration = detail.suspenseDuration as number | undefined
    const expectedIntensityDelta = detail.expectedIntensityDelta as number | undefined
    const chapterEndingHook = detail.chapterEndingHook as string | undefined
    const chapterEndingHookDescription = detail.chapterEndingHookDescription as string | undefined
    const povCharacters = (detail.povCharacters as string[] | undefined) ?? []
    const sceneCount = detail.sceneCount as number | undefined
    const positioning = detail.positioning as string | undefined
    const timeOffset = detail.timeOffset as number | undefined

    // 标题：体现工具化方案语义（已提交，不再是"已解析"）
    let md = `## 叙事任务已提交\n`
    // 任务描述（Director 用一句话描述本章任务，是最重要的字段）
    if (description) md += `\n> ${description}\n`
    // 核心字段
    md += `\n**任务类型**：${TASK_TYPE_LABELS[taskType] ?? taskType}`
    if (secondaryTasks.length > 0) {
      md += `\n**次要任务**：${secondaryTasks.map((t) => TASK_TYPE_LABELS[t] ?? t).join('、')}`
    }
    md += `\n**优先级**：${PRIORITY_LABELS[priority] ?? priority}`
    if (targetEntity) md += `\n**目标实体**：${targetEntity}`
    if (positioning) md += `\n**章节定位**：${POSITIONING_LABELS[positioning] ?? positioning}`
    if (povCharacters.length > 0) md += `\n**POV 角色**：${povCharacters.join('、')}`
    if (sceneCount != null) md += `\n**场景数**：${sceneCount}`
    if (chapterEndingHook) {
      md += `\n**章尾钩子**：${CHAPTER_ENDING_HOOK_LABELS[chapterEndingHook] ?? chapterEndingHook}`
      if (chapterEndingHookDescription) md += `\n> ${chapterEndingHookDescription}`
    }
    if (climaxTarget)
      md += `\n**高潮目标**：${CLIMAX_TYPE_LABELS[climaxTarget.type] ?? climaxTarget.type}（${CLIMAX_INTENSITY_LABELS[climaxTarget.intensity] ?? climaxTarget.intensity}）`
    if (suspenseDuration != null) md += `\n**悬念持续**：${suspenseDuration} 章`
    if (expectedIntensityDelta != null)
      md += `\n**预期强度变化**：${expectedIntensityDelta > 0 ? '+' : ''}${expectedIntensityDelta}`
    if (timeOffset != null) md += `\n**时间线偏移**：${timeOffset} 天`
    return { agentType: 'director', agentName: '导演', content: md }
  }
  if (kind === 'narrative_task_missing') {
    // ⚠️ 工具化方案：Director 未调用 novel_submit_narrative_task 工具，没有结构化任务可展示。
    // 提示用户选择"按意见重写"重新触发 Director，或"取消创作"中止流程。
    // 显示 Director 的原始输出（截断 800 字）作为参考，让用户判断是否值得重试。
    const directorRawOutput = (detail.directorRawOutput as string | undefined) ?? ''
    let md = `## ⚠️ Director 未通过工具提交叙事任务\n\n`
    md += `Director 在本轮对话中没有调用 \`novel_submit_narrative_task\` 工具，`
    md += `无法获取结构化的叙事任务（任务类型/POV/钩子/场景数等）。\n\n`
    md += `**建议操作**：\n`
    md += `- 点击 **按意见重写** 重新触发 Director（可在输入框补充修改意见）\n`
    md += `- 或点击 **取消创作** 中止本次创作\n\n`
    if (directorRawOutput) {
      md += `### Director 的原始输出（供参考）\n\n<details>\n\n\`\`\`\n${directorRawOutput}\n\`\`\`\n\n</details>\n`
    }
    return { agentType: 'director', agentName: '导演', content: md }
  }
  if (kind === 'chapter_context') {
    const conflictTargets = (detail.conflictTargets as Array<Record<string, unknown>>) ?? []
    const suspenseHooks = (detail.suspenseHooks as Array<Record<string, unknown>>) ?? []
    const rhythmConstraint = detail.rhythmConstraint as Record<string, unknown> | undefined
    const beatConstraint = detail.beatConstraint as Record<string, unknown> | null | undefined
    let md = `## 章节约束已构建`
    if (beatConstraint) {
      const fn = BEAT_FUNCTION_LABELS[beatConstraint.dramaticFunction as string]
        ?? (beatConstraint.dramaticFunction as string)
      md += `\n\n### 卷级节拍约束\n`
      md += `\n**${fn}**${beatConstraint.arcPosition ? `（${beatConstraint.arcPosition as string}）` : ''}`
      if (beatConstraint.emotionalDebt) md += `\n- 进入本章情绪债务：${beatConstraint.emotionalDebt as string}`
      if (beatConstraint.payoff) md += `\n- 本章爽点：${beatConstraint.payoff as string}`
      if (beatConstraint.summary) md += `\n- 核心走向：${beatConstraint.summary as string}`
    }
    if (rhythmConstraint) {
      md += `\n\n### 节奏约束\n\n**${RHYTHM_LABELS[rhythmConstraint.rhythm as string] ?? rhythmConstraint.rhythm}**：${rhythmConstraint.description as string}`
    }
    if (conflictTargets.length > 0) {
      md += `\n\n### 冲突推进目标\n`
      conflictTargets.forEach((t, i) => {
        const isClimax = t.isClimax === true
        const delta = t.intensityDelta as number
        md += `\n${i + 1}. ${isClimax ? '🔥 ' : ''}**${t.description as string}** → ${CONFLICT_STAGE_LABELS[t.targetStage as string] ?? t.targetStage}（${delta > 0 ? '+' : ''}${delta} 强度${isClimax ? '，高潮章' : ''}）`
      })
    }
    if (suspenseHooks.length > 0) {
      md += `\n\n### 悬念钩子\n`
      suspenseHooks.forEach((h, i) => {
        const status = SUSPENSE_STATUS_LABELS[h.status as string] ?? (h.status as string)
        const sustained = h.sustainedChapters as number
        const release = h.releaseByChapter as number | null
        md += `\n${i + 1}. [${status}] ${h.description as string}（已持续 ${sustained} 章${release != null ? `，计划第 ${release} 章释放` : ''}）`
      })
    }
    if (conflictTargets.length === 0 && suspenseHooks.length === 0 && !rhythmConstraint && !beatConstraint) {
      md += `\n\n*本章无特殊约束*`
    }
    return { agentType: 'context', agentName: '约束', content: md }
  }
  if (kind === 'memory_result') {
    const summary = detail.summary as string
    const events = (detail.events as Array<{ type: string; description: string }>) ?? []
    let md = `## 记忆提取完成\n\n**摘要**：${summary}`
    if (events.length > 0) {
      md += `\n\n### 变更明细\n`
      events.forEach((e, i) => {
        md += `\n${i + 1}. [${e.type}] ${e.description}`
      })
    }
    return { agentType: 'memory', agentName: '记忆', content: md }
  }
  if (kind === 'arrange_plan') {
    const characters = (detail.characters as string[]) ?? []
    const conflicts = (detail.conflicts as string[]) ?? []
    const foreshadows = (detail.foreshadows as string[]) ?? []
    const factions = (detail.factions as string[]) ?? []
    const locations = (detail.locations as string[]) ?? []
    let md = `## 实体规划清单\n`
    const sections: Array<{ label: string; items: string[] }> = [
      { label: '角色', items: characters },
      { label: '冲突', items: conflicts },
      { label: '伏笔', items: foreshadows },
      { label: '势力', items: factions },
      { label: '地点', items: locations }
    ]
    for (const s of sections) {
      if (s.items.length === 0) continue
      md += `\n### ${s.label}（${s.items.length}）\n`
      s.items.forEach((it, i) => {
        md += `\n${i + 1}. ${it}`
      })
    }
    if (
      characters.length +
        conflicts.length +
        foreshadows.length +
        factions.length +
        locations.length ===
      0
    ) {
      md += `\n\n*章纲未规划新实体*`
    }
    return { agentType: 'arranger', agentName: '规划', content: md }
  }
  if (kind === 'arrange_result') {
    const characters = (detail.characters as Array<{ name: string; description: string }>) ?? []
    const conflicts =
      (detail.conflicts as Array<{
        description: string
        intensity: number
        tier: string
        climaxChapter: number | null
        climaxType: string | null
      }>) ?? []
    const foreshadows =
      (detail.foreshadows as Array<{ description: string; category: string }>) ?? []
    const factions = (detail.factions as Array<{ name: string; type: string }>) ?? []
    const locations = (detail.locations as Array<{ name: string; type: string }>) ?? []
    let md = `## 编排完成清单\n`
    if (characters.length > 0) {
      md += `\n### 角色（${characters.length}）\n`
      characters.forEach((c, i) => {
        md += `\n${i + 1}. **${c.name}** — ${c.description}`
      })
    }
    if (conflicts.length > 0) {
      md += `\n### 冲突（${conflicts.length}）\n`
      conflicts.forEach((c, i) => {
        const tierLabel = c.tier === 'main' ? '主要' : c.tier === 'goal' ? '主角目的' : '次要'
        const climaxMark = c.climaxChapter != null ? ` 🔥第${c.climaxChapter}章` : ''
        const climaxTypeLabel = c.climaxType
          ? ` ${CLIMAX_TYPE_LABELS[c.climaxType] ?? c.climaxType}高潮`
          : ''
        md += `\n${i + 1}. [${tierLabel}] ${c.description}（强度 ${c.intensity}/10${climaxMark}${climaxTypeLabel}）`
      })
    }
    if (foreshadows.length > 0) {
      md += `\n### 伏笔（${foreshadows.length}）\n`
      foreshadows.forEach((f, i) => {
        md += `\n${i + 1}. [${f.category}] ${f.description}`
      })
    }
    if (factions.length > 0) {
      md += `\n### 势力（${factions.length}）\n`
      factions.forEach((f, i) => {
        md += `\n${i + 1}. **${f.name}**（${f.type}）`
      })
    }
    if (locations.length > 0) {
      md += `\n### 地点（${locations.length}）\n`
      locations.forEach((l, i) => {
        md += `\n${i + 1}. **${l.name}**（${l.type}）`
      })
    }
    return { agentType: 'arranger', agentName: '编排', content: md }
  }
  if (kind === 'arrange_summary') {
    const total = Number(detail.total ?? 0)
    const entityDetails = detail.entityDetails as Record<string, unknown> | undefined
    const reviewPending = detail.reviewPending !== false
    const lines: string[] = [
      reviewPending ? '## 编排草稿完成，等待确认' : '## 编排完成清单',
      '',
      reviewPending
        ? `**共生成 ${total} 个实体**。确认后保留到正式矩阵；拒绝或按意见修改会回滚本轮草稿。`
        : `**共处理 ${total} 个实体**，已写入本章矩阵。`,
    ]

    const renderDetails = <T extends Record<string, unknown>>(
      key: string,
      label: string,
      render: (item: T, index: number) => string[],
    ): void => {
      const items = Array.isArray(entityDetails?.[key])
        ? entityDetails[key] as T[]
        : []
      if (items.length === 0) return
      lines.push('', `### ${label}（${items.length}）`)
      items.forEach((item, index) => lines.push('', ...render(item, index)))
    }

    renderDetails('characters', '角色', (item, index) => [
      `${index + 1}. **${String(item.name ?? '未命名角色')}**${item.id ? `（ID: \`${String(item.id)}\`）` : ''} — ${String(item.description ?? '')}`,
      ...(item.plotFunction ? [`   - 本章功能：${String(item.plotFunction)}${item.functionNote ? `；${String(item.functionNote)}` : ''}`] : []),
      ...(item.currentState ? [`   - 当前状态：${String(item.currentState)}`] : []),
      ...(item.currentGoal ? [`   - 当前目标：${String(item.currentGoal)}`] : []),
    ])
    renderDetails('conflicts', '冲突', (item, index) => [
      `${index + 1}. ${String(item.description ?? '未命名冲突')}${item.id ? `（ID: \`${String(item.id)}\`）` : ''}`,
      `   - 类型/层级：${String(item.type ?? '-')} / ${String(item.tier ?? '-')}；阶段：${String(item.stage ?? '-')}；强度：${String(item.intensity ?? '-')}/10`,
      ...(item.stakes ? [`   - 赌注：${String(item.stakes)}`] : []),
      ...(item.plotFunction || item.progressionMode ? [`   - 推进约束：${String(item.plotFunction ?? '-')} / ${String(item.progressionMode ?? '-')}`] : []),
      ...(item.climaxChapter != null ? [`   - 高潮目标：第${String(item.climaxChapter)}章${item.climaxType ? `（${String(item.climaxType)}）` : ''}`] : []),
    ])
    renderDetails('foreshadows', '伏笔', (item, index) => [
      `${index + 1}. [${String(item.category ?? '-')} / ${String(item.status ?? '-')} ] ${String(item.description ?? '')}${item.id ? `（ID: \`${String(item.id)}\`）` : ''}`,
      ...(item.chapterAction ? [`   - 本章动作：${String(item.chapterAction)}${item.beatNote ? `；${String(item.beatNote)}` : ''}`] : []),
      ...(item.plantMethod || item.recoverMethod ? [`   - 埋收方式：${String(item.plantMethod ?? '-')} / ${String(item.recoverMethod ?? '-')}`] : []),
      ...(item.recoverByChapter != null ? [`   - 计划回收：第${String(item.recoverByChapter)}章前`] : []),
    ])
    renderDetails('clues', '线索', (item, index) => [
      `${index + 1}. ${String(item.description ?? '')}${item.id ? `（ID: \`${String(item.id)}\`）` : ''}`,
      `   - 指向：${String(item.pointsTo ?? '-')}；进度：${String(item.progress ?? 0)}%`,
      `   - 当前步骤：${String(item.currentStep ?? '-')}；下一步：${String(item.nextStep ?? '-')}${item.isMisleading ? '；误导线索' : ''}`,
    ])
    renderDetails('factions', '势力', (item, index) => [
      `${index + 1}. **${String(item.name ?? '未命名势力')}**（${String(item.type ?? '-')}）${item.id ? `（ID: \`${String(item.id)}\`）` : ''} — ${String(item.description ?? '')}`,
      `   - 立场/实力：${String(item.ideology ?? '-')} / ${String(item.strength ?? '-')}；状态：${String(item.status ?? '-')}`,
    ])
    renderDetails('locations', '地点', (item, index) => [
      `${index + 1}. **${String(item.name ?? '未命名地点')}**（${String(item.type ?? '-')}）${item.id ? `（ID: \`${String(item.id)}\`）` : ''} — ${String(item.description ?? '')}`,
      `   - 重要性：${String(item.significance ?? '-')}；状态：${String(item.status ?? '-')}`,
    ])
    renderDetails('items', '物品', (item, index) => [
      `${index + 1}. **${String(item.name ?? '未命名物品')}**（${String(item.type ?? '-')}）${item.id ? `（ID: \`${String(item.id)}\`）` : ''} — ${String(item.description ?? '')}`,
      ...(item.abilities ? [`   - 能力：${String(item.abilities)}`] : []),
      ...(item.origin ? [`   - 来源：${String(item.origin)}`] : []),
      `   - 状态：${String(item.status ?? '-')}${item.ownerId ? `；持有者：\`${String(item.ownerId)}\`` : ''}`,
    ])
    renderDetails('narratives', '剧情', (item, index) => [
      `${index + 1}. [${String(item.type ?? '-')} / ${String(item.status ?? '-')}] ${String(item.description ?? '')}${item.id ? `（ID: \`${String(item.id)}\`）` : ''}`,
    ])

    if (!entityDetails || !Object.values(entityDetails).some((value) => Array.isArray(value) && value.length > 0)) {
      const arranged = detail.arrangedEntities as Record<string, unknown> | undefined
      const count = (key: string): number => {
        const direct = Number(detail[key])
        if (Number.isFinite(direct)) return direct
        const idKey: Record<string, string> = {
          characters: 'characterIds',
          conflicts: 'conflictIds',
          foreshadows: 'foreshadowIds',
          clues: 'clueIds',
          factions: 'factionIds',
          locations: 'locationIds',
          items: 'itemIds',
          narratives: 'narrativeIds',
        }
        const ids = arranged?.[idKey[key] ?? `${key}Ids`]
        return Array.isArray(ids) ? ids.length : 0
      }
      lines.push(
        '',
        `- 角色：${count('characters')}`,
        `- 冲突：${count('conflicts')}`,
        `- 伏笔：${count('foreshadows')}`,
        `- 线索：${count('clues')}`,
        `- 势力：${count('factions')}`,
        `- 地点：${count('locations')}`,
        `- 物品：${count('items')}`,
        `- 剧情：${count('narratives')}`,
      )
    }
    if (reviewPending) lines.push('', '请在下方确认落库，或填写意见后按意见修改。')
    return { agentType: 'arranger', agentName: '编排', content: lines.join('\n') }
  }
  if (kind === 'revision_passed') {
    // re-revise 定向修订通过：展示轮次与结果（不自动落库，由用户决定保存）
    const rounds =
      (detail.revisionRounds as Array<{ round: number; appliedPatches: number }> | undefined) ?? []
    const applied = rounds.reduce((sum, r) => sum + (r.appliedPatches ?? 0), 0)
    const md = [
      '## 定向修订完成',
      '',
      '正文已通过确定性质量门（未自动落库）。',
      '',
      `- 修订轮次：${rounds.length} 轮`,
      `- 成功应用修改：${applied} 处`,
      '',
      '可在编辑器中继续修改，或点击「保存到章节」落库。'
    ].join('\n')
    return { agentType: 'reviser', agentName: '修订', content: md }
  }
  if (kind === 'quality_gate_revision_incomplete') {
    // 质量门修订失败：结构化信息已由 NovelConversationPanel 的失败卡展示，
    // 这里给时间线一条摘要气泡，方便回看。
    const failedItems =
      (detail.failedItems as Array<{ gateId?: string; reason?: string }> | undefined) ?? []
    const rounds =
      (detail.revisionRounds as Array<{ round: number; appliedPatches: number }> | undefined) ?? []
    const md = [
      '## 正文质量门未通过',
      '',
      '修订稿已保留（未落库），可对未通过项再次定向修订、手动编辑或保留草稿。',
      '',
      ...(failedItems.length > 0
        ? [
            '**未通过项：**',
            ...failedItems.map((item) => `- ${item.reason ?? item.gateId ?? '未知项'}`),
            ''
          ]
        : []),
      ...(rounds.length > 0
        ? [
            `**已自动修订：** ${rounds.length} 轮（成功应用 ${rounds.reduce((sum, r) => sum + (r.appliedPatches ?? 0), 0)} 处修改）`
          ]
        : [])
    ].join('\n')
    return { agentType: 'reviser', agentName: '修订', content: md }
  }
  return { agentType: 'context', agentName: '详情', content: '未知详情类型' }
}

/**
 * useNovelCreationFlow
 *
 * 管理 SSE 连接生命周期与状态机：
 *   idle ──startCreation──▶ running ──result/error──▶ idle
 *                              │
 *                              └──checkpoint──▶ 等待 submitCheckpoint ──▶ 继续 running
 */
export function useNovelCreationFlow(): UseNovelCreationFlowReturn {
  const [phase, setPhase] = useState<CreationPhase>('idle')
  const [isRunning, setIsRunning] = useState(false)
  const [progressMessage, setProgressMessage] = useState<string | null>(null)
  const [events, setEvents] = useState<CreationFlowEvent[]>([])
  const [currentCheckpoint, setCurrentCheckpoint] = useState<CheckpointData | null>(null)
  const [checkpointHistory, setCheckpointHistory] = useState<CheckpointData[]>([])
  const [result, setResult] = useState<CreationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chapterContent, setChapterContent] = useState('')
  const [agentOutputs, setAgentOutputs] = useState<AgentOutput[]>([])
  const [userMessages, setUserMessages] = useState<UserMessage[]>([])
  const [interjectMessages, setInterjectMessages] = useState<InterjectMessage[]>([])

  const abortControllerRef = useRef<AbortController | null>(null)
  /**
   * 当前 runFlow 的 Promise（用于 cancel 时等待 SSE 自然结束）。
   *
   * 关键：cancel() 不应立即本地 abort SSE，而是先通知后端 abort，
   * 等待后端 orchestrator 抛出 AbortError → SSE 发送 RUN_ERROR → 连接关闭。
   * 这样后端 finally 块才能正确清理 chapterCreationLocks，避免 409 错误。
   */
  const runFlowPromiseRef = useRef<Promise<void> | null>(null)
  const projectIdRef = useRef<string | null>(null)
  /** 当前章节号（供 sendMessage 持久化聊天记录用） */
  const chapterNumberRef = useRef<number | null>(null)
  /** 当前创作模式（供持久化用户发言时区分工作流/群聊） */
  const flowModeRef = useRef<'workflow' | 'discussion'>('workflow')
  /** 当前 SSE RUN_STARTED 的运行 ID，插话必须带它做运行级隔离。 */
  const activeFlowIdRef = useRef<string | null>(null)
  /** Persisted tail sequence fingerprints; exact replay is ignored on reconnect. */
  const tailEventFingerprintsRef = useRef<Map<number, string>>(new Map())
  /** 最近一次业务事件的阶段；标准 TEXT_MESSAGE_* 事件本身不带角色元数据时用于兜底。 */
  const activePhaseRef = useRef<string | undefined>(undefined)
  /** 保证实时气泡按到达顺序排列，即使后端事件时间戳相同或回退。 */
  const timelineTimestampRef = useRef(0)
  /**
   * 最近一次 AI 编排产出的角色功能位。
   *
   * characterFunctions 不落库（只存在于 generateAndArrange 的返回值里），
   * 而 create-flow 的 arrangedEntities 是前端从矩阵实体字段反推的，无法还原功能位。
   * 这里按章节缓存一次，编排后紧接着触发创作时把它带上，避免"本章作用"永远丢失。
   */
  const lastArrangeFunctionsRef = useRef<{
    chapterNumber: number | null
    entries: Array<{ characterId: string; function: string; note?: string }>
  } | null>(null)
  /** messageId → { agentType, agentName } 映射：agent_start 时记录，TEXT_MESSAGE_* 时查询 */
  const messageAgentMapRef = useRef<
    Map<string, { agentType: AgentOutput['agentType']; agentName: string }>
  >(new Map())
  /** 最近一次 agent_start 的有效消息 ID，供缺失 messageId 的后续流事件关联。 */
  const latestAgentStartMessageIdRef = useRef<string | null>(null)
  /** 没有 agent_start 时，给同一条缺失 ID 的流分配稳定的内部键。 */
  const unmappedStreamMessageIdRef = useRef<string | null>(null)
  const unmappedStreamSequenceRef = useRef(0)
  /** 已收到正文 delta 的消息；首个 delta 会替换 agent_start 的占位文案。 */
  const messagesWithTextRef = useRef<Set<string>>(new Set())
  /**
   * 思考流缓冲：按 messageId 累积 THINKING_TEXT_MESSAGE_CONTENT delta。
   *
   * 与 deltaBufferRef 分开存放：思考文本绝不进入 writerContentRef（章节正文），
   * 只在正文 delta 尚未到达时充作气泡的临时展示内容（正文开始后即被取代）。
   */
  const thinkingBufferRef = useRef<Map<string, string>>(new Map())
  /** writer/reviser 累积文本（delta 累积，避免每次 setState 丢失增量） */
  const writerContentRef = useRef('')
  /**
   * delta 批处理缓冲：按 messageId 累积待 flush 的 delta 文本。
   *
   * StreamEmitter 每个 text_delta 都发一个 TEXT_MESSAGE_CONTENT，高频调用 setState
   * 会导致 chapter-live-view 频繁 re-render。用 rAF 批量 flush，一帧内的多个 delta
   * 合并成一次 setState，渲染频率从 O(delta数) 降到 O(fps)。
   */
  const deltaBufferRef = useRef<Map<string, string>>(new Map())
  const rafIdRef = useRef<number | null>(null)
  /**
   * rAF 的兜底定时器。
   *
   * ⚠️ 不能只依赖 rAF：窗口最小化、被其他窗口完全遮挡、或切到后台时，
   * Chromium 会把 requestAnimationFrame 节流到极低频率甚至完全暂停。
   * 那种情况下 delta 会一直积在缓冲里不 flush，正文直到流程结束、
   * `novel:result` 带回全量内容时才一次性出现 —— 表现就是"流式失效、
   * LLM 变成同步的"。
   *
   * 因此 rAF 与定时器同时挂：谁先到谁 flush，另一个被取消。
   * 定时器间隔取 100ms：远低于人对"不流畅"的感知阈值，
   * 又不会退化成每个 delta 一次 setState。
   */
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const nextTimelineTimestamp = useCallback((candidate?: number): number => {
    const base = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : Date.now()
    const next = Math.max(base, timelineTimestampRef.current + 1)
    timelineTimestampRef.current = next
    return next
  }, [])

  /**
   * 解析 AG-UI 文本流的消息 ID。
   *
   * 详情气泡没有 messageId；因此绝不能把 undefined/空串直接用于气泡匹配，
   * 否则 findIndex 会命中第一条详情。服务端遗漏 ID 时优先回退到最近的 agent_start。
   */
  const resolveStreamMessageId = useCallback((rawMessageId: unknown): string => {
    if (typeof rawMessageId === 'string' && rawMessageId.trim()) {
      return rawMessageId.trim()
    }
    if (latestAgentStartMessageIdRef.current) {
      return latestAgentStartMessageIdRef.current
    }
    if (!unmappedStreamMessageIdRef.current) {
      unmappedStreamSequenceRef.current += 1
      unmappedStreamMessageIdRef.current = `unmapped-stream:${unmappedStreamSequenceRef.current}`
    }
    return unmappedStreamMessageIdRef.current
  }, [])

  /** 在一条流结束后，移除仅用于无 ID 事件的关联上下文。 */
  const completeStreamMessageId = useCallback((messageId: string): void => {
    if (latestAgentStartMessageIdRef.current === messageId) {
      latestAgentStartMessageIdRef.current = null
    }
    if (unmappedStreamMessageIdRef.current === messageId) {
      unmappedStreamMessageIdRef.current = null
    }
  }, [])

  /** 取消所有待执行的 flush 调度 */
  const cancelDeltaFlush = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [])

  /**
   * 调度 flush：合并 deltaBuffer 到 agentOutputs / chapterContent。
   *
   * rAF 与 100ms 定时器同时挂，谁先到谁执行 —— 见 flushTimerRef 的注释：
   * 窗口不可见时 rAF 可能被完全暂停，只靠它会让流式输出看起来"卡死"。
   */
  const scheduleDeltaFlush = useCallback(() => {
    // 已有调度：等它执行即可，避免重复排队
    if (rafIdRef.current !== null || flushTimerRef.current !== null) return

    const flush = (): void => {
      // 两条路径谁先到都要清掉另一条，否则同一批 delta 会被 flush 两次
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }

      const buffer = deltaBufferRef.current
      if (buffer.size === 0 && thinkingBufferRef.current.size === 0) return
      const entries = Array.from(buffer.entries())
      buffer.clear()

      // 思考 delta：只进气泡的 thinking 字段，绝不进章节正文（writerContentRef）
      const thinkingEntries = Array.from(thinkingBufferRef.current.entries())
      thinkingBufferRef.current.clear()

      // Reviser 的流式文本通常只是"已应用 N 处修订"；真正的修订正文由
      // apply_revision 工具生成，并在最终 result 中返回。不能让它覆盖 Writer 草稿。
      let writerDelta = ''
      for (const [messageId, delta] of entries) {
        const meta = messageAgentMapRef.current.get(messageId)
        if (meta && streamsChapterContent(meta.agentType)) {
          writerDelta += delta
        }
      }
      if (writerDelta) {
        writerContentRef.current += writerDelta
        setChapterContent(writerContentRef.current)
      }

      // 合并各 messageId 的 delta 到对应 AgentOutput
      setAgentOutputs((prev) => {
        let updated = prev
        for (const [messageId, delta] of entries) {
          const idx = updated.findIndex((o) => o.messageId === messageId)
          if (idx === -1) continue
          if (updated === prev) updated = [...prev] // 懒复制
          const newContent = updated[idx].content + delta
          updated[idx] = {
            ...updated[idx],
            content: newContent,
            preview: newContent.slice(-200)
          }
        }
        // 思考 delta 合并到 thinking 字段（2026-08-24：正文开始后仍继续累积，
        // 思考过程改为气泡内可展开区块展示，不再被正文取代后丢弃）
        for (const [messageId, delta] of thinkingEntries) {
          const idx = updated.findIndex((o) => o.messageId === messageId)
          if (idx === -1) continue
          if (updated === prev) updated = [...prev]
          updated[idx] = {
            ...updated[idx],
            thinking: (updated[idx].thinking ?? '') + delta
          }
        }
        return updated
      })
    }

    rafIdRef.current = requestAnimationFrame(flush)
    flushTimerRef.current = setTimeout(flush, 100)
  }, [])

  /**
   * 处理单条 ag-ui 事件，更新状态。
   *
   * 与 chat 共用同一套 ag-ui 协议：
   * - TEXT_MESSAGE_START/CONTENT/END → LLM 流式文本（增量 delta，按 messageId 累积）
   * - THINKING_TEXT_MESSAGE_CONTENT → 推理模型思考流（正文到达前展示，正文开始即取代）
   * - CUSTOM(novel:progress) → 阶段变更 / agent_start / data_changed / 心跳
   * - CUSTOM(novel:checkpoint) → CheckpointData，等待用户决策
   * - CUSTOM(novel:result) → CreationResult，流程结束
   * - RUN_FINISHED → 流结束（result 已处理则 no-op，否则作兜底关闭 isRunning）
   * - RUN_ERROR → 错误
   *
   * LLM token 流走标准 TEXT_MESSAGE_* 事件（与 chat 一致），
   * 不再用 CUSTOM(novel:progress) 的 agent_output.content 全量推送。
   */
  const handleEvent = useCallback((event: BaseEvent): void => {
    // 已取消：跳过所有后续事件处理，避免 setState 覆盖 reset() 的 idle
    if (abortControllerRef.current?.signal.aborted) return

    if (event.type === 'RUN_STARTED') {
      activeFlowIdRef.current = (event as { runId?: string }).runId ?? null
      return
    }

    // ── 标准 AG-UI 事件：LLM 流式文本（与 chat 共用同一协议） ──
    // TEXT_MESSAGE_START：StreamEmitter 开始发射某 messageId 的文本。
    // 不在这里清空 agent_start 文案：工具型 Agent 可能只有 START/END，没有文本 delta。
    if (event.type === 'TEXT_MESSAGE_START') {
      const { messageId: rawMessageId, agentType: eventAgentType, agentName: eventAgentName } = event as {
        type: 'TEXT_MESSAGE_START'
        messageId?: unknown
        agentType?: AgentOutput['agentType']
        agentName?: string
      }
      const messageId = resolveStreamMessageId(rawMessageId)
      // 首 token 已到达，等待类心跳文案已失效，回退显示当前阶段名称。
      setProgressMessage(null)
      const meta = messageAgentMapRef.current.get(messageId)
        ?? (eventAgentType
          ? { agentType: eventAgentType, agentName: eventAgentName ?? eventAgentType }
          : inferStreamAgentMeta(activePhaseRef.current))
      if (meta) {
        messageAgentMapRef.current.set(messageId, meta)
        setAgentOutputs((prev) => {
          const idx = prev.findIndex((o) => o.messageId === messageId)
          if (idx >= 0) {
            const updated = [...prev]
            updated[idx] = { ...updated[idx], streaming: true }
            return updated
          }
          // 无初始气泡 → 新建 streaming 气泡
          return [
            ...prev,
            {
              agentType: meta.agentType,
              agentName: meta.agentName,
              content: '',
              preview: '',
              timestamp: nextTimelineTimestamp(),
              streaming: true,
              messageId
            }
          ]
        })
      }
      return
    }

    // TEXT_MESSAGE_CONTENT：累积到缓冲，rAF 批量 flush（避免高频 setState）
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      const { messageId: rawMessageId, delta } = event as {
        type: 'TEXT_MESSAGE_CONTENT'
        messageId?: unknown
        delta: string
      }
      const messageId = resolveStreamMessageId(rawMessageId)
      const meta = messageAgentMapRef.current.get(messageId) ?? inferStreamAgentMeta(activePhaseRef.current)
      if (meta) messageAgentMapRef.current.set(messageId, meta)
      if (!meta) return
      if (!messagesWithTextRef.current.has(messageId)) {
        messagesWithTextRef.current.add(messageId)
        setAgentOutputs((prev) => {
          const idx = prev.findIndex((o) => o.messageId === messageId)
          if (idx === -1) {
            return [
              ...prev,
              {
                agentType: meta.agentType,
                agentName: meta.agentName,
                content: '',
                preview: '',
                timestamp: nextTimelineTimestamp(),
                streaming: true,
                messageId
              }
            ]
          }
          const updated = [...prev]
          // 首个正文 delta：清空占位文案，标记此后展示正文；思考文本保留（气泡内可展开）
          updated[idx] = {
            ...updated[idx],
            content: '',
            preview: '',
            hasStreamedText: true
          }
          return updated
        })
      }
      const existing = deltaBufferRef.current.get(messageId) ?? ''
      deltaBufferRef.current.set(messageId, existing + delta)
      scheduleDeltaFlush()
      return
    }

    // THINKING_TEXT_MESSAGE_CONTENT：思考流式 delta（推理模型）。
    // 不展示的话，长思考期间气泡停留在"已启动"占位文案，SSE 明明有数据会话却无输出。
    // REASONING_MESSAGE_CONTENT 与之成对发射（内容相同），跳过避免重复。
    if (
      event.type === 'THINKING_TEXT_MESSAGE_CONTENT' ||
      event.type === 'REASONING_MESSAGE_CONTENT'
    ) {
      if (event.type === 'REASONING_MESSAGE_CONTENT') return
      const { messageId: rawMessageId, delta } = event as {
        type: 'THINKING_TEXT_MESSAGE_CONTENT'
        messageId?: unknown
        delta: string
      }
      const messageId = resolveStreamMessageId(rawMessageId)
      if (!delta) return
      // 2026-08-24：正文开始后到达的思考 delta 也继续缓冲（气泡内可展开区块展示），
      // 不再直接丢弃。状态栏"思考中"提示仅在正文未开始时切换。
      const hasTextStarted = messagesWithTextRef.current.has(messageId)
      const existing = thinkingBufferRef.current.get(messageId) ?? ''
      thinkingBufferRef.current.set(messageId, existing + delta)
      if (!existing && !hasTextStarted) {
        // 首个思考 delta：状态栏从"等待 LLM 响应"切换为"思考中"（心跳已失效）。
        // 无 meta 说明是未展示的内部调用（如群聊角色审查），不动状态栏。
        const meta = messageAgentMapRef.current.get(messageId)
        if (meta) setProgressMessage(`${meta.agentName} 正在思考...`)
      }
      scheduleDeltaFlush()
      return
    }

    // TEXT_MESSAGE_END：标记该 Agent 输出完成
    if (event.type === 'TEXT_MESSAGE_END') {
      const { messageId: rawMessageId } = event as { type: 'TEXT_MESSAGE_END'; messageId?: unknown }
      const messageId = resolveStreamMessageId(rawMessageId)
      // 同步合并残留思考 delta（rAF 可能还没触发），此后该消息不再接收思考流
      const pendingThinking = thinkingBufferRef.current.get(messageId)
      thinkingBufferRef.current.delete(messageId)
      // 先同步 flush 残留 delta（rAF 可能还没触发），避免最后一段文本丢失
      const pending = deltaBufferRef.current.get(messageId)
      if (pending) {
        deltaBufferRef.current.delete(messageId)
        const meta = messageAgentMapRef.current.get(messageId)
        if (meta && streamsChapterContent(meta.agentType)) {
          writerContentRef.current += pending
          setChapterContent(writerContentRef.current)
        }
        setAgentOutputs((prev) => {
          const idx = prev.findIndex((o) => o.messageId === messageId)
          if (idx === -1) return prev
          const updated = [...prev]
          const newContent = updated[idx].content + pending
          const lateThinking = pendingThinking
            ? (updated[idx].thinking ?? '') + pendingThinking
            : updated[idx].thinking
          updated[idx] = {
            ...updated[idx],
            content: newContent,
            preview: newContent.slice(-200),
            streaming: false,
            // 2026-08-24：迟到的思考 delta 同样保留（气泡内可展开）
            thinking: lateThinking || undefined
          }
          return updated
        })
      } else {
        setAgentOutputs((prev) => {
          const idx = prev.findIndex((o) => o.messageId === messageId)
          if (idx === -1) return prev
          const updated = [...prev]
          const meta = messageAgentMapRef.current.get(messageId)
          const mergedThinking = pendingThinking
            ? (updated[idx].thinking ?? '') + pendingThinking
            : updated[idx].thinking
          const completion =
            meta?.agentType === 'reviser' && !messagesWithTextRef.current.has(messageId)
              ? '修订已完成，正文已更新。'
              : updated[idx].content
          updated[idx] = {
            ...updated[idx],
            content: completion,
            preview: completion.slice(-200),
            streaming: false,
            // 2026-08-24：思考过程一律保留（气泡内可展开），不再因有正文而丢弃
            thinking: mergedThinking
          }
          return updated
        })
      }
      completeStreamMessageId(messageId)
      return
    }

    // ── CUSTOM 事件：小说专属语义 ──
    if (event.type === 'CUSTOM') {
      const custom = event as CustomEvent
      switch (custom.name) {
        case 'novel:progress': {
          const evt = custom.value as CreationFlowEvent
          setEvents((prev) => [...prev, evt])
          setPhase(evt.phase)
          activePhaseRef.current = evt.phase
          const data = evt.data as {
            type?: string
            agentType?: string
            agentName?: string
            messageId?: string
            message?: string
            content?: string
            actorTurn?: AgentOutput['actorTurn']
            dataChanged?: boolean
            data?: unknown
            detail?: Record<string, unknown>
            scene?: {
              sceneId: number
              title: string
              location: string
              time: string
              conflict?: string
              goal: string
            }
          }
          const isPhaseProgress = evt.type === 'phase_change' || data?.type === 'phase_change'
          if (isPhaseProgress && data?.message) {
            // 心跳/阶段进度只覆盖状态栏中的同一条文案，不追加聊天气泡。
            setProgressMessage(data.message)
          }
          // detail 事件：节奏建议/叙事任务/章节约束/记忆结果
          // → 格式化为 info 气泡（arrange_* 详情由下方专门分支处理，需要 dataChanged / streaming 语义）
          if (data?.detail && typeof data.detail === 'object' && data.detail.kind) {
            const detailKind = data.detail.kind as string
            if (!detailKind.startsWith('arrange_')) {
              const formatted = formatDetailBubble(data.detail)
              setAgentOutputs((prev) => [
                ...prev,
                {
                  agentType: formatted.agentType,
                  agentName: formatted.agentName,
                  content: formatted.content,
                  preview: data.message ?? formatted.content.slice(0, 100),
                  timestamp: nextTimelineTimestamp(evt.timestamp),
                  // memory_result 携带 dataChanged 标记，触发画布刷新
                  dataChanged: data.dataChanged === true
                }
              ])
              return
            }
          }
          // 纯 phase_change 是瞬时运行状态；保留在 events 供调试，但不进入 Agent 对话时间线。
          if (isPhaseProgress) return
          // agent_start：记录 messageId → agentType 映射，重置 writer 累积器
          // 同时创建一个初始 streaming AgentOutput，展示"已启动"提示，
          // 让用户在首 token 到达前就能看到 Agent 已启动（避免 approve 后空白等待）
          const agentMessageId = typeof data?.messageId === 'string' ? data.messageId.trim() : ''
          if (data?.type === 'agent_start' && agentMessageId && data.agentType && data.agentName) {
            latestAgentStartMessageIdRef.current = agentMessageId
            unmappedStreamMessageIdRef.current = null
            messageAgentMapRef.current.set(agentMessageId, {
              agentType: data.agentType as AgentOutput['agentType'],
              agentName: data.agentName
            })
            if (streamsChapterContent(data.agentType as AgentOutput['agentType'])) {
              writerContentRef.current = ''
              setChapterContent('')
            }
            // 创建初始 streaming 气泡：TEXT_MESSAGE_START 会清空 content 准备接收流式 delta
            const initialMsg = data.message ?? `${data.agentName} 已启动...`
            setAgentOutputs((prev) => {
              if (prev.some((o) => o.messageId === agentMessageId)) return prev
              return [
                ...prev,
                {
                  agentType: data.agentType as AgentOutput['agentType'],
                  agentName: data.agentName!,
                  content: initialMsg,
                  preview: initialMsg,
                  timestamp: nextTimelineTimestamp(evt.timestamp),
                  streaming: true,
                  messageId: agentMessageId
                }
              ]
            })
            return
          }
          // data_changed：Memory Agent 数据变更通知
          // 更新最后一个 memory streaming 气泡为完成态（携带摘要），同时触发画布刷新
          if (data?.type === 'data_changed' && data.dataChanged) {
            const detail = data.detail
            const summary = (detail as { summary?: string } | undefined)?.summary
            setAgentOutputs((prev) => {
              const last = prev[prev.length - 1]
              if (last && last.agentType === 'memory' && last.streaming) {
                // 关闭 streaming 气泡，附加提取摘要
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    content: summary
                      ? `${last.content}\n\n---\n\n**提取摘要**：${summary}`
                      : (data.message ?? last.content),
                    preview: summary ?? data.message ?? last.preview,
                    streaming: false,
                    dataChanged: true
                  }
                ]
              }
              // 无前置 streaming 气泡 → 直接创建完成态气泡
              return [
                ...prev,
                {
                  agentType: (data.agentType ?? 'memory') as AgentOutput['agentType'],
                  agentName: data.agentName ?? '记忆',
                  content: summary ?? data.message ?? '数据已更新',
                  preview: summary ?? data.message ?? '数据已更新',
                  timestamp: nextTimelineTimestamp(evt.timestamp),
                  dataChanged: true
                }
              ]
            })
            return
          }
          // memory 阶段的 phase_change：创建/更新 streaming 记忆气泡
          // memory-generator 发射 6 个子阶段（preparing/generating/parsing/applying/completed/fallback），
          // 每个带中文 message，让用户实时看到记忆提取进度
          if (evt.phase === 'memory' && data?.message) {
            setAgentOutputs((prev) => {
              const last = prev[prev.length - 1]
              if (last && last.agentType === 'memory' && last.streaming) {
                // 更新现有 memory 气泡的 message
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: data.message!, preview: data.message! }
                ]
              }
              return [
                ...prev,
                {
                  agentType: 'memory',
                  agentName: '记忆',
                  content: data.message!,
                  preview: data.message!,
                  timestamp: nextTimelineTimestamp(evt.timestamp),
                  streaming: true
                }
              ]
            })
            return
          }
          // arrange_*：AI 编排阶段的处理步骤，作为对话气泡展示在时间线
          // 后端 ai-arrange 仅做矩阵编排（不衔接 create-flow），故编排步骤需在此显式呈现给用户
          //
          // ⚠️ 关键：arrange_* 的 type 在 evt.type（外层 CreationFlowEvent.type），
          //    而非 data.type（data = evt.data）。detail 可能在 evt.detail（top-level）
          //    或 data.detail（nested in evt.data），两种结构都需兼容。
          const pushArrangerBubble = (
            content: string,
            preview: string,
            timestamp: number,
            agentName: string,
            dataChanged: boolean
          ): void => {
            setAgentOutputs((prev) => {
              const last = prev[prev.length - 1]
              if (last && last.agentType === 'arranger' && last.streaming) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, streaming: false },
                  {
                    agentType: 'arranger',
                    agentName,
                    content,
                    preview,
                    timestamp,
                    dataChanged
                  }
                ]
              }
              return [
                ...prev,
                {
                  agentType: 'arranger',
                  agentName,
                  content,
                  preview,
                  timestamp,
                  dataChanged
                }
              ]
            })
          }
          const evtType = (evt as { type?: string }).type
          if (typeof evtType === 'string' && evtType.startsWith('arrange_')) {
            const evtMsg = (evt as { message?: string }).message ?? data?.message ?? ''
            const evtDetail = (evt as { detail?: Record<string, unknown> }).detail
            const detail = evtDetail ?? data?.detail
            const detailKind = detail?.kind as string | undefined
            const partial =
              (data as { partial?: string } | undefined)?.partial ??
              (evtDetail as { partial?: string } | undefined)?.partial

            // arrange_done + arrange_summary：编排草稿完成，但仍在等待用户确认。
            // → 只渲染汇总气泡，不刷新画布；确认提交由 arrange_committed 触发。
            if (evtType === 'arrange_done' && detail && detailKind === 'arrange_summary') {
              // characterFunctions（本章功能位）不落库，只在本次编排的返回值里存在。
              // 缓存下来，随后触发 create-flow 时一并回传，否则 Writer 永远拿不到
              // "这个角色本章负责推动什么"，多角色同场就会退化成点名式叙述。
              // 后端 emitter.progress({ type:'arrange_done', data: arrangedEntities })
              // → 前端 data = evt.data 即 progress 载荷，编排结果在 data.data
              const payload =
                (data as { data?: unknown } | undefined)?.data ??
                (evtDetail as { data?: unknown } | undefined)?.data
              if (payload && typeof payload === 'object') {
                const arranged = payload as ArrangedEntitiesPayload
                if (arranged.characterFunctions?.length) {
                  lastArrangeFunctionsRef.current = {
                    chapterNumber: chapterNumberRef.current,
                    entries: arranged.characterFunctions
                  }
                }
              }
              const formatted = formatDetailBubble(detail)
              const content = formatted.content
              pushArrangerBubble(content, content.slice(0, 100), evt.timestamp, '编排', false)
              return
            }

            if (evtType === 'arrange_committed') {
              pushArrangerBubble(
                evtMsg || 'AI 编排已确认落库，矩阵已更新。',
                evtMsg || 'AI 编排已确认落库，矩阵已更新。',
                evt.timestamp,
                '编排',
                true,
              )
              return
            }

            // arrange_result：完整生成结果清单 → 独立气泡
            if (detail && detailKind === 'arrange_result') {
              const formatted = formatDetailBubble(detail)
              const content = formatted.content
              pushArrangerBubble(content, content.slice(0, 100), evt.timestamp, '编排', false)
              return
            }

            // arrange_plan：规划清单 → 独立气泡
            if (detail && detailKind === 'arrange_plan') {
              const formatted = formatDetailBubble(detail)
              const content = formatted.content
              pushArrangerBubble(content, content.slice(0, 100), evt.timestamp, '规划', false)
              return
            }

            // 有 partial → 流式生成中的增量更新（entity-generator 的 delta 回调）
            // → 更新最后一个 arranger streaming 气泡，避免每 token 新建气泡
            if (partial) {
              const streamContent = `${evtMsg}\n\n\`\`\`\n${partial}\n\`\`\``
              setAgentOutputs((prev) => {
                const last = prev[prev.length - 1]
                if (last && last.agentType === 'arranger' && last.streaming) {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: streamContent, preview: partial }
                  ]
                }
                return [
                  ...prev,
                  {
                    agentType: 'arranger',
                    agentName: '编排',
                    content: streamContent,
                    preview: partial,
                    timestamp: nextTimelineTimestamp(evt.timestamp),
                    streaming: true
                  }
                ]
              })
              return
            }

            // arrange_start / arrange_progress（无 partial/无 detail）：
            // 进度心跳 → 更新最后一个 arranger streaming 气泡（避免每条进度新建气泡）
            if (evtMsg) {
              setAgentOutputs((prev) => {
                const last = prev[prev.length - 1]
                if (last && last.agentType === 'arranger' && last.streaming) {
                  return [...prev.slice(0, -1), { ...last, content: evtMsg, preview: evtMsg }]
                }
                return [
                  ...prev,
                  {
                    agentType: 'arranger',
                    agentName: '编排',
                    content: evtMsg,
                    preview: evtMsg,
                    timestamp: nextTimelineTimestamp(evt.timestamp),
                    streaming: true
                  }
                ]
              })
            }
            return
          }
          // 群聊主持人点名（2026-08-24）：以完整气泡实时呈现，不再只更新状态栏一行文案
          if (data?.type === 'agent_output' && data.agentType === 'moderator' && typeof data.content === 'string') {
            const content = data.content
            setAgentOutputs((prev) => upsertAgentOutput(prev, {
              agentType: 'moderator',
              agentName: data.agentName ?? '主持人',
              content,
              timestamp: nextTimelineTimestamp(evt.timestamp),
              mergeConsecutive: true,
            }))
            return
          }
          // 群聊 Director 的工具提交：工具调用后的终答可能为空，完整场景计划
          // 由后端通过 agent_output 事件发送。覆盖该 Director 的启动占位气泡，
          // 让用户看到工具参数中的完整内容，而不是只看到“已启动”或空正文。
          if (data?.type === 'agent_output' && data.agentType === 'director' && typeof data.content === 'string') {
            const content = data.content
            setAgentOutputs((prev) => upsertAgentOutput(prev, {
              agentType: 'director',
              agentName: data.agentName ?? '导演',
              content,
              timestamp: nextTimelineTimestamp(evt.timestamp),
              previewLength: 200,
              overwritePlaceholder: true,
            }))
            return
          }
          // 角色结构化工具回合：publicText 作为正文气泡，私有判断放进同一气泡的
          // actorTurn 字段，由 ConversationMessage 的可展开区渲染；不混入章节正文。
          //
          // 与 Director 同一问题：角色走工具主路径时终答可能是空 stop，既没有
          // TEXT_MESSAGE_* 也就没人关闭 agent_start 的「已启动」占位气泡。
          // 必须覆盖该占位，否则每个角色回合都会留下一条永久 streaming 的空气泡，
          // 再加一条真实气泡（重复且看似卡死）。
          if (data?.type === 'agent_output' && data.agentType === 'character' && typeof data.content === 'string') {
            const content = data.content
            setAgentOutputs((prev) => upsertAgentOutput(prev, {
              agentType: 'character',
              agentName: data.agentName ?? '角色',
              content,
              timestamp: nextTimelineTimestamp(evt.timestamp),
              actorTurn: data.actorTurn,
              previewLength: 200,
              overwritePlaceholder: true,
            }))
            return
          }
          // 群聊过程事件：scene_change（场景切换）→ 创建 director 系统气泡
          // 让用户看到群聊的场景拆分和切换过程
          if (data?.type === 'scene_change' && data.scene) {
            const scene = data.scene
            const content = `## 场景${scene.sceneId}：${scene.title}\n- 地点：${scene.location}\n- 时间：${scene.time}\n- 冲突：${scene.conflict ?? '无'}\n- 目标：${scene.goal}`
            setAgentOutputs((prev) => [
              ...prev,
              {
                agentType: 'director',
                agentName: '场景',
                content,
                preview: `场景${scene.sceneId}：${scene.title}`,
                timestamp: nextTimelineTimestamp(evt.timestamp)
              }
            ])
            return
          }
          // phase_change / 心跳：只更新 events 和 phase，不覆盖 chapterContent
          return
        }
        case 'novel:checkpoint': {
          const checkpoint = custom.value as CheckpointData
          const checkpointWithTimestamp = {
            ...checkpoint,
            createdAt: checkpoint.createdAt ?? Date.now()
          }
          setProgressMessage(null)
          setCurrentCheckpoint(checkpointWithTimestamp)
          setPhase(checkpointWithTimestamp.phase)
          return
        }
        case 'novel:result': {
          const resultData = custom.value as CreationResult
          setResult(resultData)
          setProgressMessage(null)
          // 先取消可能挂起的 flush（rAF + 定时器），再清空缓冲（result.content 是权威全量）
          cancelDeltaFlush()
          deltaBufferRef.current.clear()
          thinkingBufferRef.current.clear()
          latestAgentStartMessageIdRef.current = null
          unmappedStreamMessageIdRef.current = null
          unmappedStreamSequenceRef.current = 0
          // result 里的 content 是最终完整内容，覆盖累积值
          if (resultData.content) {
            setChapterContent(resultData.content)
            writerContentRef.current = resultData.content
          }
          setPhase(
            resultData.status === 'completed'
              ? 'completed'
              : resultData.status === 'cancelled'
                ? 'cancelled'
                : 'error'
          )
          setIsRunning(false)
          setCurrentCheckpoint(null)
          // AI 编排被拒绝/取消时，缓存的 characterFunctions 指向已被后端撤销的实体，
          // 必须清掉，否则随后的 create-flow 会带着失效 ID 触发 400 编排实体校验。
          if (resultData.status !== 'completed') {
            lastArrangeFunctionsRef.current = null
          }
          if (resultData.error) {
            setError(resultData.error)
          }
          return
        }
        case 'novel:user-message': {
          // 插话状态回显（§3.1/§4）：queued（受理）→ injected（被 Agent 消费）
          // / dropped（flow 终态未注入）。按 messageId 对齐同一条插话的状态流转。
          const userMessageEvent = custom.value as NovelUserMessageEvent
          setInterjectMessages((prev) => applyUserMessageEvent(prev, userMessageEvent))
          return
        }
        default:
          return
      }
    }

    if (event.type === 'RUN_ERROR') {
      const errEvent = event as { type: 'RUN_ERROR'; message: string }
      setError(errEvent.message)
      setProgressMessage(null)
      setPhase('error')
      setIsRunning(false)
      setCurrentCheckpoint(null)
      latestAgentStartMessageIdRef.current = null
      unmappedStreamMessageIdRef.current = null
      unmappedStreamSequenceRef.current = 0
      return
    }

    if (event.type === 'RUN_FINISHED') {
      setIsRunning(false)
      setProgressMessage(null)
      setCurrentCheckpoint(null)
      latestAgentStartMessageIdRef.current = null
      unmappedStreamMessageIdRef.current = null
      unmappedStreamSequenceRef.current = 0
    }

    // RUN_STARTED / TOOL_CALL_* / STEP_* / ACTIVITY_* / 其他事件：暂不展示
    // （Memory Agent 的工具调用事件已在后端发射，前端未来可扩展展示）
  }, [cancelDeltaFlush, completeStreamMessageId, nextTimelineTimestamp, resolveStreamMessageId, scheduleDeltaFlush])

  /**
   * 内部通用 SSE 流执行器（startCreation 与 aiArrange 共用）。
   *
   * 负责 fetch + parseSseStream + 错误处理；状态重置由调用方在调用前完成。
   * 不持有 abortControllerRef——由调用方在 try/finally 中清理。
   *
   * 使用与 chat 相同的 parseSseStream 解析 SSE 流。
   */
  const runFlow = useCallback(
    async (url: string, body: unknown, controller: AbortController): Promise<void> => {
      activeFlowIdRef.current = null
      latestAgentStartMessageIdRef.current = null
      unmappedStreamMessageIdRef.current = null
      unmappedStreamSequenceRef.current = 0
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })

        if (!response.ok) {
          let serverMessage = ''
          try {
            const payload = (await response.json()) as {
              error?: string | { message?: string }
              message?: string
            }
            serverMessage =
              typeof payload.error === 'string'
                ? payload.error
                : (payload.error?.message ?? payload.message ?? '')
          } catch {
            // 非 JSON 错误响应保留 HTTP 状态作为兜底。
          }
          throw new Error(
            serverMessage
              ? `创作流程启动失败：${serverMessage}`
              : `创作流程启动失败: HTTP ${response.status} ${response.statusText}`
          )
        }

        if (!response.body) {
          throw new Error('响应体为空，无法读取 SSE 流')
        }

        // 复用 chat 的 parseSseStream：统一 SSE 解析逻辑
        await parseSseStream(response.body, handleEvent)
      } catch (err) {
        // 用户主动取消（abort）：cancel()/reset() 已同步处理状态，不覆盖 phase
        if (controller.signal.aborted) {
          setIsRunning(false)
          setCurrentCheckpoint(null)
          latestAgentStartMessageIdRef.current = null
          unmappedStreamMessageIdRef.current = null
          unmappedStreamSequenceRef.current = 0
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setProgressMessage(null)
        setPhase('error')
        setIsRunning(false)
        setCurrentCheckpoint(null)
        latestAgentStartMessageIdRef.current = null
        unmappedStreamMessageIdRef.current = null
        unmappedStreamSequenceRef.current = 0
      }
    },
    [handleEvent]
  )

  /**
   * 后台 run 的事件 tail 消费器（create-discussion / create-flow 共用）。
   *
   * 后台化的 run 不再随 HTTP 请求结束，进度与结果都在事件流里：
   * - agui：后台 emit 通道的完整镜像（TEXT_MESSAGE_* 流式正文、novel:progress、
   *   novel:checkpoint、novel:user-message、RUN_*），payload 即原 AG-UI 事件，
   *   直接喂 handleEvent——流式体验与旧 SSE 一致；
   * - run_finished → novel:result（携带最终正文、diagnostics 与 canResume）+
   *   RUN_FINISHED（与旧 emitter.result 的收尾序列一致）。
   * 关闭面板只会断开 tail，run 在后台继续（断线不 abort）。
   */
  const consumeTail = useCallback(
    async (eventsPath: string, controller: AbortController): Promise<void> => {
      const tailUrl = `${browserConfig.apiBaseUrl}/api/plugins/novel${eventsPath}`
      const tailResponse = await fetch(tailUrl, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal
      })
      if (!tailResponse.ok || !tailResponse.body) {
        throw new Error(`创作事件流连接失败: HTTP ${tailResponse.status}`)
      }
      await parseSseStream(tailResponse.body, (event) => {
        const tail = event as unknown as { type?: string; seq?: number; payload?: Record<string, unknown> }
        if (Number.isInteger(tail.seq) && tail.seq! > 0) {
          const fingerprint = JSON.stringify([tail.type, tail.payload])
          const previous = tailEventFingerprintsRef.current.get(tail.seq!)
          if (previous === fingerprint) return
          tailEventFingerprintsRef.current.set(tail.seq!, fingerprint)
        }
        switch (tail.type) {
          case 'agui':
            if (tail.payload) handleEvent(tail.payload as BaseEvent)
            return
          case 'run_finished':
            handleEvent({
              type: 'CUSTOM',
              name: 'novel:result',
              value: { timestamp: Date.now(), ...(tail.payload ?? {}) }
            } as BaseEvent)
            handleEvent({ type: 'RUN_FINISHED' } as BaseEvent)
            return
          default:
            // run_started / 其他调度事实：UI 由 agui 镜像承载
            return
        }
      })
    },
    [handleEvent]
  )

  /**
   * 后台创作 run 的受理 + tail 消费（T8：create-flow 已脱离 HTTP 生命周期）。
   *
   * POST 只受理并返回 `202 + runId + eventsPath`，执行在服务端后台继续：
   * 刷新页面 / 切路由 / 重开面板都只是断开 tail，不会再取消整章创作。
   * 收到 409（本章已有在跑的 run）时取回 runId 转入 tail 观看，而不是报错阻断。
   */
  const runBackgroundFlow = useCallback(
    async (
      url: string,
      body: unknown,
      controller: AbortController,
      options: { activeRunPath: string; failureLabel: string }
    ): Promise<void> => {
      tailEventFingerprintsRef.current.clear()
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (response.status === 409) {
        const activeResponse = await fetch(
          `${browserConfig.apiBaseUrl}/api/plugins/novel${options.activeRunPath}`,
          { signal: controller.signal }
        )
        if (activeResponse.ok) {
          const active = (await activeResponse.json()) as { runId?: string; eventsPath?: string }
          if (active.runId && active.eventsPath) {
            activeFlowIdRef.current = active.runId
            handleEvent({ type: 'RUN_STARTED', threadId: '', runId: active.runId } as BaseEvent)
            // 重开面板没有历史气泡状态：from=0 全量重放重建时间线（幂等，不重复气泡）
            await consumeTail(active.eventsPath, controller)
            return
          }
        }
      }

      if (!response.ok) {
        let serverMessage = ''
        try {
          const payload = (await response.json()) as {
            error?: string | { message?: string }
            message?: string
          }
          serverMessage =
            typeof payload.error === 'string'
              ? payload.error
              : (payload.error?.message ?? payload.message ?? '')
        } catch {
          // 非 JSON 错误响应保留 HTTP 状态作为兜底。
        }
        throw new Error(
          serverMessage
            ? `${options.failureLabel}：${serverMessage}`
            : `${options.failureLabel}: HTTP ${response.status} ${response.statusText}`
        )
      }

      const accepted = (await response.json()) as { runId?: string; eventsPath?: string }
      if (!accepted.runId || !accepted.eventsPath) {
        throw new Error('创作受理响应缺少 runId/eventsPath')
      }
      // 等价于旧 SSE 的 RUN_STARTED：登记 runId，插话端点据此做运行级隔离
      activeFlowIdRef.current = accepted.runId
      handleEvent({ type: 'RUN_STARTED', threadId: '', runId: accepted.runId } as BaseEvent)
      await consumeTail(accepted.eventsPath, controller)
    },
    [consumeTail, handleEvent]
  )

  const startCreation = useCallback(
    async (
      projectId: string,
      chapterNumber: number,
      options?: {
        arrangedEntities?: ArrangedEntitiesPayload
        modelId?: { provider: string; modelId: string; thinkingLevel?: import('./../stores/session-store').ThinkingLevel | null }
        styleExpertIds?: string[]
      }
    ): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      // 重置状态
      setPhase('idle')
      activePhaseRef.current = undefined
      setProgressMessage(null)
      setEvents([])
      setCurrentCheckpoint(null)
      setCheckpointHistory([])
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      setInterjectMessages([])
      messageAgentMapRef.current.clear()
      messagesWithTextRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      thinkingBufferRef.current.clear()
      cancelDeltaFlush()
      setIsRunning(true)
      projectIdRef.current = projectId
      chapterNumberRef.current = chapterNumber
      flowModeRef.current = 'workflow'

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/create-flow`
      const body = {
        ...(options?.arrangedEntities ? { arrangedEntities: options.arrangedEntities } : {}),
        ...(options?.modelId ? { modelId: options.modelId } : {}),
        ...(options?.styleExpertIds ? { styleExpertIds: options.styleExpertIds } : {})
      }

      // T8：后端已把 run 挪到后台（202 + eventsPath），断线不再取消整章创作。
      const runPromise = runBackgroundFlow(url, body, controller, {
        activeRunPath: `/projects/${projectId}/chapters/${chapterNumber}/active-workflow-run`,
        failureLabel: '创作流程启动失败'
      })
      runFlowPromiseRef.current = runPromise
      try {
        await runPromise
      } catch (err) {
        // 用户主动取消（abort）：cancel()/reset() 已同步处理状态，不覆盖 phase
        if (controller.signal.aborted) {
          setIsRunning(false)
          setCurrentCheckpoint(null)
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setProgressMessage(null)
        setPhase('error')
        setIsRunning(false)
        setCurrentCheckpoint(null)
      } finally {
        abortControllerRef.current = null
        runFlowPromiseRef.current = null
      }
    },
    [runBackgroundFlow]
  )

  /**
   * 启动群聊模式创作流程。
   *
   * 与 startCreation 结构完全一致，仅后端端点改为 /create-discussion。
   * ag-ui 事件格式与状态机共用同一 handleEvent / runFlow。
   */
  const startDiscussion = useCallback(
    async (
      projectId: string,
      chapterNumber: number,
      options?: {
        arrangedEntities?: ArrangedEntitiesPayload
        styleExpertIds?: string[]
      }
    ): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      // 重置状态
      setPhase('idle')
      activePhaseRef.current = undefined
      setProgressMessage(null)
      setEvents([])
      setCurrentCheckpoint(null)
      setCheckpointHistory([])
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      setInterjectMessages([])
      messageAgentMapRef.current.clear()
      messagesWithTextRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      thinkingBufferRef.current.clear()
      cancelDeltaFlush()
      setIsRunning(true)
      projectIdRef.current = projectId
      chapterNumberRef.current = chapterNumber
      flowModeRef.current = 'discussion'

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/create-discussion`
      const body = {
        ...(options?.arrangedEntities ? { arrangedEntities: options.arrangedEntities } : {}),
        ...(options?.styleExpertIds ? { styleExpertIds: options.styleExpertIds } : {})
      }


      // T7/T8：后台 run + 事件 tail，与 create-flow 共用同一消费器。
      const runPromise = runBackgroundFlow(url, body, controller, {
        activeRunPath: `/projects/${projectId}/chapters/${chapterNumber}/active-discussion-run`,
        failureLabel: '群聊创作启动失败'
      })
      runFlowPromiseRef.current = runPromise
      try {
        await runPromise
      } catch (err) {
        // 用户主动取消（abort）：cancel()/reset() 已同步处理状态，不覆盖 phase
        if (controller.signal.aborted) {
          setIsRunning(false)
          setCurrentCheckpoint(null)
          latestAgentStartMessageIdRef.current = null
          unmappedStreamMessageIdRef.current = null
          unmappedStreamSequenceRef.current = 0
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setProgressMessage(null)
        setPhase('error')
        setIsRunning(false)
        setCurrentCheckpoint(null)
        latestAgentStartMessageIdRef.current = null
        unmappedStreamMessageIdRef.current = null
        unmappedStreamSequenceRef.current = 0
      } finally {
        abortControllerRef.current = null
        runFlowPromiseRef.current = null
      }
    },
    [runBackgroundFlow]
  )

  const resumeDiscussion = useCallback(
    async (projectId: string, chapterNumber: number, runId: string): Promise<void> => {
      if (abortControllerRef.current) return

      setPhase('idle')
      activePhaseRef.current = undefined
      setProgressMessage(null)
      setEvents([])
      setCurrentCheckpoint(null)
      setCheckpointHistory([])
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      setInterjectMessages([])
      messageAgentMapRef.current.clear()
      messagesWithTextRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      thinkingBufferRef.current.clear()
      cancelDeltaFlush()
      setIsRunning(true)
      projectIdRef.current = projectId
      chapterNumberRef.current = chapterNumber
      flowModeRef.current = 'discussion'

      const controller = new AbortController()
      abortControllerRef.current = controller
      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/create-discussion/${runId}/resume`
      const runPromise = runBackgroundFlow(url, {}, controller, {
        activeRunPath: `/projects/${projectId}/chapters/${chapterNumber}/active-discussion-run`,
        failureLabel: '群聊断点续跑启动失败'
      })
      runFlowPromiseRef.current = runPromise
      try {
        await runPromise
      } catch (err) {
        if (controller.signal.aborted) {
          setIsRunning(false)
          setCurrentCheckpoint(null)
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setProgressMessage(null)
        setPhase('error')
        setIsRunning(false)
        setCurrentCheckpoint(null)
      } finally {
        abortControllerRef.current = null
        runFlowPromiseRef.current = null
      }
    },
    [runBackgroundFlow]
  )

  /**
   * 工作流断点续跑：从失败快照恢复，跳过已完成阶段
   * （Director 已批准 → 直接写作；Writer 草稿已成 → 直接审校；正文定稿 → 收尾）。
   *
   * runId 传 'latest' 时由后端取该章最近一条可续跑快照
   * （应用重启后 result 已丢失，/继续 命令走此路径）。
   * 状态重置与 resumeDiscussion 一致，flowMode 标记为 workflow。
   */
  const resumeWorkflow = useCallback(
    async (projectId: string, chapterNumber: number, runId: string): Promise<void> => {
      if (abortControllerRef.current) return

      setPhase('idle')
      activePhaseRef.current = undefined
      setProgressMessage(null)
      setEvents([])
      setCurrentCheckpoint(null)
      setCheckpointHistory([])
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      setInterjectMessages([])
      messageAgentMapRef.current.clear()
      messagesWithTextRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      thinkingBufferRef.current.clear()
      cancelDeltaFlush()
      setIsRunning(true)
      projectIdRef.current = projectId
      chapterNumberRef.current = chapterNumber
      flowModeRef.current = 'workflow'

      const controller = new AbortController()
      abortControllerRef.current = controller
      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/create-flow/${runId}/resume`
      // T8：续跑同样后台化，断线不再取消整章。
      const runPromise = runBackgroundFlow(url, {}, controller, {
        activeRunPath: `/projects/${projectId}/chapters/${chapterNumber}/active-workflow-run`,
        failureLabel: '工作流断点续跑启动失败'
      })
      runFlowPromiseRef.current = runPromise
      try {
        await runPromise
      } catch (err) {
        if (controller.signal.aborted) {
          setIsRunning(false)
          setCurrentCheckpoint(null)
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setProgressMessage(null)
        setPhase('error')
        setIsRunning(false)
        setCurrentCheckpoint(null)
      } finally {
        abortControllerRef.current = null
        runFlowPromiseRef.current = null
      }
    },
    [runBackgroundFlow]
  )

  /**
   * 启动 AI 编排流程（模式2）。
   *
   * 后端按章纲 AI 编排实体并落库，不生成正文。
   * ag-ui 事件格式与 startCreation 共用 runFlow + handleEvent 状态机。
   *
   * arrange 阶段的 CUSTOM(novel:progress) value 形状为 { type: 'arrange_*', ... }，
   * 会流入 events 时间线；正文生成需由 create-flow 单独触发。
   */
  const aiArrange = useCallback(
    async (
      projectId: string,
      chapterNumber: number,
      options?: { modelId?: { provider: string; modelId: string; thinkingLevel?: import('./../stores/session-store').ThinkingLevel | null } },
    ): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      // 重置状态（与 startCreation 一致）
      setPhase('idle')
      setProgressMessage(null)
      setEvents([])
      setCurrentCheckpoint(null)
      setCheckpointHistory([])
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      setInterjectMessages([])
      messageAgentMapRef.current.clear()
      messagesWithTextRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      thinkingBufferRef.current.clear()
      cancelDeltaFlush()
      setIsRunning(true)
      projectIdRef.current = projectId
      chapterNumberRef.current = chapterNumber

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/ai-arrange`

      const runPromise = runFlow(url, options?.modelId ? { modelId: options.modelId } : {}, controller)
      runFlowPromiseRef.current = runPromise
      try {
        await runPromise
      } finally {
        abortControllerRef.current = null
        runFlowPromiseRef.current = null
      }
    },
    [runFlow]
  )

  /**
   * 启动反推流程（模式3）。
   *
   * 后端从已写好的章节正文反推实体并落库到矩阵，不生成正文。
   * ag-ui 事件格式与 aiArrange 共用同一 runFlow + handleEvent 状态机。
   * 章节需已有正文，否则后端返回错误（经 runFlow catch 后进入 error 阶段）。
   */
  const reverseArrange = useCallback(
    async (
      projectId: string,
      chapterNumber: number,
      options?: { modelId?: { provider: string; modelId: string; thinkingLevel?: import('./../stores/session-store').ThinkingLevel | null } },
    ): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      // 重置状态（与 aiArrange 一致）
      setPhase('idle')
      setProgressMessage(null)
      setEvents([])
      setCurrentCheckpoint(null)
      setCheckpointHistory([])
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      setInterjectMessages([])
      messageAgentMapRef.current.clear()
      messagesWithTextRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      thinkingBufferRef.current.clear()
      cancelDeltaFlush()
      setIsRunning(true)
      projectIdRef.current = projectId
      chapterNumberRef.current = chapterNumber

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/reverse-arrange`

      // 反推编排与正文创作共用后台 run + event tail，HTTP 断线不会中止实体抽取。
      const runPromise = runBackgroundFlow(
        url,
        options?.modelId ? { modelId: options.modelId } : {},
        controller,
        {
          activeRunPath: `/projects/${projectId}/chapters/${chapterNumber}/active-reverse-arrange-run`,
          failureLabel: '反推编排启动失败'
        }
      )
      runFlowPromiseRef.current = runPromise
      try {
        await runPromise
      } finally {
        abortControllerRef.current = null
        runFlowPromiseRef.current = null
      }
    },
    [runBackgroundFlow]
  )

  const submitCheckpoint = useCallback(
    async (decision: CheckpointDecision, comment?: string): Promise<void> => {
      const projectId = projectIdRef.current
      if (!projectId || !currentCheckpoint) return

      try {
        // 将检查点期间用户发送的消息 + 卡片内修改意见一并提交给后端，供下一个 Agent 使用
        // （决策端点无独立 comment 字段，修改意见并入 userMessages，协议零改动）
        const trimmedComment = comment?.trim()
        const messagesToSend = [
          ...userMessages.map((m) => m.content),
          ...(trimmedComment ? [trimmedComment] : [])
        ]
        // 决策端点路由参数使用后端推送的 checkpointId（UUID），
        // 而非 checkpoint.type（如 'narrative_task'），否则后端找不到对应请求返回 404
        if (!currentCheckpoint.checkpointId) {
          throw new Error('检查点缺少 checkpointId，无法提交决策')
        }
        await creationFlowCommands.submitCheckpoint(
          projectId,
          currentCheckpoint.checkpointId,
          decision,
          messagesToSend
        )
        setCheckpointHistory((previous) => [
          ...previous.filter((item) => item.checkpointId !== currentCheckpoint.checkpointId),
          { ...currentCheckpoint, decision, resolvedAt: Date.now() }
        ])
        // 决策已提交，清空当前检查点与用户消息，等待后续 SSE 事件推进流程
        setCurrentCheckpoint(null)
        setUserMessages([])
      } catch (err) {
        setError(err instanceof Error ? err.message : '提交决策失败')
      }
    },
    [currentCheckpoint, userMessages]
  )

  const sendMessage = useCallback(
    (content: string): void => {
      const trimmed = content.trim()
      if (!trimmed) return
      setUserMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content: trimmed,
          timestamp: Date.now()
        }
      ])
      // 持久化到章节聊天历史（fire-and-forget，不阻塞创作流程）
      const projectId = projectIdRef.current
      const chapterNumber = chapterNumberRef.current
      if (projectId && chapterNumber != null) {
        const persistPhase = currentCheckpoint ? 'checkpoint' : 'discussion'
          creationFlowCommands.persistChat(projectId, chapterNumber, {
          phase: persistPhase,
          content: trimmed,
          metadata: { flowMode: flowModeRef.current }
        }).catch(() => {
          // 持久化失败不影响创作流程
        })
      }
    },
    [currentCheckpoint]
  )

  /**
   * 发送插话（对话化交互形态 §3.1）：flow 运行中用户的中途反馈。
   *
   * 与 sendMessage（本地暂存、随下一个检查点决策一并提交）不同，插话经
   * `POST /flows/:flowId/messages` 端点即时入队（后端落库 chapterChatStore，
   * metadata.interject 标记），状态流转由 SSE novel:user-message 事件推回。
   * flowId 取当前 SSE 的 RUN_STARTED.runId；章节号仅作为定位提示，后端仍会校验
   * 该运行 ID 是否精确匹配当前活动任务。
   */
  const sendInterject = useCallback(async (
    content: string,
    targetAgent?: NovelInterjectTargetAgent
  ): Promise<SendInterjectOutcome> => {
    const trimmed = content.trim()
    if (!trimmed) return { ok: false, error: '插话内容为空' }
    const projectId = projectIdRef.current
    const chapterNumber = chapterNumberRef.current
    if (!projectId || chapterNumber == null) {
      return { ok: false, error: '当前没有可插话的创作流程' }
    }
    const flowId = activeFlowIdRef.current
    if (!flowId) {
      return { ok: false, error: '创作流程尚未建立运行 ID，请稍后重试' }
    }
    try {
      const res = await creationFlowCommands.sendInterject(projectId, flowId, {
        content: trimmed,
        targetAgent,
        chapterNumber
      })
      // 本地乐观插入 queued 气泡；随后的 SSE queued 事件按 messageId 幂等覆盖
      setInterjectMessages((prev) =>
        applyUserMessageEvent(prev, {
          flowId,
          messageId: res.messageId,
          content: trimmed,
          targetAgent,
          status: res.status,
          timestamp: Date.now()
        })
      )
      return { ok: true, messageId: res.messageId }
    } catch (err) {
      const statusCode =
        typeof (err as { statusCode?: number }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : undefined
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message, statusCode }
    }
  }, [])

  /**
   * 定向再修订：质量门修订失败后，仅对未通过项再次修订，不复跑生成流程。
   *
   * 状态处理与 startCreation 不同：
   * - **保留** chapterContent / agentOutputs / events（失败修订稿不能丢）；
   * - 仅清空 result / error，等待 re-revise 的 novel:result 覆盖内容；
   * - 端点 POST /re-revise，返回的修订稿不自动落库，由用户决定保存。
   */
  const reRevise = useCallback(
    async (
      projectId: string,
      chapterNumber: number,
      content: string,
      options?: {
        arrangedEntities?: ArrangedEntitiesPayload
        modelId?: { provider: string; modelId: string; thinkingLevel?: import('./../stores/session-store').ThinkingLevel | null }
      }
    ): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      setResult(null)
      setError(null)
      setCurrentCheckpoint(null)
      setCheckpointHistory([])
      messageAgentMapRef.current.clear()
      messagesWithTextRef.current.clear()
      deltaBufferRef.current.clear()
      thinkingBufferRef.current.clear()
      cancelDeltaFlush()
      setIsRunning(true)
      setPhase('revising')
      setProgressMessage('正在针对未通过项执行定向修订（不重跑生成流程）...')
      projectIdRef.current = projectId
      chapterNumberRef.current = chapterNumber
      flowModeRef.current = 'workflow'

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/re-revise`
      const body = {
        content,
        ...(options?.arrangedEntities ? { arrangedEntities: options.arrangedEntities } : {}),
        ...(options?.modelId ? { modelId: options.modelId } : {})
      }

      const runPromise = runFlow(url, body, controller)
      runFlowPromiseRef.current = runPromise
      try {
        await runPromise
      } finally {
        abortControllerRef.current = null
        runFlowPromiseRef.current = null
      }
    },
    [runFlow]
  )

  /**
   * 保留当前修订稿为草稿：清空错误提示与结果，但**不丢内容**。
   *
   * 正文继续留在编辑器（isRunning=false 后编辑器已恢复可编辑），
   * 用户可手动修改后再保存到章节；也不触发落库。
   */
  const keepDraft = useCallback((): void => {
    setError(null)
    setResult(null)
    setCurrentCheckpoint(null)
    setPhase('idle')
    setIsRunning(false)
    setProgressMessage(null)
  }, [])

  const cancel = useCallback(async (): Promise<void> => {
    const controller = abortControllerRef.current
    const projectId = projectIdRef.current
    const chapterNumber = chapterNumberRef.current
    if (!controller) return
    // 立即清空检查点，避免取消过程中还在等待用户决策
    setCurrentCheckpoint(null)
    // 进入 cancelling 状态：UI 显示"正在取消中"，保持 isRunning=true 避免用户重启流程
    setPhase('cancelling')
    setProgressMessage('正在停止创作流程，等待 LLM 关闭...')

    // ── 通知后端 abort 并等待 orchestrator 真正完成 ──
    // 后端 cancel-active-flow 路由会：
    //   1. reject 检查点 + abort controller（触发 signal abort 事件）
    //   2. signal abort 事件中调用 session.abort()（PI SDK 内部 await agent.waitForIdle）
    //   3. orchestrator catch 到 AbortError → finally 块清理锁 + reply.raw.end() 关闭 SSE
    //   4. resolve donePromise，后端路由返回响应
    // 这样 fetch 返回时后端已真正停止，锁已清理，可立即重新启动。
    if (projectId && chapterNumber != null) {
      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/cancel-active-flow`
      try {
        await fetch(url, {
          method: 'POST',
          keepalive: true
        })
      } catch {
        // 后端取消请求失败（如网络断开），fallback 到本地 abort
      }
    }

    // ── 本地 abort SSE（后端已关闭，但前端 SSE 可能还在等待） ──
    // 注意：后端 reply.raw.end() 会让前端 SSE 自然结束，
    // 但如果后端 cancel 请求失败，需要本地 abort 兜底。
    const runPromise = runFlowPromiseRef.current
    if (abortControllerRef.current === controller) {
      abortControllerRef.current = null
      runFlowPromiseRef.current = null
      controller.abort()
    }

    // ── 等待 runPromise 结束（确保 SSE 已关闭，避免内存泄漏） ──
    if (runPromise) {
      await runPromise.catch(() => {
        // SSE 已结束（正常或异常），忽略错误
      })
    }

    // ── 清理 UI 状态 ──
    cancelDeltaFlush()
    deltaBufferRef.current.clear()
    thinkingBufferRef.current.clear()
    setIsRunning(false)
    setProgressMessage(null)
    // 使用函数式更新避免覆盖已由 result 事件设置的 phase
    setPhase((prev) => (prev === 'cancelling' ? 'cancelled' : prev))
  }, [])

  /**
   * 重置创作流程状态到 idle。
   *
   * 用于创作完成（completed/error/cancelled）后，由上层在"保存到章节"或"丢弃"成功后调用，
   * 使右侧栏从 ChapterLivePanel 切回 NovelDetailPanel。
   *
   * 注意：cancel() 只在中途取消（abortControllerRef 仍存在）时生效，
   * 创作已结束时 abortControllerRef 已被清空，cancel() 直接 return，
   * 因此需要 reset() 显式清理 phase 等状态。
   */
  const reset = useCallback((): void => {
    setPhase('idle')
    setIsRunning(false)
    setProgressMessage(null)
    setEvents([])
    setCurrentCheckpoint(null)
    setCheckpointHistory([])
    setResult(null)
    setError(null)
    setChapterContent('')
    setAgentOutputs([])
    setUserMessages([])
    setInterjectMessages([])
    messageAgentMapRef.current.clear()
    latestAgentStartMessageIdRef.current = null
    unmappedStreamMessageIdRef.current = null
    unmappedStreamSequenceRef.current = 0
    messagesWithTextRef.current.clear()
    writerContentRef.current = ''
    deltaBufferRef.current.clear()
    thinkingBufferRef.current.clear()
    cancelDeltaFlush()
  }, [])

  /**
   * 取出并清空最近一次编排缓存的角色功能位（仅当章节号匹配时返回）。
   * 用完即清，避免把上一章的功能位带到下一章。
   */
  const takeArrangedCharacterFunctions = useCallback(
    (
      chapterNumber: number
    ): Array<{ characterId: string; function: string; note?: string }> | undefined => {
      const cached = lastArrangeFunctionsRef.current
      if (!cached || cached.chapterNumber !== chapterNumber || cached.entries.length === 0)
        return undefined
      lastArrangeFunctionsRef.current = null
      return cached.entries
    },
    []
  )

  const peekArrangedCharacterFunctions = useCallback(
    (
      chapterNumber: number
    ): Array<{ characterId: string; function: string; note?: string }> | undefined => {
      const cached = lastArrangeFunctionsRef.current
      if (!cached || cached.chapterNumber !== chapterNumber || cached.entries.length === 0) {
        return undefined
      }
      return cached.entries
    },
    []
  )

  return {
    phase,
    isRunning,
    progressMessage,
    events,
    currentCheckpoint,
    checkpointHistory,
    result,
    error,
    chapterContent,
    agentOutputs,
    userMessages,
    interjectMessages,
    startCreation,
    startDiscussion,
    resumeDiscussion,
    resumeWorkflow,
    aiArrange,
    reverseArrange,
    takeArrangedCharacterFunctions,
    peekArrangedCharacterFunctions,
    submitCheckpoint,
    sendMessage,
    sendInterject,
    reRevise,
    keepDraft,
    cancel,
    reset
  }
}
