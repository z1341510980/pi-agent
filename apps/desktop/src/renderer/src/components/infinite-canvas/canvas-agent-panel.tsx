import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Bot, Send, Square, X } from 'lucide-react'

import type { BaseEvent } from '@repo/protocol/events'
import { EventType } from '@repo/protocol/events'
import type { AgentMessage } from '@repo/shared/agent'
import { useStreamingRun } from '@/hooks/use-streaming-run'
import type { CanvasTheme } from './canvas-theme'

export interface CanvasAgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export interface CanvasAgentPanelProps {
  theme: CanvasTheme
  projectId: string
  projectTitle: string
  selectedNodeIds: string[]
  nodeCount: number
  onClose: () => void
  /** Agent 可能通过 canvas_* 工具改库；run 结束后刷新本地图。 */
  onRefresh: () => void
}

/**
 * 参考项目「画布助手」的桌面适配：复用宿主 AG-UI 会话。
 * 服务端 session factory 已注入 canvas_get_state / canvas_apply_ops 等
 * 无限画布工具，Agent 可直接读写 SQLite 里的画布数据。
 */
export function CanvasAgentPanel({
  theme,
  projectId,
  projectTitle,
  selectedNodeIds,
  nodeCount,
  onClose,
  onRefresh
}: CanvasAgentPanelProps): ReactElement {
  const threadId = `canvas-agent-${projectId}`
  const [messages, setMessages] = useState<CanvasAgentMessage[]>([])
  const [draft, setDraft] = useState('')
  const [toolActive, setToolActive] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const streamingRef = useRef('')

  const appendAssistantDelta = useCallback((delta: string): void => {
    setMessages((current) => {
      const last = current[current.length - 1]
      if (last?.role === 'assistant' && last.id === 'streaming') {
        return [...current.slice(0, -1), { ...last, content: last.content + delta }]
      }
      return [
        ...current.filter((item) => item.id !== 'streaming'),
        { id: 'streaming', role: 'assistant', content: streamingRef.current + delta }
      ]
    })
    streamingRef.current += delta
  }, [])

  const handleEvent = useCallback(
    (event: BaseEvent): void => {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        appendAssistantDelta(String((event as { delta?: string }).delta ?? ''))
        return
      }
      if (event.type === EventType.TOOL_CALL_START) {
        setToolActive(true)
        return
      }
      if (event.type === EventType.TOOL_CALL_END || event.type === EventType.TOOL_CALL_RESULT) {
        setToolActive(false)
      }
    },
    [appendAssistantDelta]
  )

  const handleFinished = useCallback((): void => {
    setMessages((current) =>
      current.map((message) =>
        message.id === 'streaming' ? { ...message, id: `assistant-${Date.now()}` } : message
      )
    )
    streamingRef.current = ''
    setToolActive(false)
    onRefresh()
  }, [onRefresh])

  const handleError = useCallback((): void => {
    setMessages((current) => [
      ...current.map((message) =>
        message.id === 'streaming' ? { ...message, id: `assistant-error-${Date.now()}` } : message
      ),
      { id: `error-${Date.now()}`, role: 'assistant', content: '本次请求失败，请稍后重试。' }
    ])
    streamingRef.current = ''
    setToolActive(false)
  }, [])

  const { run, abort, isRunning } = useStreamingRun({
    threadId,
    onEvent: handleEvent,
    onFinished: handleFinished,
    onError: handleError
  })

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const send = (): void => {
    const text = draft.trim()
    if (!text || isRunning) return
    const selectionHint = selectedNodeIds.length
      ? `当前选中节点：${selectedNodeIds.join(', ')}`
      : '当前没有选中节点'
    const contextPrefix = `[画布上下文 | 项目ID: ${projectId} | 标题: ${projectTitle} | 节点数: ${nodeCount} | ${selectionHint}]\n`
    const userMessage: CanvasAgentMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text
    }
    setMessages((current) => [...current, userMessage])
    setDraft('')
    streamingRef.current = ''
    void run([
      { id: crypto.randomUUID(), role: 'user', content: contextPrefix + text } as AgentMessage
    ])
  }

  return (
    <aside
      className="flex w-[340px] shrink-0 flex-col border-l"
      style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
      data-canvas-no-zoom
    >
      <div
        className="flex h-14 shrink-0 items-center justify-between border-b px-3"
        style={{ borderColor: theme.toolbar.border }}
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Bot className="size-4" />
          画布助手
        </span>
        <button
          type="button"
          onClick={isRunning ? abort : onClose}
          className="grid size-7 place-items-center rounded-lg opacity-55 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
        >
          {isRunning ? <Square className="size-3.5" /> : <X className="size-4" />}
        </button>
      </div>
      <div
        ref={scrollRef}
        className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3"
        onWheel={(event) => event.stopPropagation()}
      >
        {!messages.length && (
          <p className="px-2 py-6 text-center text-xs leading-5 opacity-55">
            让助手整理节点、批量创建内容或调整布局。
            <br />
            它会直接操作当前画布并保存。
          </p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
          >
            <div
              className="max-w-[92%] rounded-xl px-3 py-2 text-xs leading-5 whitespace-pre-wrap break-words"
              style={{
                background: message.role === 'user' ? theme.toolbar.activeBg : theme.node.fill,
                color: message.role === 'user' ? theme.toolbar.activeText : theme.node.text
              }}
            >
              {message.content || (toolActive ? '正在操作画布…' : '…')}
            </div>
          </div>
        ))}
        {isRunning && !messages.some((message) => message.id === 'streaming') && (
          <div className="flex justify-start">
            <div
              className="rounded-xl px-3 py-2 text-xs opacity-60"
              style={{ background: theme.node.fill }}
            >
              {toolActive ? '正在调用画布工具…' : '思考中…'}
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t p-2" style={{ borderColor: theme.toolbar.border }}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          placeholder="向助手描述要做的画布改动…"
          className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-xs leading-5 outline-none"
          style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10px] opacity-45">Enter 发送 · Shift+Enter 换行</span>
          <button
            type="button"
            disabled={!isRunning && !draft.trim()}
            onClick={() => (isRunning ? abort() : send())}
            className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-35"
            style={{
              background: isRunning ? '#b91c1c' : theme.toolbar.activeBg,
              color: isRunning ? '#fff' : theme.toolbar.activeText
            }}
          >
            {isRunning ? (
              <>
                <Square className="size-3 fill-current" />
                停止
              </>
            ) : (
              <>
                <Send className="size-3.5" />
                发送
              </>
            )}
          </button>
        </div>
      </div>
    </aside>
  )
}
