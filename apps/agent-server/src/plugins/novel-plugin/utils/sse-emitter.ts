/**
 * AG-UI 兼容的 SSE 事件发射器
 *
 * 拆分自原 novel-routes.ts（PR-6），供创作流程、群聊、AI 编排等 SSE 路由共享。
 *
 * 与 chat 的 ag-ui 协议统一技术栈：
 * - 使用 EventType 枚举（非字符串字面量）
 * - 使用 AgUiEventSink 类型签名（非 writeRaw 原始字符串）
 * - LLM token 流不走 CUSTOM 事件，改由 StreamEmitter 发射标准
 *   TEXT_MESSAGE_* / TOOL_CALL_* / STEP_* 事件（在 orchestrator 中实现）
 * - CUSTOM 事件只用于小说专属语义：阶段切换 / 检查点 / 编排进度
 */

import { EventType } from '@ag-ui/core'
import type { AgUiEventSink } from '@repo/protocol/events'

/**
 * 创建 ag-ui 兼容的 SSE 事件发射器
 *
 * 返回对象包含 emit 字段（AgUiEventSink），供 StreamEmitter 直接使用。
 */
export function createNovelAgUiEmitter(
  emit: AgUiEventSink,
  threadId: string,
  runId: string,
) {
  emit({ type: EventType.RUN_STARTED, threadId, runId })

  return {
    emit,
    threadId,
    runId,
    // 统一注入 timestamp: Date.now()，避免每个调用点手工塞
    // 前端 AgentOutput.timestamp / CreationFlowEvent.timestamp 依赖此字段
    progress: (data: unknown) => emit({
      type: EventType.CUSTOM,
      name: 'novel:progress',
      value: typeof data === 'object' && data !== null
        ? { timestamp: Date.now(), ...(data as Record<string, unknown>) }
        : data,
    }),
    checkpoint: (data: unknown) => emit({
      type: EventType.CUSTOM,
      name: 'novel:checkpoint',
      value: typeof data === 'object' && data !== null
        ? { timestamp: Date.now(), ...(data as Record<string, unknown>) }
        : data,
    }),
    result: (data: unknown) => {
      emit({
        type: EventType.CUSTOM,
        name: 'novel:result',
        value: typeof data === 'object' && data !== null
          ? { timestamp: Date.now(), ...(data as Record<string, unknown>) }
          : data,
      })
      emit({ type: EventType.RUN_FINISHED, threadId, runId })
    },
    // AG-UI 协议：错误流也必须以 RUN_FINISHED 结束，否则客户端无法判定流结束
    error: (message: string) => {
      emit({ type: EventType.RUN_ERROR, message })
      emit({ type: EventType.RUN_FINISHED, threadId, runId })
    },
  }
}

/**
 * 创建 SSE 写入适配器：把 AG-UI 事件序列化为 SSE data 行。
 *
 * 与 chat 的 /ag-ui/agent/{id}/run 端点使用相同的序列化格式，
 * 前端用共享的 parseSseStream 解析。
 */
export function createSseEmitterSink(writeRaw: (data: string) => void): AgUiEventSink {
  return (event) => {
    writeRaw(`data: ${JSON.stringify(event)}\n\n`)
  }
}
