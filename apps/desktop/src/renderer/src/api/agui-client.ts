import { browserConfig } from '@repo/config/browser'
import type { BaseEvent } from '@repo/protocol/events'
import type { AgentMessage } from '@repo/shared/agent'

export interface RunAgentOptions {
  threadId: string
  /** runId：若未传入则自动生成 */
  runId?: string
  messages: AgentMessage[]
  /** AbortSignal：用于中断 run */
  signal?: AbortSignal
  /** AG-UI 事件回调 */
  onEvent: (event: BaseEvent) => void
  /** 错误回调（网络错误、非 2xx 响应等） */
  onError?: (error: Error) => void
  /** 流结束回调（无论成功/失败/中断都会调用） */
  onDone?: () => void
}

/**
 * 发起 AG-UI run 请求，解析 SSE 流并分发事件。
 *
 * 端点：POST {aguiBaseUrl}/ag-ui/agent/{agentId}/run
 * 后端会发射 AG-UI 事件（RUN_STARTED → TEXT_MESSAGE_* → ... → RUN_FINISHED/RUN_ERROR）
 */
export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { threadId, messages, signal, onEvent, onError, onDone } = options
  const runId = options.runId ?? crypto.randomUUID()
  const agentId = 'default'

  try {
    const response = await fetch(
      `${browserConfig.aguiBaseUrl}/ag-ui/agent/${agentId}/run`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId,
          runId,
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
          })),
        }),
        signal,
      },
    )

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(
        `AG-UI 请求失败: HTTP ${response.status}${errorText ? ` - ${errorText}` : ''}`,
      )
    }

    if (!response.body) {
      throw new Error('AG-UI 响应体为空')
    }

    await parseSseStream(response.body, onEvent)
  } catch (error) {
    // abort 不视为错误
    if (error instanceof DOMException && error.name === 'AbortError') {
      return
    }
    onError?.(error instanceof Error ? error : new Error(String(error)))
  } finally {
    onDone?.()
  }
}

/**
 * 解析 SSE 流，提取 `data: {json}` 行并分发为 AG-UI 事件。
 *
 * SSE 格式：
 *   data: {"type":"RUN_STARTED",...}\n\n
 *   : keepalive\n\n  （注释行，跳过）
 */
async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: BaseEvent) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // 按 SSE 事件边界分割
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        const event = parseSseChunk(chunk)
        if (event) onEvent(event)
      }
    }

    // 处理缓冲区中剩余的数据
    if (buffer.trim()) {
      const event = parseSseChunk(buffer)
      if (event) onEvent(event)
    }
  } finally {
    reader.releaseLock()
  }
}

/** 解析单个 SSE chunk，提取 data 行并 JSON.parse */
function parseSseChunk(chunk: string): BaseEvent | null {
  const lines = chunk.split('\n')
  // 找到 data: 行（可能有多个 data: 行，按 SSE 规范应拼接）
  const dataLines = lines.filter((line) => line.startsWith('data: '))
  if (dataLines.length === 0) return null

  // 拼接所有 data: 行的内容
  const json = dataLines.map((line) => line.replace(/^data:\s*/, '')).join('\n')

  try {
    return JSON.parse(json) as BaseEvent
  } catch {
    // 忽略解析失败的行
    return null
  }
}
