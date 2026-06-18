import { useCallback, useState } from 'react'
import type { ServerMessage } from './use-websocket'

/** 工具执行状态机 */
export type ToolExecutionState =
  | 'pending' // 等待用户确认
  | 'running' // 已开始执行
  | 'success' // 执行成功
  | 'error' // 执行失败
  | 'denied' // 用户拒绝

export interface ToolExecution {
  toolCallId: string
  toolName: string
  state: ToolExecutionState
  startedAt?: number
  endedAt?: number
  /** 关联的确认请求 ID（若有） */
  confirmationId?: string
  /** 确认原因（若有） */
  reason?: string
}

/**
 * 工具执行状态机 hook
 *
 * 状态转换：
 * - confirmation_request → pending（带 confirmationId）
 * - tool_execution start → running
 * - tool_execution end → success
 * - confirmation_resolved(approved=false) → denied
 *
 * 通过 onMessage 回调接入 useWebSocket。
 */
export interface UseToolExecutionsReturn {
  executions: ToolExecution[]
  onMessage: (msg: ServerMessage) => void
  clear: () => void
}

export function useToolExecutions(): UseToolExecutionsReturn {
  const [executions, setExecutions] = useState<Map<string, ToolExecution>>(new Map())

  const onMessage = useCallback((msg: ServerMessage) => {
    setExecutions((prev) => {
      const next = new Map(prev)

      if (msg.type === 'confirmation_request') {
        const { toolCallId, toolName, id, reason } = msg.payload
        const existing = next.get(toolCallId)
        next.set(toolCallId, {
          toolCallId,
          toolName,
          state: 'pending',
          confirmationId: id,
          reason,
          startedAt: existing?.startedAt,
        })
      } else if (msg.type === 'tool_execution') {
        const { toolCallId, toolName, phase } = msg.payload
        const existing = next.get(toolCallId)
        if (phase === 'start') {
          next.set(toolCallId, {
            toolCallId,
            toolName,
            state: 'running',
            startedAt: Date.now(),
            confirmationId: existing?.confirmationId,
            reason: existing?.reason,
          })
        } else if (phase === 'end') {
          // end 事件不区分 success/error（WebSocket 事件未携带），默认 success
          // 真实错误信息通过 Evidence Ledger / AG-UI 事件补充
          next.set(toolCallId, {
            toolCallId,
            toolName: existing?.toolName ?? toolName,
            state: 'success',
            startedAt: existing?.startedAt,
            endedAt: Date.now(),
            confirmationId: existing?.confirmationId,
            reason: existing?.reason,
          })
        }
      } else if (msg.type === 'confirmation_resolved') {
        const { id, approved } = msg.payload
        if (!approved) {
          // 找到对应的 toolCallId 并标记为 denied
          for (const [toolCallId, exec] of next) {
            if (exec.confirmationId === id) {
              next.set(toolCallId, {
                ...exec,
                state: 'denied',
                endedAt: Date.now(),
              })
              break
            }
          }
        }
      }

      return next
    })
  }, [])

  /** 清空所有执行记录 */
  const clear = useCallback(() => {
    setExecutions(new Map())
  }, [])

  /** 按时间倒序返回执行记录 */
  const list = Array.from(executions.values()).sort((a, b) => {
    const at = a.startedAt ?? a.endedAt ?? 0
    const bt = b.startedAt ?? b.endedAt ?? 0
    return bt - at
  })

  return { executions: list, onMessage, clear }
}
