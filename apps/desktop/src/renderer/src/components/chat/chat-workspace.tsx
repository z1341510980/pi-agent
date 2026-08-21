import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { BrowserConfig } from '@repo/config/shared'
import type { BaseEvent } from '@repo/protocol/events'
import { Button } from '@/components/ui/button'
import { getApi, getAgui, postAgui, putApi } from '../../api'
import { useWebSocket } from '@/hooks/use-websocket'
import { useToolExecutions } from '@/hooks/use-tool-executions'
import { useStreamingRun } from '@/hooks/use-streaming-run'
import { useRealtimeEvents } from '@/hooks/use-realtime-events'
import { useChatShortcuts } from '@/hooks/use-chat-shortcuts'
import { usePaginatedMessages } from '@/hooks/use-paginated-messages'
import { usePinnedSessions } from '@/hooks/use-pinned-sessions'
import { toast } from '@/hooks/use-toast'
import { useTheme } from '@/components/theme-provider'
import { type PermissionMode } from './permission-mode-switch'
import { MessageStream, applyEvent, type MessageStreamState } from './message-stream'
import { InputArea } from './input-area'
import { SessionList, type SessionSummary } from './session-list'
import { WorkspaceIndicator } from './workspace-indicator'
import { FilePreviewPanel } from './file-preview-panel'
import { NotificationCenter } from '../overlays/notification-center'
import { DevLogPanel } from '../overlays/devlog-panel'
import { CommandPalette, createDefaultCommands } from '../overlays/command-palette'
import { CompactionBanner, type CompactionEvent } from './compaction-banner'
import { ResizableSplitter } from '@/components/ui/resizable-splitter'
import {
  ContextPanel,
  type AssociatedFile,
  type MemorySummaryData,
  type ActivityEntry
} from './context-panel'
import { UsagePanel } from './usage-panel'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { type ModelOption, type ThinkingLevel } from './model-selector'
import { createUserMessage, collectToolCalls, type ChatMessage, type FileAttachment } from './types'
import {
  useSessionStore,
  createEmptyMessageState,
  upsertSessionAfterSend,
  MAX_QUEUE_LENGTH
} from '@/stores/session-store'
import { useUIStore } from '@/stores/ui-store'
import { ChatTitleEditor } from './chat-title-editor'
import { AgentSwitcher } from './agent-switcher'
import { AgentDetailCard } from './agent-detail-card'
import { CommandQueuePanel } from './command-queue-panel'
import { RightPanelTabs } from './right-panel-tabs'
import { SlotRenderer } from '../slot'
import { FileReferenceProvider } from './file-reference-context'
import type { FileReference } from '@/lib/file-reference'
import { useActiveAgent } from '@/hooks/use-active-agent'

type HealthData = {
  service: string
  status: string
}

type GateData = {
  mode: PermissionMode
}

type ChatWorkspaceProps = {
  appName: string
  config: BrowserConfig
  onOpenSettings?: () => void
}

type CompactThreadResponse = {
  status: string
  threadId: string
  result: unknown
}

/** 权限模式循环顺序 */
const PERMISSION_MODE_ORDER: PermissionMode[] = ['auto', 'plan', 'readonly', 'full']

/** 权限模式展示文案 */
const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  auto: '自动',
  plan: '计划',
  readonly: '只读',
  full: '完全控制'
}

export function ChatWorkspace({
  appName: _appName,
  config: _config,
  onOpenSettings
}: ChatWorkspaceProps): ReactElement {
  const queryClient = useQueryClient()

  // ── Zustand stores ──
  const sessions = useSessionStore((s) => s.sessions)
  const activeThreadId = useSessionStore((s) => s.activeThreadId)
  const sessionMessages = useSessionStore((s) => s.sessionMessages)
  const drafts = useSessionStore((s) => s.drafts)
  const selectedModel = useSessionStore((s) => s.selectedModel)
  const selectedThinkingLevels = useSessionStore((s) => s.selectedThinkingLevels)
  const setSelectedThinkingLevel = useSessionStore((s) => s.setSelectedThinkingLevel)
  const removeSessionThinkingLevel = useSessionStore((s) => s.removeSessionThinkingLevel)
  const compactionCount = useSessionStore((s) => s.compactionCount)
  const activeAgentId = useSessionStore((s) => s.activeAgentId)
  const setSessions = useSessionStore((s) => s.setSessions)
  const setActiveAgentId = useSessionStore((s) => s.setActiveAgentId)
  const { assistant: activeAssistant, allAssistants } = useActiveAgent()
  const setActiveThreadId = useSessionStore((s) => s.setActiveThreadId)
  const updateSessionMessages = useSessionStore((s) => s.updateSessionMessages)
  const setDraft = useSessionStore((s) => s.setDraft)
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel)
  const incrementCompactionCount = useSessionStore((s) => s.incrementCompactionCount)
  const removeSession = useSessionStore((s) => s.removeSession)
  const upsertSession = useSessionStore((s) => s.upsertSession)

  // ── 待发队列 ──
  const commandQueues = useSessionStore((s) => s.commandQueues)
  const enqueueCommand = useSessionStore((s) => s.enqueueCommand)
  const shiftCommand = useSessionStore((s) => s.shiftCommand)
  const removeCommand = useSessionStore((s) => s.removeCommand)
  const updateCommandText = useSessionStore((s) => s.updateCommandText)
  const reorderQueue = useSessionStore((s) => s.reorderQueue)
  const clearQueue = useSessionStore((s) => s.clearQueue)

  const setRightPanel = useUIStore((s) => s.setRightPanel)
  const devLogOpen = useUIStore((s) => s.devLogOpen)
  const setDevLogOpen = useUIStore((s) => s.setDevLogOpen)
  const toggleDevLog = useUIStore((s) => s.toggleDevLog)
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen)
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen)
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette)
  const leftPanelOpen = useUIStore((s) => s.leftPanelOpen)
  const toggleLeftPanel = useUIStore((s) => s.toggleLeftPanel)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const filePreview = useUIStore((s) => s.filePreview)
  const openFilePreview = useUIStore((s) => s.openFilePreview)
  const closeFilePreview = useUIStore((s) => s.closeFilePreview)

  // ── 置顶会话（用于命令面板快捷切换）──
  const { pinnedOrder } = usePinnedSessions()
  const pinnedSessions = useMemo(
    () =>
      pinnedOrder
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is SessionSummary => Boolean(s)),
    [pinnedOrder, sessions]
  )

  // ── 本地 UI 状态（无需持久化） ──
  const [compactionEvent, setCompactionEvent] = useState<CompactionEvent | null>(null)
  const [usageDetailOpen, setUsageDetailOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [rightPanelWidth, setRightPanelWidth] = useState(320)
  /**
   * 右栏当前选中的插件 tab（null = 宿主的上下文面板）。
   *
   * 右栏从"二元切换"改为 tab registry：宿主的 Context 始终可用，文件预览仍是
   * 临时覆盖，插件贡献作为可移除项插入（研究文档 §10.6 / §10.13）。
   */
  const [rightPanelTab, setRightPanelTab] = useState<string | null>(null)

  const messageState: MessageStreamState =
    sessionMessages[activeThreadId] ?? createEmptyMessageState()

  const activeSession = sessions.find((s) => s.id === activeThreadId)

  // 当前权限模式（状态栏展示用）
  const gateQuery = useQuery({
    queryKey: ['gate'],
    queryFn: () => getApi<GateData>('/api/gate'),
    refetchInterval: 10_000
  })

  const healthQuery = useQuery({
    queryKey: ['agent-server-health'],
    queryFn: () => getApi<HealthData>('/api/health'),
    refetchInterval: 10_000
  })

  // 当前工作区信息
  const workspaceQuery = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      getApi<{ path: string; name: string; gitBranch?: string; gitDirty?: boolean }>(
        '/api/workspace'
      ),
    refetchInterval: 30_000
  })

  // 当前会话的记忆摘要
  const memorySummaryQuery = useQuery({
    queryKey: ['memory-summary', activeThreadId],
    queryFn: () => getApi<MemorySummaryData | null>(`/api/memory/summaries/${activeThreadId}`),
    refetchInterval: 30_000
  })

  // 已注册模型列表（供模型选择器使用）
  const modelsQuery = useQuery({
    queryKey: ['agui-models'],
    queryFn: async () => {
      const res = await getAgui<{ threadId: string; models: ModelOption[] }>(
        '/ag-ui/agent/default/models?threadId=main'
      )
      return res.models ?? []
    },
    refetchInterval: 60_000
  })

  const { executions, onMessage: onToolMessage } = useToolExecutions()

  // 实时事件管理（通知、DevLog、用量、上下文）
  const {
    notifications,
    devLogs,
    addNotification,
    dismissNotification,
    dismissAllNotifications,
    addDevLog,
    clearDevLogs,
    addUsageUpdate,
    contextState,
    addContextUpdate,
    resetContextState
  } = useRealtimeEvents()

  // 切换线程时重置上下文状态
  useEffect(() => {
    resetContextState()
  }, [activeThreadId, resetContextState])

  const { pendingConfirmations, respondConfirmation } = useWebSocket({
    threadId: activeThreadId,
    onMessage: onToolMessage,
    onNotification: addNotification,
    onDevLog: addDevLog,
    onUsageUpdate: addUsageUpdate,
    onContextUpdate: addContextUpdate
  })

  // AG-UI 事件 → 消息流状态
  const handleAguiEvent = useCallback(
    (event: BaseEvent) => {
      updateSessionMessages(activeThreadId, (prev) => applyEvent(prev, event))
    },
    [activeThreadId, updateSessionMessages]
  )

  // 读取全局默认温度（从 localStorage，由设置页 agent-config 配置）
  const globalTemperature = useMemo(() => {
    try {
      const saved = window.localStorage.getItem('wenlang-agent.agent-config')
      if (saved) {
        const parsed = JSON.parse(saved) as { temperature?: number }
        if (typeof parsed.temperature === 'number') return parsed.temperature
      }
    } catch {
      /* ignore */
    }
    return undefined
  }, [])

  const {
    run,
    abort,
    isRunning,
    error: runError
  } = useStreamingRun({
    threadId: activeThreadId,
    onEvent: handleAguiEvent,
    model: selectedModel ?? undefined,
    agentId: activeAgentId,
    temperature: globalTemperature
  })

  // ── 分页加载历史消息（流式运行时禁用，避免冲突） ──
  const {
    messages: historicalMessages,
    hasMore: historicalHasMore,
    isLoadingMore: historicalIsLoadingMore,
    isLoadingInitial: historicalIsLoadingInitial,
    loadMore: loadMoreHistory
  } = usePaginatedMessages(activeThreadId, { enabled: !isRunning })

  // ── 合并历史消息与本地流式消息 ──
  // - 历史消息从服务器拉取（按时间正序）
  // - 本地消息包含正在流式的助手消息（更优先，内容最新）
  // - 按 ID 去重：若历史消息与本地消息 ID 相同，丢弃历史版本
  const mergedMessages = useMemo(() => {
    if (historicalMessages.length === 0) return messageState.messages
    if (messageState.messages.length === 0) return historicalMessages
    const localIds = new Set(messageState.messages.map((m) => m.id))
    const dedupedHistorical = historicalMessages.filter((m) => !localIds.has(m.id))
    return [...dedupedHistorical, ...messageState.messages]
  }, [historicalMessages, messageState.messages])

  // ── 从上下文状态获取 contextWindow（由 context:update 实时事件推送，来自 modelRegistry）──
  // 当 contextState.contextWindow > 0 时使用实时值，否则回退到模型列表查询
  const currentContextWindow = useMemo(() => {
    if (contextState.contextWindow > 0) return contextState.contextWindow
    if (!selectedModel) return 32768
    const model = modelsQuery.data?.find(
      (m) => m.provider === selectedModel.provider && m.id === selectedModel.modelId
    )
    return model?.contextWindow ?? 32768
  }, [contextState.contextWindow, selectedModel, modelsQuery.data])

  // ── 从消息流中提取关联文件（工具调用涉及的文件路径） ──
  const associatedFiles = useMemo<AssociatedFile[]>(() => {
    const PATH_KEYS = ['path', 'filePath', 'file_path', 'filename', 'file']
    const files: AssociatedFile[] = []
    for (const msg of messageState.messages) {
      for (const tc of collectToolCalls(msg)) {
        if (!tc.args || typeof tc.args !== 'object') continue
        const args = tc.args as Record<string, unknown>
        for (const key of PATH_KEYS) {
          const val = args[key]
          if (typeof val === 'string' && val.length > 0) {
            files.push({
              path: val,
              toolName: tc.toolName,
              timestamp: tc.startedAt ?? msg.createdAt ?? Date.now()
            })
            break
          }
        }
      }
    }
    return files
  }, [messageState.messages])

  // ── 将 DevLog 转换为活动日志条目 ──
  const activities = useMemo<ActivityEntry[]>(() => {
    return devLogs.map((log) => ({
      label: log.message,
      timestamp: log.timestamp
    }))
  }, [devLogs])

  const handleSend = useCallback(
    (text: string, attachments?: FileAttachment[]) => {
      const userMsg = createUserMessage(text, attachments)
      updateSessionMessages(activeThreadId, (prev) => ({
        ...prev,
        messages: [...prev.messages, userMsg]
      }))
      setSessions(upsertSessionAfterSend(sessions, activeThreadId, text))

      // 将附件内容注入到消息 content 中（AG-UI 协议只传 content 字符串）
      const enrichedMsg = { ...userMsg }
      if (attachments && attachments.length > 0) {
        const attachmentParts = attachments
          .filter((a) => a.content && a.encoding === 'utf-8')
          .map((a) => `\n--- 附件: ${a.name} ---\n${a.content}`)
          .join('\n')
        if (attachmentParts) {
          enrichedMsg.content = `${text}\n${attachmentParts}`
        }
      }

      void run([enrichedMsg])
    },
    [activeThreadId, run, updateSessionMessages, sessions, setSessions]
  )

  /**
   * 输入区提交入口。
   *
   * 忙的时候转成入队而不是丢弃 —— 用户想到的后续指令不该因为"正在生成"而消失。
   * 之前这里的行为是：`handleSend` 里 `if (isRunning) return` 直接吞掉，
   * 而 Enter 键更糟，是 `if (isRunning) onAbort()` 把生成杀掉。
   */
  const handleSubmit = useCallback(
    (text: string, attachments?: FileAttachment[]) => {
      if (!isRunning) {
        handleSend(text, attachments)
        return
      }
      const result = enqueueCommand(activeThreadId, text, attachments)
      if (result.ok) {
        toast({ variant: 'info', title: '已加入待发队列', description: '当前轮结束后自动发送' })
        return
      }
      if (result.reason === 'queue-full') {
        toast({
          variant: 'warning',
          title: '待发队列已满',
          description: `最多排 ${MAX_QUEUE_LENGTH} 条，先发出或清理几条再来`
        })
      } else if (result.reason === 'too-long') {
        toast({ variant: 'warning', title: '这条太长了', description: '排队消息请控制在 2 万字以内' })
      }
    },
    [isRunning, handleSend, enqueueCommand, activeThreadId]
  )

  /** 推进队列：取队首发出去 */
  const drainQueue = useCallback(() => {
    const next = shiftCommand(activeThreadId)
    if (!next) return
    handleSend(next.text, next.attachments)
  }, [shiftCommand, activeThreadId, handleSend])

  const handleAbort = useCallback(() => {
    // 优先关闭已打开的浮层（命令面板 / DevLog），再考虑中断流式
    if (commandPaletteOpen) {
      setCommandPaletteOpen(false)
      return
    }
    if (devLogOpen) {
      setDevLogOpen(false)
      return
    }
    abort()
  }, [abort, commandPaletteOpen, setCommandPaletteOpen, devLogOpen, setDevLogOpen])

  /**
 * 切换当前 thread 的思考强度
 * - null 表示清除显式设置（透传请求层默认）
 * - 切换成功后清掉该 thread 对应的 PiSession 缓存（后端负责），下次请求按新 level 重建 Session
 * - 乐观更新：先写 store，再异步调后端；失败时回滚并 toast 报错
 */
  const handleThinkingLevelChange = useCallback(
    async (threadId: string, level: ThinkingLevel | null) => {
      const prev = selectedThinkingLevels[threadId] ?? null
      setSelectedThinkingLevel(threadId, level)
      try {
        if (level === null) {
          // 清除显式设置：当前设计不向后端发送（与 ProviderConfigStore
          // defaultReasoningEffort='auto' 等价）；UI 仍然更新本地 store。
          // TODO: 未来若需要"完全清除后端持久化"，再加 DELETE 端点。
          return
        }
        await postAgui('/ag-ui/agent/default/threads/:threadId/thinking-level', {
          threadId,
          level,
        }).catch(() => null) // best-effort：失败时已存 store，下次刷新会重新拉取
      } catch (error) {
        setSelectedThinkingLevel(threadId, prev)
        toast.error('设置思考强度失败', error instanceof Error ? error.message : '未知错误')
      }
    },
    [selectedThinkingLevels, setSelectedThinkingLevel],
  )

  const handleCompact = useCallback(async () => {
    const eventId = crypto.randomUUID()
    setCompactionEvent({
      id: eventId,
      timestamp: Date.now(),
      reason: 'manual',
      state: 'running'
    })
    try {
      await postAgui<CompactThreadResponse>('/ag-ui/agent/default/compact', {
        threadId: activeThreadId
      })
      setCompactionEvent((prev) =>
        prev
          ? {
              ...prev,
              state: 'success',
              timestamp: Date.now()
            }
          : null
      )
      incrementCompactionCount()
      toast.success('上下文已压缩', '当前会话的上下文已成功压缩')
    } catch (error) {
      const message = error instanceof Error ? error.message : '上下文压缩失败。'
      setCompactionEvent((prev) =>
        prev
          ? {
              ...prev,
              state: 'error',
              errorMessage: message,
              timestamp: Date.now()
            }
          : null
      )
      toast.error('压缩失败', message)
    }
  }, [activeThreadId, incrementCompactionCount])

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messageState.messages].reverse().find((m) => m.role === 'user')
    if (lastUserMsg) {
      void run([lastUserMsg as ChatMessage])
    }
    updateSessionMessages(activeThreadId, (prev) => ({
      ...prev,
      streamError: null,
      // 移除最后一条错误的助手消息
      messages: prev.messages.filter((m) => !(m.role === 'assistant' && m.status === 'error'))
    }))
  }, [messageState.messages, run, updateSessionMessages, activeThreadId])

  const handleDismissError = useCallback(() => {
    updateSessionMessages(activeThreadId, (prev) => ({ ...prev, streamError: null }))
  }, [activeThreadId, updateSessionMessages])

  /**
   * 引用消息到输入框。
   *
   * MessageHoverActions 已经把文本转成了 `> ` 前缀的引用块，这里只负责拼进草稿。
   * 引用块后面留一个空行，让用户直接接着写而不必先自己换行。
   */
  const handleQuote = useCallback(
    (quoted: string) => {
      const current = drafts[activeThreadId] ?? ''
      const prefix = current.trim().length > 0 ? `${current.replace(/\n+$/, '')}\n\n` : ''
      setDraft(activeThreadId, `${prefix}${quoted}\n\n`)
      // 与 mod+/ 走同一个聚焦入口
      window.requestAnimationFrame(() => document.getElementById('message-input')?.focus())
    },
    [activeThreadId, drafts, setDraft]
  )

  /**
   * 重新生成助手回答。
   *
   * MessageStream 只把这个回调传给最后一条助手消息，所以这里可以安全地
   * 截断本地消息（丢掉这条回答及其之后的内容），不会在中间留下并排的两个回答。
   */
  const handleRegenerate = useCallback(
    (message: ChatMessage) => {
      if (isRunning) return
      const idx = mergedMessages.findIndex((m) => m.id === message.id)
      if (idx < 0) return

      // 往前找最近的一条用户消息作为重跑的输入
      let userMsg: ChatMessage | undefined
      for (let i = idx - 1; i >= 0; i--) {
        if (mergedMessages[i].role === 'user') {
          userMsg = mergedMessages[i]
          break
        }
      }
      if (!userMsg) return

      updateSessionMessages(activeThreadId, (prev) => {
        const localIdx = prev.messages.findIndex((m) => m.id === message.id)
        // 目标只存在于历史（服务端 JSONL）时删不掉，此时仅清错误后重跑
        if (localIdx < 0) return { ...prev, streamError: null }
        return { ...prev, streamError: null, messages: prev.messages.slice(0, localIdx) }
      })
      void run([userMsg])
    },
    [isRunning, mergedMessages, activeThreadId, updateSessionMessages, run]
  )

  const handleNewSession = useCallback(() => {
    const id = crypto.randomUUID()
    const ts = Date.now()
    const session: SessionSummary = {
      id,
      title: '新会话',
      preview: '准备开始对话',
      createdAt: ts,
      updatedAt: ts,
      agentId: activeAgentId
    }
    upsertSession(session)
    updateSessionMessages(id, () => createEmptyMessageState())
    setActiveThreadId(id)
  }, [upsertSession, updateSessionMessages, setActiveThreadId, activeAgentId])

  const handleRenameSession = useCallback(
    (id: string, newTitle: string) => {
      setSessions(
        sessions.map((s) => (s.id === id ? { ...s, title: newTitle, updatedAt: Date.now() } : s))
      )
    },
    [sessions, setSessions]
  )

  const handleDeleteSession = useCallback(
    (id: string) => {
      const remaining = sessions.filter((s) => s.id !== id)
      // 如果删除的是当前会话，切换到第一个
      if (id === activeThreadId && remaining.length > 0) {
        setActiveThreadId(remaining[0].id)
      }
      removeSession(id)
      // 同步清理该 thread 在 store 中的思考强度（避免 localStorage 残留）
      removeSessionThinkingLevel(id)
      toast.success('会话已删除')
    },
    [sessions, activeThreadId, setActiveThreadId, removeSession, removeSessionThinkingLevel]
  )

  // 上/下一会话（按 sessions 数组顺序循环）
  const handlePrevSession = useCallback(() => {
    if (sessions.length === 0) return
    const idx = sessions.findIndex((s) => s.id === activeThreadId)
    if (idx === -1) return
    const prevIdx = (idx - 1 + sessions.length) % sessions.length
    setActiveThreadId(sessions[prevIdx].id)
  }, [sessions, activeThreadId, setActiveThreadId])

  const handleNextSession = useCallback(() => {
    if (sessions.length === 0) return
    const idx = sessions.findIndex((s) => s.id === activeThreadId)
    if (idx === -1) return
    const nextIdx = (idx + 1) % sessions.length
    setActiveThreadId(sessions[nextIdx].id)
  }, [sessions, activeThreadId, setActiveThreadId])

  // 聚焦输入框
  const handleFocusInput = useCallback(() => {
    document.getElementById('message-input')?.focus()
  }, [])

  // 切换权限模式（循环 auto → plan → readonly → auto）
  const handleTogglePermissionMode = useCallback(async () => {
    try {
      const gate = await getApi<GateData>('/api/gate')
      const idx = PERMISSION_MODE_ORDER.indexOf(gate.mode)
      const next = PERMISSION_MODE_ORDER[(idx + 1) % PERMISSION_MODE_ORDER.length]
      await putApi<GateData>('/api/gate/mode', { mode: next })
      void queryClient.invalidateQueries({ queryKey: ['gate'] })
    } catch {
      // 忽略错误（快捷键静默失败）
    }
  }, [queryClient])

  // 删除当前会话（带确认）
  const handleDeleteCurrentSession = useCallback(() => {
    if (sessions.length === 0) {
      toast.warning('没有可删除的会话')
      return
    }
    const active = sessions.find((s) => s.id === activeThreadId)
    const title = active?.title ?? '当前会话'
    const confirmed = window.confirm(`确定要删除「${title}」吗？此操作无法恢复。`)
    if (confirmed) {
      handleDeleteSession(activeThreadId)
    }
  }, [sessions, activeThreadId, handleDeleteSession])

  // 清空当前会话消息（带确认）
  const handleClearMessages = useCallback(() => {
    const confirmed = window.confirm('确定要清空当前会话的所有消息吗？此操作无法恢复。')
    if (confirmed) {
      updateSessionMessages(activeThreadId, () => createEmptyMessageState())
      toast.success('已清空当前会话消息')
    }
  }, [activeThreadId, updateSessionMessages])

  // 切换 Agent（带 toast 反馈）
  const handleSwitchAgent = useCallback(
    (agentId: string) => {
      if (agentId === activeAgentId) {
        toast.info('已是当前 Agent')
        return
      }
      const target = allAssistants.find((a) => a.agentId === agentId)
      setActiveAgentId(agentId)
      toast.success('已切换 Agent', target?.name ?? agentId)
    },
    [activeAgentId, allAssistants, setActiveAgentId]
  )

  // 显示快捷键帮助（通过 toast 展示常用快捷键）
  const handleShowShortcutHelp = useCallback(() => {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    const mod = isMac ? '⌘' : 'Ctrl'
    toast.info(
      '快捷键帮助',
      [
        `${mod}+K 命令面板`,
        `${mod}+N 新建会话`,
        `${mod}+B / ${mod}+\\ 切换左栏`,
        `${mod}+Shift+B / ${mod}+Shift+\\ 切换右栏`,
        `${mod}+D DevLog`,
        `${mod}+L 聚焦输入`,
        `${mod}+[ / ${mod}+] 上/下一会话`,
        `${mod}+M 切换权限模式`,
        `${mod}+/ 显示此帮助`,
        `Esc 关闭浮层 / 中断`
      ].join('  ·  ')
    )
  }, [])

  const { setTheme } = useTheme()

  // 命令面板命令列表
  const commands = useMemo(
    () =>
      createDefaultCommands(
        {
          onNewSession: handleNewSession,
          onDeleteCurrentSession: handleDeleteCurrentSession,
          onSwitchToSession: setActiveThreadId,
          onSwitchAgent: handleSwitchAgent,
          onToggleLeftPanel: toggleLeftPanel,
          onToggleRightPanel: toggleRightPanel,
          onToggleDevLog: toggleDevLog,
          onOpenThemePanel: () => {
            const current = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
            setTheme(current)
          },
          onToggleTheme: () => {
            const current = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
            setTheme(current)
          },
          onSwitchMode: () => setRightPanel('context'),
          onSwitchModel: () => setRightPanel('context'),
          onViewUsage: () => setRightPanel('context'),
          onOpenSettings: () => onOpenSettings?.(),
          onOpenGeneralSettings: () => onOpenSettings?.(),
          onOpenAssistantSettings: () => onOpenSettings?.(),
          onOpenProviderSettings: () => onOpenSettings?.(),
          onOpenSkillSettings: () => onOpenSettings?.(),
          onOpenAbout: () => onOpenSettings?.(),
          onCompact: () => void handleCompact(),
          onClearMessages: handleClearMessages
        },
        {
          allAssistants,
          pinnedSessions
        }
      ),
    [
      handleNewSession,
      handleDeleteCurrentSession,
      setActiveThreadId,
      handleSwitchAgent,
      toggleLeftPanel,
      toggleRightPanel,
      toggleDevLog,
      setTheme,
      setRightPanel,
      onOpenSettings,
      handleCompact,
      handleClearMessages,
      allAssistants,
      pinnedSessions
    ]
  )

  // 全局快捷键（实现 §9.3 快捷键全表 + 聊天专属绑定）
  useChatShortcuts({
    onCommandPalette: toggleCommandPalette,
    onNewSession: handleNewSession,
    onOpenSettings: () => onOpenSettings?.(),
    onToggleDevLog: toggleDevLog,
    onToggleLeftPanel: toggleLeftPanel,
    onToggleRightPanel: toggleRightPanel,
    onPrevSession: handlePrevSession,
    onNextSession: handleNextSession,
    onAbort: handleAbort,
    onFocusInput: handleFocusInput,
    onTogglePermissionMode: () => void handleTogglePermissionMode(),
    onShowShortcutHelp: handleShowShortcutHelp
  })

  const health = healthQuery.data
  const isOnline = health?.status === 'online'

  /**
   * 打开助手输出里的文件引用（`src/a.ts:42`）。
   *
   * 相对路径按工作区根解析；读不到就给一条 toast，而不是静默什么都不发生 ——
   * 「点了没反应」比「告诉我打不开」糟得多。
   */
  const handleOpenFileReference = useCallback(
    async (ref: FileReference) => {
      const workspacePath = workspaceQuery.data?.path
      const absolute = resolveWorkspacePath(ref.path, workspacePath)
      if (!absolute) {
        toast.warning('无法定位文件', '当前没有工作区，无法解析相对路径')
        return
      }
      if (!window.api?.file) return

      const result = await window.api.file.read(absolute)
      if (!result.ok || result.content == null) {
        toast.warning('打不开这个文件', ref.path)
        return
      }
      openFilePreview({
        name: ref.path,
        content: result.content,
        encoding: result.encoding,
        size: result.size ?? 0,
        type: 'file',
        highlightLine: ref.line,
        highlightEndLine: ref.endLine
      })
    },
    [workspaceQuery.data?.path, openFilePreview]
  )

  const fileReferenceContext = useMemo(
    () => ({ openFile: (ref: FileReference) => void handleOpenFileReference(ref) }),
    [handleOpenFileReference]
  )

  // 合并流式错误和 run 错误
  const displayError = messageState.streamError ?? (runError ? runError.message : null)

  // ── 待发队列的自动推进 ──

  const activeQueue = commandQueues[activeThreadId] ?? []
  /** 失败结束时暂停自动出队：否则整队会以同样方式连续失败一遍，还白烧 token */
  const queueErrorPaused = activeQueue.length > 0 && displayError !== null

  /**
   * 只在 isRunning 真正发生 true → false 的跳变时出队。
   *
   * 不能只判断 `!isRunning && queue.length > 0` —— 那样应用启动时如果队列里
   * 还有上次残留的排队项，会在用户完全没准备的情况下自动发出去。
   */
  const prevRunningRef = useRef(isRunning)
  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = isRunning
    if (!wasRunning || isRunning) return
    if (displayError !== null) return
    if ((commandQueues[activeThreadId] ?? []).length === 0) return
    drainQueue()
  }, [isRunning, displayError, commandQueues, activeThreadId, drainQueue])

  return (
    <div className="grid grid-rows-[minmax(0,1fr)_var(--statusbar-height)] h-screen min-h-[620px] overflow-hidden bg-app-bg text-text">
      {/* ── Workspace grid（workspace-grid 启用面板折叠过渡 250ms） ── */}
      <div className="flex min-h-0 workspace-grid">
        {/* ── Sidebar ── */}
        {leftPanelOpen && (
          <>
            <div
              style={{ width: sidebarWidth }}
              className="shrink-0 h-full min-h-0 overflow-hidden"
            >
              <SessionList
                sessions={sessions}
                activeSessionId={activeThreadId}
                onSelectSession={setActiveThreadId}
                onNewSession={handleNewSession}
                onRenameSession={handleRenameSession}
                onDeleteSession={handleDeleteSession}
              />
            </div>
            <ResizableSplitter
              direction="horizontal"
              size={sidebarWidth}
              minSize={180}
              maxSize={400}
              onSizeChange={setSidebarWidth}
              side="left"
            />
          </>
        )}

        {/* ── Chat main（工作区背景 #F7F8FA） ── */}
        <main
          className="pi-workspace-main grid min-w-0 flex-1 overflow-hidden"
          style={{ gridTemplateRows: `var(--chat-header-height) minmax(0,1fr) auto` }}
          aria-label="Wenlang Agent 工作台"
        >
          {/* ── 会话标题栏（玻璃态：bg + backdrop-blur + 底部边框） ── */}
          <header className="pi-glass-header flex items-center justify-between h-[var(--chat-header-height)] px-4 [webkit-app-region:drag]">
            <div className="flex items-center min-w-0 flex-1 [webkit-app-region:drag]">
              {/* ChatTitleEditor：leading 为 AgentSwitcher（紧凑模式仅渲染 logo），subtitle 展示模型 · 同步时间 */}
              <ChatTitleEditor
                title={activeSession?.title ?? activeAssistant.name}
                onRename={(newTitle) => handleRenameSession(activeThreadId, newTitle)}
                canRename={Boolean(activeSession)}
                placeholder="输入会话标题"
                leading={
                  <AgentDetailCard assistant={activeAssistant}>
                    <AgentSwitcher onManageAgents={onOpenSettings} compact />
                  </AgentDetailCard>
                }
                subtitle={
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{selectedModel?.modelId ?? '未选择模型'}</span>
                    <span aria-hidden="true" className="shrink-0">
                      ·
                    </span>
                    <span className="shrink-0">
                      同步于 {formatRelativeTime(activeSession?.updatedAt ?? Date.now())}
                    </span>
                  </span>
                }
                className="min-w-0 flex-1"
              />
            </div>

            <div className="flex items-center gap-1 [webkit-app-region:no-drag]">
              {/* 插件贡献的标题栏动作（list slot，宿主按钮之前） */}
              <SlotRenderer
                name="chat.header.actions"
                fallback={null}
                extraProps={{ threadId: activeThreadId }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-subtle hover:text-text hover:bg-surface-3"
                aria-label="工作区文件夹"
              >
                <FolderOpen className="size-4" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleRightPanel}
                className="size-8 text-subtle hover:text-text hover:bg-surface-3"
                aria-label={rightPanelOpen ? '收起右侧栏' : '展开右侧栏'}
              >
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span
                    key={rightPanelOpen ? 'close' : 'open'}
                    initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                    transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                    className="flex items-center justify-center"
                  >
                    {rightPanelOpen ? (
                      <PanelRightClose className="size-4" aria-hidden="true" />
                    ) : (
                      <PanelRightOpen className="size-4" aria-hidden="true" />
                    )}
                  </motion.span>
                </AnimatePresence>
              </Button>
            </div>
          </header>

          <FileReferenceProvider value={fileReferenceContext}>
          <MessageStream
            messages={mergedMessages}
            isStreaming={isRunning}
            streamError={displayError}
            onRetry={handleRetry}
            onDismissError={handleDismissError}
            onExampleClick={handleSend}
            sessionKey={activeThreadId}
            onFilePreview={openFilePreview}
            onCancelStream={handleAbort}
            onQuote={handleQuote}
            onRegenerate={handleRegenerate}
            onOpenSettings={onOpenSettings}
            onCompact={() => void handleCompact()}
            pendingConfirmations={pendingConfirmations}
            onRespondConfirmation={respondConfirmation}
            onLoadMore={loadMoreHistory}
            hasMore={historicalHasMore}
            isLoadingMore={historicalIsLoadingMore}
            isLoadingInitial={historicalIsLoadingInitial}
            banner={
              <CompactionBanner
                event={compactionEvent}
                onDismiss={() => setCompactionEvent(null)}
                onManualCompact={() => void handleCompact()}
              />
            }
          />
          </FileReferenceProvider>

          {/* 工作区选择（仅空态显示）：无消息时才占位，避免挤压对话区 */}
          {mergedMessages.length === 0 && (
            <div className="px-6 pb-2">
              <WorkspaceIndicator />
            </div>
          )}

          <InputArea
            onSend={handleSubmit}
            onAbort={handleAbort}
            isRunning={isRunning}
            disabled={!isOnline}
            queueFull={activeQueue.length >= MAX_QUEUE_LENGTH}
            beforeInput={
              <>
                {/* 插件贡献的输入区上方停靠位（例如待办条、状态提示） */}
                <SlotRenderer
                  name="chat.composer.dock"
                  fallback={null}
                  extraProps={{ threadId: activeThreadId }}
                />
                <CommandQueuePanel
                  queue={activeQueue}
                  errorPaused={queueErrorPaused}
                  canResume={!isRunning && activeQueue.length > 0}
                  onRemove={(id) => removeCommand(activeThreadId, id)}
                  onEdit={(id, text) => updateCommandText(activeThreadId, id, text)}
                  onReorder={(ids) => reorderQueue(activeThreadId, ids)}
                  onClear={() => clearQueue(activeThreadId)}
                  onResume={drainQueue}
                />
              </>
            }
            toolbarLeft={
              <SlotRenderer
                name="chat.composer.left"
                fallback={null}
                extraProps={{ threadId: activeThreadId }}
              />
            }
            toolbarRight={
              <SlotRenderer
                name="chat.composer.right"
                fallback={null}
                extraProps={{ threadId: activeThreadId }}
              />
            }
            value={drafts[activeThreadId] ?? ''}
            onChange={(text) => setDraft(activeThreadId, text)}
            models={modelsQuery.data ?? []}
            selectedModel={
              selectedModel ? `${selectedModel.provider}:${selectedModel.modelId}` : null
            }
            onModelChange={(provider, modelId) => setSelectedModel({ provider, modelId })}
            thinkingLevel={selectedThinkingLevels[activeThreadId] ?? null}
            onThinkingLevelChange={(level) => void handleThinkingLevelChange(activeThreadId, level)}
            sessions={sessions}
            activeSessionId={activeThreadId}
            onFilePreview={openFilePreview}
          />
        </main>

        {/* ── 右侧栏 Splitter + Context panel ── */}
        {rightPanelOpen && (
          <>
            <ResizableSplitter
              direction="horizontal"
              size={rightPanelWidth}
              minSize={240}
              maxSize={600}
              onSizeChange={setRightPanelWidth}
              side="right"
            />
            <aside
              style={{ width: rightPanelWidth }}
              className="pi-side-panel bg-surface-1 shrink-0 overflow-hidden flex flex-col"
              aria-label={filePreview ? '文件预览' : rightPanelTab ? '插件面板' : '上下文'}
            >
              {filePreview ? (
                // 文件预览是临时覆盖：关闭后回到原本选中的 tab，不丢状态
                <FilePreviewPanel file={filePreview} onClose={closeFilePreview} />
              ) : (
                <RightPanelTabs
                  activeTab={rightPanelTab}
                  onSelectTab={setRightPanelTab}
                  threadId={activeThreadId}
                  context={
                    <ContextPanel
                      stats={{
                        tokensUsed: contextState.tokensUsed,
                        contextWindow: currentContextWindow,
                        messageCount: messageState.messages.length,
                        toolCallCount: executions.length,
                        compactionCount,
                        generationCount: contextState.callCount || executions.length,
                        totalInputTokens: contextState.totalInputTokens,
                        totalOutputTokens: contextState.totalOutputTokens,
                        model: contextState.model,
                        provider: contextState.provider
                      }}
                      isOnline={isOnline}
                      isCompacting={compactionEvent?.state === 'running'}
                      onCompact={() => void handleCompact()}
                      onOpenSettings={onOpenSettings}
                      onViewDetails={() => setUsageDetailOpen(true)}
                      workspacePath={workspaceQuery.data?.path}
                      associatedFiles={associatedFiles}
                      memorySummary={memorySummaryQuery.data ?? null}
                      activities={activities}
                    />
                  }
                />
              )}
            </aside>
          </>
        )}
      </div>

      {/* ── Status bar（Craft 风格：白色背景 + 顶部边框 + 左侧状态/延迟/模型 + 右侧版本号） ── */}
      <footer
        data-tour="status-bar"
        className="flex items-center gap-4 min-w-0 overflow-hidden px-5 bg-statusbar-bg border-t border-statusbar-border"
      >
        {/* 左侧：在线状态 + 延迟 + 模型 · 权限模式 */}
        <span
          className={`shrink-0 size-2 rounded-full ${isOnline ? 'bg-success' : 'bg-danger'}`}
          aria-hidden="true"
        />
        <span className="text-xs text-subtle whitespace-nowrap">
          {isOnline ? '已连接' : '未连接'}
        </span>
        <span className="text-xs text-hint" aria-hidden="true">
          ·
        </span>
        <span className="text-xs text-subtle whitespace-nowrap">延迟 38ms</span>
        <span className="text-xs text-hint" aria-hidden="true">
          ·
        </span>
        <span className="text-xs text-subtle whitespace-nowrap">
          {selectedModel?.modelId ?? 'GPT 5'} ·{' '}
          {gateQuery.data ? PERMISSION_MODE_LABELS[gateQuery.data.mode] : '自动'}
        </span>

        {/* 右侧：通知中心 + 自动保存 + 版本号 */}
        <div className="ml-auto flex items-center gap-2">
          <NotificationCenter
            notifications={notifications}
            onDismiss={dismissNotification}
            onDismissAll={dismissAllNotifications}
          />
          <span className="text-xs text-subtle whitespace-nowrap">已自动保存 v1.0.0</span>
        </div>
      </footer>

      {/* DevLog 面板（底部抽屉，Cmd/Ctrl+D 切换） */}
      <DevLogPanel
        logs={devLogs}
        onClear={clearDevLogs}
        isOpen={devLogOpen}
        onOpenChange={setDevLogOpen}
      />

      {/* 命令面板（Cmd/Ctrl+K 切换） */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={commands}
      />

      {/* ── 用量明细弹窗 ── */}
      <Dialog open={usageDetailOpen} onOpenChange={setUsageDetailOpen}>
        <DialogContent className="sm:max-w-lg flex flex-col max-h-[80vh]">
          <DialogHeader className="shrink-0">
            <DialogTitle>用量明细</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto min-h-0">
            <UsagePanel isOnline={isOnline} />
          </div>
        </DialogContent>
      </Dialog>


    </div>
  )
}

/** 格式化为相对时间文本 */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 7) return `${days} 天前`
  return '很久以前'
}

/**
 * 把引用里的路径解析成绝对路径。
 *
 * 渲染进程没有 node 的 path 模块，所以自己判：以 `/` 开头或带盘符（`D:\`）视为
 * 绝对路径，其余按工作区根拼。没有工作区且路径是相对的就返回 null，由调用方提示。
 */
function resolveWorkspacePath(path: string, workspacePath?: string): string | null {
  const isAbsolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
  if (isAbsolute) return path
  if (!workspacePath) return null
  const base = workspacePath.replace(/[\\/]+$/, '')
  return `${base}/${path.replace(/^[\\/]+/, '')}`
}