import { useCallback, useRef, useState } from 'react'
import { EventType, type BaseEvent } from '@repo/protocol/events'
import type { AgentMessage } from '@repo/shared/agent'
import { runAgent } from '../api/agui-client'

export type StreamingRunStatus =
  | 'idle'
  | 'streaming'
  | 'aborted'
  | 'error'
  | 'finished'

export interface UseStreamingRunOptions {
  threadId: string
  /** 透传所有 AG-UI 事件（消息流组件用于更新消息列表） */
  onEvent?: (event: BaseEvent) => void
  /** run 正常结束（RUN_FINISHED） */
  onFinished?: (runId: string, result?: string) => void
  /** run 出错（RUN_ERROR 或网络错误） */
  onError?: (error: Error) => void
  /** 指定本次 run 使用的模型（provider + modelId），未传则由后端使用默认模型 */
  model?: { provider: string; modelId: string }
  /** 目标 Agent ID，默认 'default' */
  agentId?: string
}

export interface UseStreamingRunReturn {
  /** 发起 run；若当前正在运行则忽略 */
  run: (messages: AgentMessage[]) => Promise<void>
  /** 中断当前 run */
  abort: () => void
  /** 当前状态 */
  status: StreamingRunStatus
  /** 当前 runId（运行中或最近一次） */
  currentRunId: string | null
  /** 错误信息（status === 'error' 时） */
  error: Error | null
  /** 是否正在运行 */
  isRunning: boolean
}

/**
 * useStreamingRun：AG-UI 流式 run 的状态机 hook
 *
 * 状态转换：
 *   idle ──run()──▶ streaming ──RUN_FINISHED──▶ finished
 *                       │
 *                       ├──RUN_ERROR──▶ error
 *                       ├──abort()──▶ aborted（后端会发 RUN_FINISHED reason='aborted'）
 *                       └──网络断开──▶ error
 *
 * 关键不变量：
 * 1. isRunning 时拒绝新的 run() 调用（后端同 threadId 互斥）
 * 2. abort() 通过 AbortController 中断 fetch，后端会发 RUN_FINISHED
 * 3. 所有终止状态（finished/aborted/error）都会清理资源
 */
export function useStreamingRun(
  options: UseStreamingRunOptions,
): UseStreamingRunReturn {
  const { threadId, onEvent, onFinished, onError, model, agentId } = options

  const [status, setStatus] = useState<StreamingRunStatus>('idle')
  const [currentRunId, setCurrentRunId] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const onEventRef = useRef(onEvent)
  const onFinishedRef = useRef(onFinished)
  const onErrorRef = useRef(onError)

  // 保持回调引用最新，但不触发重新渲染
  onEventRef.current = onEvent
  onFinishedRef.current = onFinished
  onErrorRef.current = onError

  const run = useCallback(
    async (messages: AgentMessage[]) => {
      // 并发保护：正在运行时拒绝新 run
      if (abortControllerRef.current) {
        return
      }

      const runId = crypto.randomUUID()
      const controller = new AbortController()
      abortControllerRef.current = controller
      setCurrentRunId(runId)
      setStatus('streaming')
      setError(null)

      await runAgent({
        threadId,
        runId,
        messages,
        signal: controller.signal,
        model,
        agentId,
        onEvent: (event) => {
          // 根据 AG-UI 事件类型更新状态
          if (event.type === EventType.RUN_FINISHED) {
            const finishedEvent = event as { type: string; result?: string; reason?: string }
            // abort 后后端会发 RUN_FINISHED reason='aborted'，此时状态已是 aborted
            if (finishedEvent.reason === 'aborted') {
              setStatus('aborted')
            } else {
              setStatus('finished')
              onFinishedRef.current?.(runId, finishedEvent.result)
            }
          } else if (event.type === EventType.RUN_ERROR) {
            const errorEvent = event as { type: string; message: string }
            const err = new Error(errorEvent.message)
            setError(err)
            setStatus('error')
            onErrorRef.current?.(err)
          }
          // 透传所有事件给消费者
          onEventRef.current?.(event)
        },
        onError: (err) => {
          // 网络错误等（非 abort）
          if (controller.signal.aborted) return
          setError(err)
          setStatus('error')
          onErrorRef.current?.(err)
        },
      })

      // 清理资源（无论成功/失败/中断都必须清理，否则后续 run 会被拒绝）
      abortControllerRef.current = null
    },
    [threadId, model, agentId],
  )

  const abort = useCallback(() => {
    if (!abortControllerRef.current) return
    abortControllerRef.current.abort()
    setStatus('aborted')
    // abortControllerRef 在 run() 的 finally 中清理
  }, [])

  return {
    run,
    abort,
    status,
    currentRunId,
    error,
    isRunning: status === 'streaming',
  }
}
