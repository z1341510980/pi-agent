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
import { submitCheckpointDecision } from '@/api/novel-client'
import { parseSseStream } from '@/api/agui-client'
import type { BaseEvent, CustomEvent } from '@repo/protocol/events'

// ── 镜像后端类型（apps/agent-server/.../novel-agents.ts） ──

export type CreationPhase =
  | 'idle' | 'directing' | 'checkpoint_narrative' | 'writing'
  | 'reviewing' | 'checkpoint_review' | 'revising' | 'rewriting'
  | 'memory' | 'arranging' | 'completed' | 'cancelled' | 'error'

export type CheckpointType = 'narrative_task' | 'review'

export type CheckpointDecision = 'approve' | 'reject' | 'revise' | 'rewrite'

export interface CreationFlowEvent {
  type: 'phase_change' | 'agent_event' | 'agent_output' | 'checkpoint' | 'error' | 'completed' | 'cancelled'
  phase: CreationPhase
  data?: unknown
  timestamp: number
}

/** 单个 Agent 的输出内容（用于时间线展示） */
export interface AgentOutput {
  agentType: 'director' | 'writer' | 'reviewer' | 'reviser' | 'memory' | 'arranger' | 'context'
  agentName: string
  content: string
  preview: string
  timestamp: number
  /** 数据变更通知（Memory Agent 写入完成，前端据此刷新画布） */
  dataChanged?: boolean
  /** 是否仍在流式生成中（true 时 UI 显示"正在生成"动画） */
  streaming?: boolean
  /** 关联的 AG-UI TEXT_MESSAGE_* 事件 messageId（用于 delta 累积） */
  messageId?: string
}

/** 用户在创作过程中发送的消息（参与创作的指令） */
export interface UserMessage {
  id: string
  content: string
  timestamp: number
}

export interface CheckpointData {
  type: CheckpointType
  phase: CreationPhase
  data: unknown
  decision?: CheckpointDecision
  /** 后端 ConfirmationManager 生成的决策请求 ID（UUID），用于决策端点路由 */
  checkpointId?: string
}

export interface CreationResult {
  status: 'completed' | 'cancelled' | 'error'
  chapterId?: string
  content?: string
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
}

// ── Hook 返回值 ──

export interface UseNovelCreationFlowReturn {
  /** 当前阶段 */
  phase: CreationPhase
  /** 是否正在运行 */
  isRunning: boolean
  /** 所有已收到的事件（用于回放/调试） */
  events: CreationFlowEvent[]
  /** 待处理的检查点（用户需决策） */
  currentCheckpoint: CheckpointData | null
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
  /** 启动创作流程 */
  startCreation: (projectId: string, chapterNumber: number, options?: {
    arrangedEntities?: {
      characterIds: string[]
      conflictIds: string[]
      foreshadowIds: string[]
      factionIds: string[]
      locationIds: string[]
    }
  }) => Promise<void>
  /**
   * 启动 AI 编排生成流程（模式2）
   *
   * 后端先按章纲 AI 编排实体并落库，再在同一 SSE 流内衔接 create-flow 生成正文。
   * ag-ui 事件格式与 startCreation 兼容（novel:progress/novel:checkpoint/novel:result + RUN_*），
   * 因此复用同一 handleEvent 状态机；额外增加 arrange_start/arrange_progress/arrange_done
   * 进度事件会以 CUSTOM(novel:progress) 流入 events 时间线（value.type 区分）。
   */
  aiArrange: (projectId: string, chapterNumber: number) => Promise<void>
  /** 提交检查点决策 */
  submitCheckpoint: (decision: CheckpointDecision) => Promise<void>
  /** 用户发送消息参与创作（存入本地 state，在下一个检查点决策时一并发送） */
  sendMessage: (content: string) => void
  /** 取消流程 */
  cancel: () => void
  /** 重置到 idle 状态（用于创作完成后切回节点详情面板） */
  reset: () => void
}

// ── 详情格式化（将后端 detail payload 转为可读 markdown 气泡内容）──

const RHYTHM_LABELS: Record<string, string> = {
  setup: '铺垫', rising: '上升', climax: '高潮', falling: '下降',
  resolution: '收束', twist: '转折', breather: '舒缓', suspense: '悬念',
}
const CLIMAX_INTENSITY_LABELS: Record<string, string> = {
  minor: '小高潮', medium: '中高潮', major: '大高潮',
}
const CLIMAX_TYPE_LABELS: Record<string, string> = {
  emotional: '情感', fate: '命运', character: '性格', combat: '打斗', theme: '主题', composite: '复合',
}
const TASK_TYPE_LABELS: Record<string, string> = {
  advance_mainline: '推进主线', advance_subline: '推进副线',
  create_conflict: '创建冲突', escalate_conflict: '升级冲突',
  release_info: '释放信息', hide_info: '隐藏信息',
  reinforce_foreshadow: '强化伏笔', recover_foreshadow: '回收伏笔',
  change_relationship: '改变关系', change_cognition: '改变认知',
  create_reversal: '制造突转', create_suspense: '制造悬念',
  phase_closure: '阶段收束', introduce_problem: '引入问题',
}
const PRIORITY_LABELS: Record<string, string> = { high: '高', medium: '中', low: '低' }
const CONFLICT_STAGE_LABELS: Record<string, string> = {
  latent: '潜伏', emerging: '浮现', escalating: '升级', erupting: '爆发',
  reversing: '逆转', resolved: '已解决', transformed: '转化',
}
const SUSPENSE_STATUS_LABELS: Record<string, string> = {
  planting: '埋设', sustaining: '维持', releasing: '释放',
}

/** 将后端 detail 事件 payload 格式化为 markdown 气泡内容 */
function formatDetailBubble(detail: Record<string, unknown>): {
  agentType: 'director' | 'context' | 'memory' | 'arranger'
  agentName: string
  content: string
} {
  const kind = detail.kind as string
  if (kind === 'rhythm_suggestion') {
    const rhythm = detail.rhythm as string
    const climaxIntensity = detail.climaxIntensity as string | undefined
    const climaxType = detail.climaxType as string | undefined
    let md = `## 本章节奏建议\n\n**节奏**：${RHYTHM_LABELS[rhythm] ?? rhythm}`
    if (climaxIntensity) md += `\n**高潮强度**：${CLIMAX_INTENSITY_LABELS[climaxIntensity] ?? climaxIntensity}`
    if (climaxType) md += `\n**高潮类型**：${CLIMAX_TYPE_LABELS[climaxType] ?? climaxType}高潮`
    md += `\n\n**说明**：${detail.description as string}\n\n**原因**：${detail.reason as string}`
    return { agentType: 'context', agentName: '节奏', content: md }
  }
  if (kind === 'narrative_task') {
    const taskType = detail.taskType as string
    const priority = detail.priority as string
    const climaxTarget = detail.climaxTarget as { type: string; intensity: string } | undefined
    const suspenseDuration = detail.suspenseDuration as number | undefined
    const expectedIntensityDelta = detail.expectedIntensityDelta as number | undefined
    let md = `## 叙事任务已解析\n\n**任务类型**：${TASK_TYPE_LABELS[taskType] ?? taskType}\n**优先级**：${PRIORITY_LABELS[priority] ?? priority}`
    if (climaxTarget) md += `\n**高潮目标**：${CLIMAX_TYPE_LABELS[climaxTarget.type] ?? climaxTarget.type}（${CLIMAX_INTENSITY_LABELS[climaxTarget.intensity] ?? climaxTarget.intensity}）`
    if (suspenseDuration != null) md += `\n**悬念持续**：${suspenseDuration} 章`
    if (expectedIntensityDelta != null) md += `\n**预期强度变化**：${expectedIntensityDelta > 0 ? '+' : ''}${expectedIntensityDelta}`
    return { agentType: 'director', agentName: '导演', content: md }
  }
  if (kind === 'chapter_context') {
    const conflictTargets = (detail.conflictTargets as Array<Record<string, unknown>>) ?? []
    const suspenseHooks = (detail.suspenseHooks as Array<Record<string, unknown>>) ?? []
    const rhythmConstraint = detail.rhythmConstraint as Record<string, unknown> | undefined
    let md = `## 章节约束已构建`
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
    if (conflictTargets.length === 0 && suspenseHooks.length === 0 && !rhythmConstraint) {
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
      { label: '地点', items: locations },
    ]
    for (const s of sections) {
      if (s.items.length === 0) continue
      md += `\n### ${s.label}（${s.items.length}）\n`
      s.items.forEach((it, i) => { md += `\n${i + 1}. ${it}` })
    }
    if (characters.length + conflicts.length + foreshadows.length + factions.length + locations.length === 0) {
      md += `\n\n*章纲未规划新实体*`
    }
    return { agentType: 'arranger', agentName: '规划', content: md }
  }
  if (kind === 'arrange_result') {
    const characters = (detail.characters as Array<{ name: string; description: string }>) ?? []
    const conflicts = (detail.conflicts as Array<{ description: string; intensity: number; tier: string; climaxChapter: number | null; climaxType: string | null }>) ?? []
    const foreshadows = (detail.foreshadows as Array<{ description: string; category: string }>) ?? []
    const factions = (detail.factions as Array<{ name: string; type: string }>) ?? []
    const locations = (detail.locations as Array<{ name: string; type: string }>) ?? []
    let md = `## 编排完成清单\n`
    if (characters.length > 0) {
      md += `\n### 角色（${characters.length}）\n`
      characters.forEach((c, i) => { md += `\n${i + 1}. **${c.name}** — ${c.description}` })
    }
    if (conflicts.length > 0) {
      md += `\n### 冲突（${conflicts.length}）\n`
      conflicts.forEach((c, i) => {
        const tierLabel = c.tier === 'main' ? '主要' : c.tier === 'goal' ? '主角目的' : '次要'
        const climaxMark = c.climaxChapter != null ? ` 🔥第${c.climaxChapter}章` : ''
        const climaxTypeLabel = c.climaxType ? ` ${CLIMAX_TYPE_LABELS[c.climaxType] ?? c.climaxType}高潮` : ''
        md += `\n${i + 1}. [${tierLabel}] ${c.description}（强度 ${c.intensity}/10${climaxMark}${climaxTypeLabel}）`
      })
    }
    if (foreshadows.length > 0) {
      md += `\n### 伏笔（${foreshadows.length}）\n`
      foreshadows.forEach((f, i) => { md += `\n${i + 1}. [${f.category}] ${f.description}` })
    }
    if (factions.length > 0) {
      md += `\n### 势力（${factions.length}）\n`
      factions.forEach((f, i) => { md += `\n${i + 1}. **${f.name}**（${f.type}）` })
    }
    if (locations.length > 0) {
      md += `\n### 地点（${locations.length}）\n`
      locations.forEach((l, i) => { md += `\n${i + 1}. **${l.name}**（${l.type}）` })
    }
    return { agentType: 'arranger', agentName: '编排', content: md }
  }
  if (kind === 'arrange_summary') {
    const total = detail.total as number
    const characters = detail.characters as number
    const conflicts = detail.conflicts as number
    const foreshadows = detail.foreshadows as number
    const factions = detail.factions as number
    const locations = detail.locations as number
    const md = `## 编排完成\n\n**共生成 ${total} 个实体已落入矩阵**\n\n- 角色：${characters}\n- 冲突：${conflicts}\n- 伏笔：${foreshadows}\n- 势力：${factions}\n- 地点：${locations}`
    return { agentType: 'arranger', agentName: '编排', content: md }
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
  const [events, setEvents] = useState<CreationFlowEvent[]>([])
  const [currentCheckpoint, setCurrentCheckpoint] = useState<CheckpointData | null>(null)
  const [result, setResult] = useState<CreationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chapterContent, setChapterContent] = useState('')
  const [agentOutputs, setAgentOutputs] = useState<AgentOutput[]>([])
  const [userMessages, setUserMessages] = useState<UserMessage[]>([])

  const abortControllerRef = useRef<AbortController | null>(null)
  const projectIdRef = useRef<string | null>(null)
  /** messageId → { agentType, agentName } 映射：agent_start 时记录，TEXT_MESSAGE_* 时查询 */
  const messageAgentMapRef = useRef<Map<string, { agentType: AgentOutput['agentType']; agentName: string }>>(new Map())
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

  /** 调度一帧后的 flush：合并 deltaBuffer 到 agentOutputs / chapterContent */
  const scheduleDeltaFlush = useCallback(() => {
    if (rafIdRef.current !== null) return  // 已有调度
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      const buffer = deltaBufferRef.current
      if (buffer.size === 0) return
      const entries = Array.from(buffer.entries())
      buffer.clear()

      // 找出 writer/reviser 的 delta，累积到 chapterContent
      let writerDelta = ''
      for (const [messageId, delta] of entries) {
        const meta = messageAgentMapRef.current.get(messageId)
        if (meta && (meta.agentType === 'writer' || meta.agentType === 'reviser')) {
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
          const idx = updated.findIndex(o => o.messageId === messageId)
          if (idx === -1) continue
          if (updated === prev) updated = [...prev]  // 懒复制
          const newContent = updated[idx].content + delta
          updated[idx] = {
            ...updated[idx],
            content: newContent,
            preview: newContent.slice(-200),
          }
        }
        return updated
      })
    })
  }, [])

  /**
   * 处理单条 ag-ui 事件，更新状态。
   *
   * 与 chat 共用同一套 ag-ui 协议：
   * - TEXT_MESSAGE_START/CONTENT/END → LLM 流式文本（增量 delta，按 messageId 累积）
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
    // ── 标准 AG-UI 事件：LLM 流式文本（与 chat 共用同一协议） ──
    // TEXT_MESSAGE_START：StreamEmitter 开始发射某 messageId 的文本
    // 如果 agent_start 已创建初始气泡（含"已启动"提示），清空 content 准备接收流式 delta
    if (event.type === 'TEXT_MESSAGE_START') {
      const { messageId } = event as { type: 'TEXT_MESSAGE_START'; messageId: string }
      const meta = messageAgentMapRef.current.get(messageId)
      if (meta) {
        setAgentOutputs((prev) => {
          const idx = prev.findIndex(o => o.messageId === messageId)
          if (idx >= 0) {
            // 已有初始气泡（agent_start 创建）→ 清空 content，准备接收 delta
            const updated = [...prev]
            updated[idx] = { ...updated[idx], content: '', preview: '' }
            return updated
          }
          // 无初始气泡 → 新建 streaming 气泡
          return [...prev, {
            agentType: meta.agentType,
            agentName: meta.agentName,
            content: '',
            preview: '',
            timestamp: Date.now(),
            streaming: true,
            messageId,
          }]
        })
      }
      return
    }

    // TEXT_MESSAGE_CONTENT：累积到缓冲，rAF 批量 flush（避免高频 setState）
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      const { messageId, delta } = event as { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
      const existing = deltaBufferRef.current.get(messageId) ?? ''
      deltaBufferRef.current.set(messageId, existing + delta)
      scheduleDeltaFlush()
      return
    }

    // TEXT_MESSAGE_END：标记该 Agent 输出完成
    if (event.type === 'TEXT_MESSAGE_END') {
      const { messageId } = event as { type: 'TEXT_MESSAGE_END'; messageId: string }
      // 先同步 flush 残留 delta（rAF 可能还没触发），避免最后一段文本丢失
      const pending = deltaBufferRef.current.get(messageId)
      if (pending) {
        deltaBufferRef.current.delete(messageId)
        const meta = messageAgentMapRef.current.get(messageId)
        if (meta && (meta.agentType === 'writer' || meta.agentType === 'reviser')) {
          writerContentRef.current += pending
          setChapterContent(writerContentRef.current)
        }
        setAgentOutputs((prev) => {
          const idx = prev.findIndex(o => o.messageId === messageId)
          if (idx === -1) return prev
          const updated = [...prev]
          const newContent = updated[idx].content + pending
          updated[idx] = {
            ...updated[idx],
            content: newContent,
            preview: newContent.slice(-200),
            streaming: false,
          }
          return updated
        })
      } else {
        setAgentOutputs((prev) => {
          const idx = prev.findIndex(o => o.messageId === messageId)
          if (idx === -1) return prev
          const updated = [...prev]
          updated[idx] = { ...updated[idx], streaming: false }
          return updated
        })
      }
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
          const data = evt.data as {
            type?: string
            agentType?: string
            agentName?: string
            messageId?: string
            message?: string
            dataChanged?: boolean
            data?: unknown
            detail?: Record<string, unknown>
          }
          // detail 事件：节奏建议/叙事任务/章节约束/记忆结果
          // → 格式化为 info 气泡（arrange_* 详情由下方专门分支处理，需要 dataChanged / streaming 语义）
          if (data?.detail && typeof data.detail === 'object' && data.detail.kind) {
            const detailKind = data.detail.kind as string
            if (!detailKind.startsWith('arrange_')) {
              const formatted = formatDetailBubble(data.detail)
              setAgentOutputs((prev) => [...prev, {
                agentType: formatted.agentType,
                agentName: formatted.agentName,
                content: formatted.content,
                preview: data.message ?? formatted.content.slice(0, 100),
                timestamp: evt.timestamp,
                // memory_result 携带 dataChanged 标记，触发画布刷新
                dataChanged: data.dataChanged === true,
              }])
              return
            }
          }
          // agent_start：记录 messageId → agentType 映射，重置 writer 累积器
          // 同时创建一个初始 streaming AgentOutput，展示"已启动"提示，
          // 让用户在首 token 到达前就能看到 Agent 已启动（避免 approve 后空白等待）
          if (data?.type === 'agent_start' && data.messageId && data.agentType && data.agentName) {
            messageAgentMapRef.current.set(data.messageId, {
              agentType: data.agentType as AgentOutput['agentType'],
              agentName: data.agentName,
            })
            if (data.agentType === 'writer' || data.agentType === 'reviser') {
              writerContentRef.current = ''
              setChapterContent('')
            }
            // 创建初始 streaming 气泡：TEXT_MESSAGE_START 会清空 content 准备接收流式 delta
            const initialMsg = data.message ?? `${data.agentName} 已启动...`
            setAgentOutputs((prev) => {
              if (prev.some(o => o.messageId === data.messageId)) return prev
              return [...prev, {
                agentType: data.agentType as AgentOutput['agentType'],
                agentName: data.agentName!,
                content: initialMsg,
                preview: initialMsg,
                timestamp: evt.timestamp,
                streaming: true,
                messageId: data.messageId,
              }]
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
                return [...prev.slice(0, -1), {
                  ...last,
                  content: summary ? `${last.content}\n\n---\n\n**提取摘要**：${summary}` : (data.message ?? last.content),
                  preview: summary ?? data.message ?? last.preview,
                  streaming: false,
                  dataChanged: true,
                }]
              }
              // 无前置 streaming 气泡 → 直接创建完成态气泡
              return [...prev, {
                agentType: (data.agentType ?? 'memory') as AgentOutput['agentType'],
                agentName: data.agentName ?? '记忆',
                content: summary ?? data.message ?? '数据已更新',
                preview: summary ?? data.message ?? '数据已更新',
                timestamp: evt.timestamp,
                dataChanged: true,
              }]
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
                return [...prev.slice(0, -1), { ...last, content: data.message!, preview: data.message! }]
              }
              return [...prev, {
                agentType: 'memory',
                agentName: '记忆',
                content: data.message!,
                preview: data.message!,
                timestamp: evt.timestamp,
                streaming: true,
              }]
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
            dataChanged: boolean,
          ) => {
            setAgentOutputs((prev) => {
              const last = prev[prev.length - 1]
              if (last && last.agentType === 'arranger' && last.streaming) {
                return [...prev.slice(0, -1), { ...last, streaming: false }, {
                  agentType: 'arranger',
                  agentName,
                  content,
                  preview,
                  timestamp,
                  dataChanged,
                }]
              }
              return [...prev, {
                agentType: 'arranger',
                agentName,
                content,
                preview,
                timestamp,
                dataChanged,
              }]
            })
          }
          const evtType = (evt as { type?: string }).type
          if (typeof evtType === 'string' && evtType.startsWith('arrange_')) {
            const evtMsg = (evt as { message?: string }).message ?? data?.message ?? ''
            const evtDetail = (evt as { detail?: Record<string, unknown> }).detail
            const detail = evtDetail ?? data?.detail
            const detailKind = detail?.kind as string | undefined
            const partial = (data as { partial?: string } | undefined)?.partial
              ?? (evtDetail as { partial?: string } | undefined)?.partial

            // arrange_done + arrange_summary：编排完成，实体已落库
            // → 渲染汇总气泡 + dataChanged: true 触发画布/侧边栏刷新
            if (evtType === 'arrange_done' && detail && detailKind === 'arrange_summary') {
              const formatted = formatDetailBubble(detail)
              const content = formatted.content
              pushArrangerBubble(content, content.slice(0, 100), evt.timestamp, '编排', true)
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
                  return [...prev.slice(0, -1), { ...last, content: streamContent, preview: partial }]
                }
                return [...prev, {
                  agentType: 'arranger',
                  agentName: '编排',
                  content: streamContent,
                  preview: partial,
                  timestamp: evt.timestamp,
                  streaming: true,
                }]
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
                return [...prev, {
                  agentType: 'arranger',
                  agentName: '编排',
                  content: evtMsg,
                  preview: evtMsg,
                  timestamp: evt.timestamp,
                  streaming: true,
                }]
              })
            }
            return
          }
          // phase_change / 心跳：只更新 events 和 phase，不覆盖 chapterContent
          return
        }
        case 'novel:checkpoint': {
          const checkpoint = custom.value as CheckpointData
          setCurrentCheckpoint(checkpoint)
          setPhase(checkpoint.phase)
          return
        }
        case 'novel:result': {
          const resultData = custom.value as CreationResult
          setResult(resultData)
          // 先取消可能挂起的 rAF，再清空缓冲（result.content 是权威全量）
          if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current)
            rafIdRef.current = null
          }
          deltaBufferRef.current.clear()
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
                : 'error',
          )
          setIsRunning(false)
          setCurrentCheckpoint(null)
          if (resultData.error) {
            setError(resultData.error)
          }
          return
        }
        default:
          return
      }
    }

    if (event.type === 'RUN_ERROR') {
      const errEvent = event as { type: 'RUN_ERROR'; message: string }
      setError(errEvent.message)
      setPhase('error')
      setIsRunning(false)
      setCurrentCheckpoint(null)
      return
    }

    if (event.type === 'RUN_FINISHED') {
      setIsRunning(false)
      setCurrentCheckpoint(null)
    }

    // RUN_STARTED / TOOL_CALL_* / STEP_* / ACTIVITY_* / 其他事件：暂不展示
    // （Memory Agent 的工具调用事件已在后端发射，前端未来可扩展展示）
  }, [])

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
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`创作流程启动失败: HTTP ${response.status} ${response.statusText}`)
        }

        if (!response.body) {
          throw new Error('响应体为空，无法读取 SSE 流')
        }

        // 复用 chat 的 parseSseStream：统一 SSE 解析逻辑
        await parseSseStream(response.body, handleEvent)
      } catch (err) {
        // 用户主动取消（abort）不算错误
        if (controller.signal.aborted) {
          setPhase('cancelled')
          setIsRunning(false)
          setCurrentCheckpoint(null)
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setPhase('error')
        setIsRunning(false)
        setCurrentCheckpoint(null)
      }
    },
    [handleEvent],
  )

  const startCreation = useCallback(
    async (projectId: string, chapterNumber: number, options?: {
      arrangedEntities?: {
        characterIds: string[]
        conflictIds: string[]
        foreshadowIds: string[]
        factionIds: string[]
        locationIds: string[]
      }
    }): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      // 重置状态
      setPhase('idle')
      setEvents([])
      setCurrentCheckpoint(null)
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      messageAgentMapRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      setIsRunning(true)
      projectIdRef.current = projectId

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/create-flow`
      const body = options?.arrangedEntities ? { arrangedEntities: options.arrangedEntities } : {}

      try {
        await runFlow(url, body, controller)
      } finally {
        abortControllerRef.current = null
      }
    },
    [runFlow],
  )

  /**
   * 启动 AI 编排生成流程（模式2）。
   *
   * 后端先按章纲 AI 编排实体并落库，再在同一 SSE 流内衔接 create-flow 生成正文。
   * ag-ui 事件格式与 startCreation 兼容（novel:progress/novel:checkpoint/novel:result + RUN_*），
   * 因此复用 runFlow + handleEvent 状态机。
   *
   * arrange 阶段的 CUSTOM(novel:progress) value 形状为 { type: 'arrange_*', ... }，
   * 会流入 events 时间线；create-flow 阶段事件形状与 startCreation 完全一致。
   */
  const aiArrange = useCallback(
    async (projectId: string, chapterNumber: number): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      // 重置状态（与 startCreation 一致）
      setPhase('idle')
      setEvents([])
      setCurrentCheckpoint(null)
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      messageAgentMapRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      setIsRunning(true)
      projectIdRef.current = projectId

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/ai-arrange`

      try {
        await runFlow(url, {}, controller)
      } finally {
        abortControllerRef.current = null
      }
    },
    [runFlow],
  )

  const submitCheckpoint = useCallback(
    async (decision: CheckpointDecision): Promise<void> => {
      const projectId = projectIdRef.current
      if (!projectId || !currentCheckpoint) return

      try {
        // 将检查点期间用户发送的消息一并提交给后端，供下一个 Agent 使用
        const messagesToSend = userMessages.map((m) => m.content)
        // 决策端点路由参数使用后端推送的 checkpointId（UUID），
        // 而非 checkpoint.type（如 'narrative_task'），否则后端找不到对应请求返回 404
        if (!currentCheckpoint.checkpointId) {
          throw new Error('检查点缺少 checkpointId，无法提交决策')
        }
        await submitCheckpointDecision(projectId, currentCheckpoint.checkpointId, decision, messagesToSend)
        // 决策已提交，清空检查点与用户消息，等待后续 SSE 事件推进流程
        setCurrentCheckpoint(null)
        setUserMessages([])
      } catch (err) {
        setError(err instanceof Error ? err.message : '提交决策失败')
      }
    },
    [currentCheckpoint, userMessages],
  )

  const sendMessage = useCallback((content: string): void => {
    const trimmed = content.trim()
    if (!trimmed) return
    setUserMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: trimmed,
        timestamp: Date.now(),
      },
    ])
  }, [])

  const cancel = useCallback((): void => {
    if (!abortControllerRef.current) return
    abortControllerRef.current.abort()
    // 清理可能挂起的 rAF，避免 abort 后还触发 setState
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    deltaBufferRef.current.clear()
    // 状态在 startCreation 的 catch / finally 中清理
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
    setEvents([])
    setCurrentCheckpoint(null)
    setResult(null)
    setError(null)
    setChapterContent('')
    setAgentOutputs([])
    setUserMessages([])
    messageAgentMapRef.current.clear()
    writerContentRef.current = ''
    deltaBufferRef.current.clear()
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  return {
    phase,
    isRunning,
    events,
    currentCheckpoint,
    result,
    error,
    chapterContent,
    agentOutputs,
    userMessages,
    startCreation,
    aiArrange,
    submitCheckpoint,
    sendMessage,
    cancel,
    reset,
  }
}
