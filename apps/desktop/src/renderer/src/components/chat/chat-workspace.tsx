import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { useShortcut } from '@/hooks/use-shortcut'
import { useTheme } from '@/components/theme-provider'
import { ConfirmationDialog } from './confirmation-dialog'
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
import { ContextPanel, type AssociatedFile, type MemorySummaryData, type ActivityEntry } from './context-panel'
import { useResizableSplit } from '@/hooks/ui/use-resizable-split'
import { useWorkspaceCollapse } from '@/hooks/ui/use-workspace-collapse'
import { Titlebar } from '@/components/layout/titlebar'
import { UsagePanel } from './usage-panel'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { type ModelOption } from './model-selector'
import { createUserMessage, type ChatMessage, type FileAttachment } from './types'
import {
  useSessionStore,
  createEmptyMessageState,
  upsertSessionAfterSend,
} from '@/stores/session-store'
import { useUIStore } from '@/stores/ui-store'

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
  full: '完全控制',
}

export function ChatWorkspace({
  appName: _appName,
  config: _config,
  onOpenSettings,
}: ChatWorkspaceProps): ReactElement {
  const queryClient = useQueryClient()

  // ── Zustand stores ──
  const sessions = useSessionStore((s) => s.sessions)
  const activeThreadId = useSessionStore((s) => s.activeThreadId)
  const sessionMessages = useSessionStore((s) => s.sessionMessages)
  const drafts = useSessionStore((s) => s.drafts)
  const selectedModel = useSessionStore((s) => s.selectedModel)
  const compactionCount = useSessionStore((s) => s.compactionCount)
  const activeAgentId = useSessionStore((s) => s.activeAgentId)
  const setSessions = useSessionStore((s) => s.setSessions)
  const setActiveThreadId = useSessionStore((s) => s.setActiveThreadId)
  const updateSessionMessages = useSessionStore((s) => s.updateSessionMessages)
  const setDraft = useSessionStore((s) => s.setDraft)
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel)
  const incrementCompactionCount = useSessionStore((s) => s.incrementCompactionCount)
  const removeSession = useSessionStore((s) => s.removeSession)
  const upsertSession = useSessionStore((s) => s.upsertSession)

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

  // ── 本地 UI 状态（无需持久化） ──
  const [compactionEvent, setCompactionEvent] = useState<CompactionEvent | null>(null)
  const [usageDetailOpen, setUsageDetailOpen] = useState(false)
  const siderSplit = useResizableSplit({ defaultWidth: 260, storageKey: 'pi-chat-sider-width', unit: 'px', minWidth: 200, maxWidth: 480 })
  const contextSplit = useResizableSplit({ defaultWidth: 320, storageKey: 'pi-chat-context-width', unit: 'px', minWidth: 240, maxWidth: 600 })
  const { collapsed: workspaceCollapsed, toggle: toggleWorkspace } = useWorkspaceCollapse({ preferenceKey: activeThreadId, defaultCollapsed: false })

  const messageState: MessageStreamState =
    sessionMessages[activeThreadId] ?? createEmptyMessageState()

  const activeSession = sessions.find((s) => s.id === activeThreadId)

  // 当前权限模式（状态栏展示用）
  const gateQuery = useQuery({
    queryKey: ['gate'],
    queryFn: () => getApi<GateData>('/api/gate'),
    refetchInterval: 10_000,
  })

  const healthQuery = useQuery({
    queryKey: ['agent-server-health'],
    queryFn: () => getApi<HealthData>('/api/health'),
    refetchInterval: 10_000,
  })

  // 当前工作区信息
  const workspaceQuery = useQuery({
    queryKey: ['workspace'],
    queryFn: () => getApi<{ path: string; name: string; gitBranch?: string; gitDirty?: boolean }>('/api/workspace'),
    refetchInterval: 30_000,
  })

  // 当前会话的记忆摘要
  const memorySummaryQuery = useQuery({
    queryKey: ['memory-summary', activeThreadId],
    queryFn: () => getApi<MemorySummaryData | null>(`/api/memory/summaries/${activeThreadId}`),
    refetchInterval: 30_000,
  })

  // 已注册模型列表（供模型选择器使用）
  const modelsQuery = useQuery({
    queryKey: ['agui-models'],
    queryFn: async () => {
      const res = await getAgui<{ threadId: string; models: ModelOption[] }>(
        '/ag-ui/agent/default/models?threadId=main',
      )
      return res.models ?? []
    },
    refetchInterval: 60_000,
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
    resetContextState,
  } = useRealtimeEvents()

  // 切换线程时重置上下文状态
  useEffect(() => {
    resetContextState()
  }, [activeThreadId, resetContextState])

  const {
    pendingConfirmations,
    respondConfirmation,
  } = useWebSocket({
    threadId: activeThreadId,
    onMessage: onToolMessage,
    onNotification: addNotification,
    onDevLog: addDevLog,
    onUsageUpdate: addUsageUpdate,
    onContextUpdate: addContextUpdate,
  })

  // AG-UI 事件 → 消息流状态
  const handleAguiEvent = useCallback(
    (event: BaseEvent) => {
      updateSessionMessages(activeThreadId, (prev) => applyEvent(prev, event))
    },
    [activeThreadId, updateSessionMessages],
  )

  // 读取全局默认温度（从 localStorage，由设置页 agent-config 配置）
  const globalTemperature = useMemo(() => {
    try {
      const saved = window.localStorage.getItem('wenlang-agent.agent-config')
      if (saved) {
        const parsed = JSON.parse(saved) as { temperature?: number }
        if (typeof parsed.temperature === 'number') return parsed.temperature
      }
    } catch { /* ignore */ }
    return undefined
  }, [])

  const {
    run,
    abort,
    isRunning,
    error: runError,
  } = useStreamingRun({
    threadId: activeThreadId,
    onEvent: handleAguiEvent,
    model: selectedModel ?? undefined,
    agentId: activeAgentId,
    temperature: globalTemperature,
  })

  // ── 从上下文状态获取 contextWindow（由 context:update 实时事件推送，来自 modelRegistry）──
  // 当 contextState.contextWindow > 0 时使用实时值，否则回退到模型列表查询
  const currentContextWindow = useMemo(() => {
    if (contextState.contextWindow > 0) return contextState.contextWindow
    if (!selectedModel) return 32768
    const model = modelsQuery.data?.find(
      (m) => m.provider === selectedModel.provider && m.id === selectedModel.modelId,
    )
    return model?.contextWindow ?? 32768
  }, [contextState.contextWindow, selectedModel, modelsQuery.data])

  // ── 从消息流中提取关联文件（工具调用涉及的文件路径） ──
  const associatedFiles = useMemo<AssociatedFile[]>(() => {
    const PATH_KEYS = ['path', 'filePath', 'file_path', 'filename', 'file']
    const files: AssociatedFile[] = []
    for (const msg of messageState.messages) {
      if (!msg.toolCalls) continue
      for (const tc of msg.toolCalls) {
        if (!tc.args || typeof tc.args !== 'object') continue
        const args = tc.args as Record<string, unknown>
        for (const key of PATH_KEYS) {
          const val = args[key]
          if (typeof val === 'string' && val.length > 0) {
            files.push({
              path: val,
              toolName: tc.toolName,
              timestamp: tc.startedAt ?? msg.createdAt ?? Date.now(),
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
      timestamp: log.timestamp,
    }))
  }, [devLogs])

  const handleSend = useCallback(
    (text: string, attachments?: FileAttachment[]) => {
      const userMsg = createUserMessage(text, attachments)
      updateSessionMessages(activeThreadId, (prev) => ({
        ...prev,
        messages: [...prev.messages, userMsg],
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
    [activeThreadId, run, updateSessionMessages, sessions, setSessions],
  )

  const handleAbort = useCallback(() => {
    abort()
  }, [abort])

  const handleCompact = useCallback(async () => {
    const eventId = crypto.randomUUID()
    setCompactionEvent({
      id: eventId,
      timestamp: Date.now(),
      reason: 'manual',
      state: 'running',
    })
    try {
      await postAgui<CompactThreadResponse>('/ag-ui/agent/default/compact', {
        threadId: activeThreadId,
      })
      setCompactionEvent((prev) =>
        prev
          ? {
              ...prev,
              state: 'success',
              timestamp: Date.now(),
            }
          : null,
      )
      incrementCompactionCount()
    } catch (error) {
      const message = error instanceof Error ? error.message : '上下文压缩失败。'
      setCompactionEvent((prev) =>
        prev
          ? {
              ...prev,
              state: 'error',
              errorMessage: message,
              timestamp: Date.now(),
            }
          : null,
      )
    }
  }, [activeThreadId, incrementCompactionCount])

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messageState.messages]
      .reverse()
      .find((m) => m.role === 'user')
    if (lastUserMsg) {
      void run([lastUserMsg as ChatMessage])
    }
    updateSessionMessages(activeThreadId, (prev) => ({
      ...prev,
      streamError: null,
      // 移除最后一条错误的助手消息
      messages: prev.messages.filter(
        (m) => !(m.role === 'assistant' && m.status === 'error'),
      ),
    }))
  }, [messageState.messages, run, updateSessionMessages, activeThreadId])

  const handleDismissError = useCallback(() => {
    updateSessionMessages(activeThreadId, (prev) => ({ ...prev, streamError: null }))
  }, [activeThreadId, updateSessionMessages])

  const handleNewSession = useCallback(() => {
    const id = crypto.randomUUID()
    const ts = Date.now()
    const session: SessionSummary = {
      id,
      title: '新会话',
      preview: '准备开始对话',
      createdAt: ts,
      updatedAt: ts,
    }
    upsertSession(session)
    updateSessionMessages(id, () => createEmptyMessageState())
    setActiveThreadId(id)
  }, [upsertSession, updateSessionMessages, setActiveThreadId])

  const handleRenameSession = useCallback(
    (id: string, newTitle: string) => {
      setSessions(
        sessions.map((s) =>
          s.id === id ? { ...s, title: newTitle, updatedAt: Date.now() } : s,
        ),
      )
    },
    [sessions, setSessions],
  )

  const handleDeleteSession = useCallback(
    (id: string) => {
      const remaining = sessions.filter((s) => s.id !== id)
      // 如果删除的是当前会话，切换到第一个
      if (id === activeThreadId && remaining.length > 0) {
        setActiveThreadId(remaining[0].id)
      }
      removeSession(id)
    },
    [sessions, activeThreadId, setActiveThreadId, removeSession],
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

  const { setTheme } = useTheme()

  // 命令面板命令列表
  const commands = useMemo(
    () =>
      createDefaultCommands({
        onNewSession: handleNewSession,
        onOpenSettings: () => onOpenSettings?.(),
        onCompact: () => void handleCompact(),
        onToggleTheme: () => {
          const current = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
          setTheme(current)
        },
        onSwitchMode: () => setRightPanel('context'),
        onSwitchModel: () => setRightPanel('context'),
        onViewUsage: () => setRightPanel('context'),
      }),
    [handleNewSession, handleCompact, onOpenSettings, setRightPanel, setTheme],
  )

  // 全局快捷键（实现 §9.3 快捷键全表）
  useShortcut({
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
  })

  const health = healthQuery.data
  const isOnline = health?.status === 'online'

  // 合并流式错误和 run 错误
  const displayError = messageState.streamError ?? (runError ? runError.message : null)

  return (
    <div className="grid grid-rows-[40px_minmax(0,1fr)_var(--statusbar-height)] h-screen min-h-[620px] overflow-hidden bg-app-bg text-text">
      <Titlebar
        title={activeSession?.title ?? 'Agent 工作台'}
        onWorkspaceToggle={toggleWorkspace}
        workspaceCollapsed={workspaceCollapsed}
      />
      {/* ── Workspace grid（workspace-grid 启用面板折叠过渡 250ms） ── */}
      <div
        className="flex min-h-0 workspace-grid"
      >
        {/* ── Sidebar ── */}
        {leftPanelOpen && (
          <>
            <div style={{ width: siderSplit.splitRatio }} className="shrink-0 h-full min-h-0 overflow-hidden">
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
              size={siderSplit.splitRatio}
              onSizeChange={siderSplit.setSplitRatio}
              side="right"
              collapsed={false}
            />
          </>
        )}

        {/* ── Chat main（工作区背景 #F7F8FA） ── */}
        <main
          className="bg-workspace-bg grid min-w-0 flex-1 overflow-hidden"
          style={{ gridTemplateRows: `var(--chat-header-height) minmax(0,1fr) auto${messageState.messages.length === 0 ? ' auto' : ''}` }}
          aria-label="PI Agent 工作台"
        >
          {/* ── 会话标题栏（60px，工作区顶部） ── */}
          <header className="flex items-center justify-between h-[var(--chat-header-height)] bg-chat-header-bg [webkit-app-region:drag]">
            <div className="flex flex-col justify-center gap-0.5 [webkit-app-region:drag] px-2">
              <h1 className="text-base font-semibold text-text truncate">
                {activeSession?.title ?? 'Agent 工作台'}
              </h1>
              <div className="flex items-center gap-1.5 text-xs text-subtle">
                <span>{selectedModel?.modelId ?? '未知模型'}</span>
                <span aria-hidden="true">·</span>
                <span>同步于 {formatRelativeTime(activeSession?.updatedAt ?? Date.now())}</span>
              </div>
            </div>

            <div className="flex items-center gap-1 [webkit-app-region:no-drag]">
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

          <MessageStream
            messages={messageState.messages}
            isStreaming={isRunning}
            streamError={displayError}
            onRetry={handleRetry}
            onDismissError={handleDismissError}
            onExampleClick={handleSend}
            sessionKey={activeThreadId}
            onFilePreview={openFilePreview}
            banner={
              <CompactionBanner
                event={compactionEvent}
                onDismiss={() => setCompactionEvent(null)}
                onManualCompact={() => void handleCompact()}
              />
            }
          />

          <InputArea
            onSend={handleSend}
            onAbort={handleAbort}
            isRunning={isRunning}
            disabled={!isOnline}
            value={drafts[activeThreadId] ?? ''}
            onChange={(text) => setDraft(activeThreadId, text)}
            models={modelsQuery.data ?? []}
            selectedModel={
              selectedModel
                ? `${selectedModel.provider}:${selectedModel.modelId}`
                : null
            }
            onModelChange={(provider, modelId) =>
              setSelectedModel({ provider, modelId })
            }
            sessions={sessions}
            activeSessionId={activeThreadId}
            onFilePreview={openFilePreview}
          />

          {/* 工作区选择（仅空态显示） */}
          {messageState.messages.length === 0 && (
            <div className="px-6 pb-2">
              <WorkspaceIndicator />
            </div>
          )}
        </main>

        {/* ── 右侧栏 Splitter + Context panel ── */}
        {rightPanelOpen && !workspaceCollapsed && (
          <>
            <ResizableSplitter
              direction="horizontal"
              size={contextSplit.splitRatio}
              onSizeChange={contextSplit.setSplitRatio}
              side="left"
              collapsed={workspaceCollapsed}
            />
            <aside
              style={{ width: contextSplit.splitRatio }}
              className="bg-surface-1 border-l border-border shrink-0 overflow-hidden flex flex-col"
              aria-label={filePreview ? '文件预览' : '上下文'}
            >
              {filePreview ? (
                <FilePreviewPanel file={filePreview} onClose={closeFilePreview} />
              ) : (
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
                    provider: contextState.provider,
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
        <span className="text-xs text-hint" aria-hidden="true">·</span>
        <span className="text-xs text-subtle whitespace-nowrap">延迟 38ms</span>
        <span className="text-xs text-hint" aria-hidden="true">·</span>
        <span className="text-xs text-subtle whitespace-nowrap">
          {selectedModel?.modelId ?? 'GPT 5'} · {gateQuery.data ? PERMISSION_MODE_LABELS[gateQuery.data.mode] : '自动'}
        </span>

        {/* 右侧：通知中心 + 自动保存 + 版本号 */}
        <div className="ml-auto flex items-center gap-2">
          <NotificationCenter
            notifications={notifications}
            onDismiss={dismissNotification}
            onDismissAll={dismissAllNotifications}
          />
          <span className="text-xs text-subtle whitespace-nowrap">
            已自动保存 v1.0.0
          </span>
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

      {/* ── 确认对话框（由 WebSocket 事件驱动） ── */}
      <ConfirmationDialog requests={pendingConfirmations} onRespond={respondConfirmation} />
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

