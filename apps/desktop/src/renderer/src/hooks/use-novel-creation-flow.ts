/**
 * 小说多 Agent 创作流程 SSE Hook
 *
 * 通过 fetch + ReadableStream 消费后端 SSE 流（POST 端点，不能用 EventSource）。
 *
 * 后端端点：
 *   POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/create-flow
 *
 * SSE 事件格式（data: 行后跟 JSON）：
 *   - { type: 'progress',  data: CreationFlowEvent }   阶段变更/Agent 事件
 *   - { type: 'checkpoint', data: CheckpointData }      等待用户决策
 *   - { type: 'result',     data: CreationResult }      流程结束
 *   - { type: 'error',      error: string }             错误
 *
 * 检查点决策端点：
 *   POST /api/plugins/novel/projects/:projectId/checkpoint/:type/decision
 *   body: { decision: 'approve' | 'reject' | 'revise' | 'rewrite' }
 */

import { useCallback, useRef, useState } from 'react'
import { browserConfig } from '@repo/config/browser'
import { submitCheckpointDecision } from '@/api/novel-client'

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

// ── SSE 消息信封 ──

interface SseProgressMessage {
  type: 'progress'
  data: CreationFlowEvent
}

interface SseCheckpointMessage {
  type: 'checkpoint'
  data: CheckpointData
}

interface SseResultMessage {
  type: 'result'
  data: CreationResult
}

interface SseErrorMessage {
  type: 'error'
  error: string
}

type SseMessage = SseProgressMessage | SseCheckpointMessage | SseResultMessage | SseErrorMessage

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
  /** 用户在创作过程中发送的消息（随检查点决策一并发送到后端） */
  userMessages: UserMessage[]
  /** 启动创作流程 */
  startCreation: (projectId: string, chapterNumber: number) => Promise<void>
  /** 提交检查点决策 */
  submitCheckpoint: (decision: CheckpointDecision) => Promise<void>
  /** 用户发送消息参与创作（存入本地 state，在下一个检查点决策时一并发送） */
  sendMessage: (content: string) => void
  /** 取消流程 */
  cancel: () => void
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

  /** 解析单条 SSE data: 行 */
  const parseSseMessage = useCallback((raw: string): SseMessage | null => {
    try {
      return JSON.parse(raw) as SseMessage
    } catch {
      return null
    }
  }, [])

  /** 处理单条 SSE 消息，更新状态 */
  const handleMessage = useCallback((msg: SseMessage): void => {
    switch (msg.type) {
      case 'progress': {
        const evt = msg.data
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
          break
        }
        // 写作阶段开始累积内容占位（实际内容由 result 提供）
        if (evt.phase === 'writing' && evt.data && typeof evt.data === 'object') {
          const data = evt.data as { message?: string }
          if (data.message) {
            setChapterContent((prev) => (prev ? prev : data.message as string))
          }
        }
        break
      }
      case 'checkpoint': {
        setCurrentCheckpoint(msg.data)
        setPhase(msg.data.phase)
        break
      }
      case 'result': {
        setResult(msg.data)
        setChapterContent(msg.data.content ?? '')
        setPhase(msg.data.status === 'completed' ? 'completed' : msg.data.status === 'cancelled' ? 'cancelled' : 'error')
        setIsRunning(false)
        setCurrentCheckpoint(null)
        if (msg.data.error) {
          setError(msg.data.error)
        }
        break
      }
      case 'error': {
        setError(msg.error)
        setPhase('error')
        setIsRunning(false)
        setCurrentCheckpoint(null)
        break
      }
    }
  }, [])

  /** 从 ReadableStream 中按行解析 SSE */
  const consumeStream = useCallback(
    async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE 以双换行分隔事件，单行以 "data: " 前缀
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, newlineIdx)
          buffer = buffer.slice(newlineIdx + 2)

          // 解析事件块中的 data: 行（忽略注释行 ": keepalive"）
          const dataLines = rawEvent
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())

          if (dataLines.length === 0) continue

          const msg = parseSseMessage(dataLines.join('\n'))
          if (msg) handleMessage(msg)
        }
      }
    },
    [parseSseMessage, handleMessage],
  )

  const startCreation = useCallback(
    async (projectId: string, chapterNumber: number): Promise<void> => {
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

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({}),
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`创作流程启动失败: HTTP ${response.status} ${response.statusText}`)
        }

        if (!response.body) {
          throw new Error('响应体为空，无法读取 SSE 流')
        }

        await consumeStream(response.body.getReader())
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
      } finally {
        abortControllerRef.current = null
      }
    },
    [consumeStream],
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
    submitCheckpoint,
    sendMessage,
    cancel,
  }
}
