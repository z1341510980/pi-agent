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
  | 'memory' | 'completed' | 'cancelled' | 'error'

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
  agentType: 'director' | 'writer' | 'reviewer' | 'reviser' | 'memory'
  agentName: string
  content: string
  preview: string
  timestamp: number
  /** 数据变更通知（Memory Agent 写入完成，前端据此刷新画布；不展示在时间线） */
  dataChanged?: boolean
  /** 是否仍在流式生成中（true 时 UI 显示"正在生成"动画） */
  streaming?: boolean
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
    arrangedEntities?: { characterIds: string[]; conflictIds: string[]; foreshadowIds: string[] }
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

  /**
   * 处理单条 ag-ui 事件，更新状态。
   *
   * 与 chat 共用同一套 ag-ui 协议：
   * - RUN_STARTED → 流开始（isRunning 已由调用方置位，此处 no-op）
   * - CUSTOM(novel:progress) → CreationFlowEvent，阶段变更/Agent 事件
   * - CUSTOM(novel:checkpoint) → CheckpointData，等待用户决策
   * - CUSTOM(novel:result) → CreationResult，流程结束
   * - RUN_FINISHED → 流结束（result 已处理则 no-op，否则作兜底关闭 isRunning）
   * - RUN_ERROR → 错误
   */
  const handleEvent = useCallback((event: BaseEvent): void => {
    // 优先处理 CUSTOM 事件（小说专属语义通过 name 区分）
    if (event.type === 'CUSTOM') {
      const custom = event as CustomEvent
      switch (custom.name) {
        case 'novel:progress': {
          const evt = custom.value as CreationFlowEvent
          setEvents((prev) => [...prev, evt])
          setPhase(evt.phase)
          // 处理 agent_output 事件：保存到 agentOutputs 时间线
          if (evt.type === 'agent_output') {
            const data = evt.data as AgentOutput
            const newOutput: AgentOutput = {
              agentType: data.agentType,
              agentName: data.agentName,
              content: data.content,
              preview: data.preview,
              timestamp: evt.timestamp,
              dataChanged: data.dataChanged,
              streaming: data.streaming,
            }
            // 流式更新（streaming: true）与完成通知（streaming: false）都更新最后一条
            // 同类型 Agent 输出，避免重复条目；仅在不存在同类型输出时新增。
            // dataChanged 通知总是新增（它是独立的数据刷新信号，不参与流式替换）。
            if (data.dataChanged) {
              setAgentOutputs((prev) => [...prev, newOutput])
            } else {
              setAgentOutputs((prev) => {
                const idx = [...prev].reverse().findIndex((o) => o.agentType === data.agentType)
                if (idx === -1) return [...prev, newOutput]
                const realIdx = prev.length - 1 - idx
                const updated = [...prev]
                updated[realIdx] = newOutput
                return updated
              })
            }
            // 如果是 writer 或 reviser 的输出，同时更新 chapterContent
            if (data.agentType === 'writer' || data.agentType === 'reviser') {
              setChapterContent(data.content)
            }
            return
          }
          // 写作阶段开始累积内容占位（实际内容由 result 提供）
          if (evt.phase === 'writing' && evt.data && typeof evt.data === 'object') {
            const data = evt.data as { message?: string }
            if (data.message) {
              setChapterContent((prev) => (prev ? prev : data.message as string))
            }
          }
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
          setChapterContent(resultData.content ?? '')
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
          // 忽略未识别的 CUSTOM 事件
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
      // result 事件通常已在 CUSTOM(novel:result) 中处理并关闭 isRunning；
      // 此处作为兜底：若 result 缺失则强制关闭 isRunning，防止永久 running。
      // 这些 setter 都是幂等的，重复调用无副作用。
      setIsRunning(false)
      setCurrentCheckpoint(null)
    }

    // RUN_STARTED / 其他事件：no-op（isRunning 由 startCreation/aiArrange 设置）
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
      arrangedEntities?: { characterIds: string[]; conflictIds: string[]; foreshadowIds: string[] }
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
        await submitCheckpointDecision(projectId, currentCheckpoint.type, decision, messagesToSend)
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
