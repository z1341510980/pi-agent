/**
 * 章节级自由聊天 Hook
 *
 * 在结构化创作流程（工作流/群聊）之外，提供章节级自由聊天能力：
 * - 切换章节时加载该章节的所有聊天历史（含创作流程中持久化的用户输入）
 * - 用户可随时发送消息与 Agent 对话，不影响创作流程
 * - 支持 @ 指定 Agent 或由 Moderator 自动调度
 * - SSE 流式接收 Agent 回复
 *
 * 与 use-novel-creation-flow 的区别：
 * - creationFlow 是结构化创作（Director → Writer → Reviewer → ...）
 * - chapterChat 是非结构化自由对话（用户问 → Agent 答）
 * - 两者共享 ChapterChatStore 持久化的消息历史
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listChapterChat,
  clearChapterChat,
  sendChapterChat,
  type ChapterChatMessage,
} from '@/api/novel-client'
import type { BaseEvent } from '@repo/protocol/events'

/** 自由聊天中 Agent 的流式输出 */
export interface ChatAgentOutput {
  agentId: string
  agentName: string
  agentType: string
  content: string
  preview: string
  timestamp: number
  /** 是否仍在流式生成中 */
  streaming?: boolean
  /** 关联的 AG-UI TEXT_MESSAGE_* 事件 messageId */
  messageId?: string
}

export interface UseChapterChatReturn {
  /** 该章节所有持久化的聊天消息（含创作流程 + 自由聊天） */
  messages: ChapterChatMessage[]
  /** 当前正在流式生成的 Agent 输出 */
  agentOutputs: ChatAgentOutput[]
  /** 是否正在运行（等待 Agent 回复） */
  isRunning: boolean
  /** 错误信息 */
  error: string | null
  /** 加载历史消息 */
  loadHistory: (projectId: string, chapterNumber: number) => Promise<void>
  /** 发送自由聊天消息 */
  sendMessage: (projectId: string, chapterNumber: number, message: string, mentionedAgents?: string[], modelId?: { provider: string; modelId: string; thinkingLevel?: import('../stores/session-store').ThinkingLevel | null } | null, styleExpertIds?: string[]) => Promise<void>
  /** 中断当前运行 */
  abort: () => void
  /** 清空章节聊天历史 */
  clearHistory: (projectId: string, chapterNumber: number) => Promise<void>
  /** 重置状态 */
  reset: () => void
}

export function useChapterChat(): UseChapterChatReturn {
  const [messages, setMessages] = useState<ChapterChatMessage[]>([])
  const [agentOutputs, setAgentOutputs] = useState<ChatAgentOutput[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  /** messageId → { agentId, agentName, agentType } 映射 */
  const messageAgentMapRef = useRef<Map<string, { agentId: string; agentName: string; agentType: string }>>(new Map())
  /** delta 批处理缓冲 */
  const deltaBufferRef = useRef<Map<string, string>>(new Map())
  const rafIdRef = useRef<number | null>(null)

  /** 调度一帧后的 flush */
  const scheduleDeltaFlush = useCallback(() => {
    if (rafIdRef.current !== null) return
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      const buffer = deltaBufferRef.current
      if (buffer.size === 0) return
      const entries = Array.from(buffer.entries())
      buffer.clear()

      setAgentOutputs((prev) => {
        let updated = prev
        for (const [messageId, delta] of entries) {
          const idx = updated.findIndex((o) => o.messageId === messageId)
          if (idx === -1) continue
          if (updated === prev) updated = [...prev]
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

  /** 处理单条 ag-ui 事件 */
  const handleEvent = useCallback(
    (event: BaseEvent): void => {
      switch (event.type) {
        case 'TEXT_MESSAGE_START': {
          const msg = event as { type: 'TEXT_MESSAGE_START'; messageId?: string; role?: string }
          if (!msg.messageId) return
          const meta = messageAgentMapRef.current.get(msg.messageId)
          if (!meta) return
          // 已存在则跳过（同一 messageId 的 START 只处理一次）
          setAgentOutputs((prev) => {
            if (prev.some((o) => o.messageId === msg.messageId)) return prev
            return [
              ...prev,
              {
                agentId: meta.agentId,
                agentName: meta.agentName,
                agentType: meta.agentType,
                content: '',
                preview: '',
                timestamp: Date.now(),
                streaming: true,
                messageId: msg.messageId,
              },
            ]
          })
          break
        }
        case 'TEXT_MESSAGE_CONTENT': {
          const msg = event as { type: 'TEXT_MESSAGE_CONTENT'; messageId?: string; delta?: string }
          if (!msg.messageId || !msg.delta) return
          deltaBufferRef.current.set(
            msg.messageId,
            (deltaBufferRef.current.get(msg.messageId) ?? '') + msg.delta,
          )
          scheduleDeltaFlush()
          break
        }
        case 'TEXT_MESSAGE_END': {
          const msg = event as { type: 'TEXT_MESSAGE_END'; messageId?: string }
          if (!msg.messageId) return
          // 标记该 Agent 输出完成
          setAgentOutputs((prev) =>
            prev.map((o) => (o.messageId === msg.messageId ? { ...o, streaming: false } : o)),
          )
          break
        }
        case 'CUSTOM': {
          const custom = event as { type: 'CUSTOM'; name?: string; value?: unknown }
          if (custom.name === 'novel:progress') {
            const value = custom.value as { type?: string; data?: unknown; phase?: string } | undefined
            // Agent 开始发言：记录 messageId → agent 元数据
            if (value?.type === 'agent_start') {
              const data = value.data as { agentName?: string; agentId?: string; agentType?: string; message?: string; messageId?: string } | undefined
              if (data?.messageId && data.agentId) {
                messageAgentMapRef.current.set(data.messageId, {
                  agentId: data.agentId,
                  agentName: data.agentName ?? data.agentId,
                  agentType: data.agentType ?? 'unknown',
                })
              }
            }
          } else if (custom.name === 'novel:result') {
            const value = custom.value as { status?: string; replies?: Array<{ agentId: string; agentName: string; agentType: string; content: string }> } | undefined
            if (value?.status === 'completed' && value.replies) {
              // 把最终回复同步到 messages（后端已持久化，这里只更新本地状态）
              // 实际上后端已经把 Agent 回复存入 ChapterChatStore，
              // 这里只标记流程完成，messages 由调用方重新 loadHistory 刷新
            }
          }
          break
        }
        case 'RUN_FINISHED': {
          setIsRunning(false)
          // flush 残留 delta
          if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current)
            rafIdRef.current = null
          }
          if (deltaBufferRef.current.size > 0) {
            const entries = Array.from(deltaBufferRef.current.entries())
            deltaBufferRef.current.clear()
            setAgentOutputs((prev) => {
              let updated = prev
              for (const [messageId, delta] of entries) {
                const idx = updated.findIndex((o) => o.messageId === messageId)
                if (idx === -1) continue
                if (updated === prev) updated = [...prev]
                const newContent = updated[idx].content + delta
                updated[idx] = { ...updated[idx], content: newContent, preview: newContent.slice(-200) }
              }
              return updated
            })
          }
          break
        }
        case 'RUN_ERROR': {
          const msg = event as { type: 'RUN_ERROR'; message?: string }
          setError(msg.message ?? '章节聊天失败')
          setIsRunning(false)
          break
        }
      }
    },
    [scheduleDeltaFlush],
  )

  /** 加载章节聊天历史 */
  const loadHistory = useCallback(async (projectId: string, chapterNumber: number) => {
    try {
      const history = await listChapterChat(projectId, chapterNumber)
      setMessages(history)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载聊天历史失败')
    }
  }, [])

  /** 发送自由聊天消息 */
  const sendMessage = useCallback(
    async (projectId: string, chapterNumber: number, message: string, mentionedAgents?: string[], modelId?: { provider: string; modelId: string; thinkingLevel?: import('../stores/session-store').ThinkingLevel | null } | null, styleExpertIds?: string[]) => {
      if (abortControllerRef.current) return // 并发保护

      const trimmed = message.trim()
      if (!trimmed) return

      // 重置流式状态
      setAgentOutputs([])
      setError(null)
      messageAgentMapRef.current.clear()
      deltaBufferRef.current.clear()
      setIsRunning(true)

      const controller = new AbortController()
      abortControllerRef.current = controller

      // 乐观追加用户消息到本地列表
      const optimisticUserMsg: ChapterChatMessage = {
        id: `temp-user-${Date.now()}`,
        projectId,
        chapterNumber,
        role: 'user',
        fromId: 'user',
        fromName: '用户',
        content: trimmed,
        phase: 'free_chat',
        metadata: { mentionedAgents, styleExpertIds } as any,
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, optimisticUserMsg])

      try {
        await sendChapterChat(projectId, chapterNumber, trimmed, mentionedAgents, {
          onEvent: handleEvent,
          signal: controller.signal,
           modelId: modelId ?? undefined,
          styleExpertIds,
        })

        // SSE 流结束后，重新加载历史以获取后端持久化的 Agent 回复
        // （后端在 Agent 发言后立即写入 ChapterChatStore）
        await loadHistory(projectId, chapterNumber)
      } catch (err) {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : '发送消息失败')
      } finally {
        abortControllerRef.current = null
        setIsRunning(false)
      }
    },
    [handleEvent, loadHistory],
  )

  /** 中断当前运行 */
  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
      setIsRunning(false)
    }
  }, [])

  /** 清空章节聊天历史 */
  const clearHistory = useCallback(async (projectId: string, chapterNumber: number) => {
    try {
      await clearChapterChat(projectId, chapterNumber)
      setMessages([])
      setAgentOutputs([])
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空聊天历史失败')
    }
  }, [])

  /** 重置状态 */
  const reset = useCallback(() => {
    setMessages([])
    setAgentOutputs([])
    setError(null)
    setIsRunning(false)
    messageAgentMapRef.current.clear()
    deltaBufferRef.current.clear()
  }, [])

  // 卸载时取消进行中的请求
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [])

  return {
    messages,
    agentOutputs,
    isRunning,
    error,
    loadHistory,
    sendMessage,
    abort,
    clearHistory,
    reset,
  }
}
