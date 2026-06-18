import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BrowserConfig } from '@repo/config/shared'
import type { BaseEvent } from '@repo/protocol/events'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getApi, postApi } from '../../api'
import { ProviderBootstrap, type ProviderSettings } from '../settings/provider-bootstrap'
import { useWebSocket } from '@/hooks/use-websocket'
import { useToolExecutions } from '@/hooks/use-tool-executions'
import { useStreamingRun } from '@/hooks/use-streaming-run'
import { ConfirmationDialog } from './confirmation-dialog'
import { PermissionModeSwitch } from './permission-mode-switch'
import { ToolCardList } from './tool-card'
import { MessageStream, applyEvent, type MessageStreamState } from './message-stream'
import { InputArea } from './input-area'
import { createUserMessage, type ChatMessage } from './types'

type HealthData = {
  service: string
  status: string
}

type ChatWorkspaceProps = {
  appName: string
  config: BrowserConfig
}

type SessionSummary = {
  id: string
  title: string
  preview: string
  time: string
}

type CompactStatus =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'success'; message: string }
  | { state: 'error'; message: string }

type CompactThreadResponse = {
  status: string
  threadId: string
  result: unknown
}

const defaultSessions: SessionSummary[] = [
  {
    id: 'desktop-main',
    title: '新会话',
    preview: '准备连接 Pi Agent',
    time: '现在'
  },
  {
    id: 'sdk-integration',
    title: 'SDK 集成验证',
    preview: 'P0-P4 基线已就绪',
    time: '今天'
  }
]

export function ChatWorkspace({ appName, config }: ChatWorkspaceProps): ReactElement {
  const [rightPanel, setRightPanel] = useState<'context' | 'provider'>('context')
  const [sessions, setSessions] = useState<SessionSummary[]>(() => loadSessions())
  const [activeThreadId, setActiveThreadId] = useState<string>(() =>
    loadCurrentSessionId(loadSessions())
  )
  const [sessionSearch, setSessionSearch] = useState('')
  const [sessionMessages, setSessionMessages] = useState<Record<string, MessageStreamState>>(() =>
    loadSessionMessages()
  )
  const [drafts, setDrafts] = useState<Record<string, string>>(() => loadDrafts())
  const [compactStatus, setCompactStatus] = useState<CompactStatus>({ state: 'idle' })

  const messageState = sessionMessages[activeThreadId] ?? createEmptyMessageState()

  const healthQuery = useQuery({
    queryKey: ['agent-server-health'],
    queryFn: () => getApi<HealthData>('/api/health'),
    refetchInterval: 10_000
  })

  const { executions, onMessage: onToolMessage, clear: clearExecutions } = useToolExecutions()

  const {
    status: wsStatus,
    pendingConfirmation,
    respondConfirmation
  } = useWebSocket({
    threadId: activeThreadId,
    onMessage: onToolMessage
  })

  useEffect(() => {
    saveJson('pi-agent.sessions', sessions)
  }, [sessions])

  useEffect(() => {
    saveString('pi-agent.currentSessionId', activeThreadId)
  }, [activeThreadId])

  useEffect(() => {
    saveJson('pi-agent.sessionMessages', sessionMessages)
  }, [sessionMessages])

  useEffect(() => {
    saveJson('pi-agent.drafts', drafts)
  }, [drafts])

  const updateActiveMessageState = useCallback(
    (updater: (prev: MessageStreamState) => MessageStreamState) => {
      setSessionMessages((prev) => {
        const current = prev[activeThreadId] ?? createEmptyMessageState()
        return {
          ...prev,
          [activeThreadId]: updater(current)
        }
      })
    },
    [activeThreadId]
  )

  // AG-UI 事件 → 消息流状态
  const handleAguiEvent = useCallback(
    (event: BaseEvent) => {
      updateActiveMessageState((prev) => applyEvent(prev, event))
    },
    [updateActiveMessageState]
  )

  const {
    run,
    abort,
    isRunning,
    error: runError
  } = useStreamingRun({
    threadId: activeThreadId,
    onEvent: handleAguiEvent
  })

  const handleSend = useCallback(
    (text: string) => {
      const userMsg = createUserMessage(text)
      updateActiveMessageState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMsg]
      }))
      setSessions((prev) => upsertSessionAfterSend(prev, activeThreadId, text))
      void run([userMsg])
    },
    [activeThreadId, run, updateActiveMessageState]
  )

  const handleAbort = useCallback(() => {
    abort()
  }, [abort])

  const handleCompact = useCallback(async () => {
    setCompactStatus({ state: 'running' })
    try {
      await postApi<CompactThreadResponse>('/ag-ui/agent/default/compact', {
        threadId: activeThreadId
      })
      setCompactStatus({ state: 'success', message: '上下文压缩完成。' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '上下文压缩失败。'
      setCompactStatus({ state: 'error', message })
    }
  }, [activeThreadId])

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messageState.messages].reverse().find((m) => m.role === 'user')
    if (lastUserMsg) {
      void run([lastUserMsg as ChatMessage])
    }
    updateActiveMessageState((prev) => {
      return {
        ...prev,
        streamError: null,
        // 移除最后一条错误的助手消息
        messages: prev.messages.filter((m) => !(m.role === 'assistant' && m.status === 'error'))
      }
    })
  }, [messageState.messages, run, updateActiveMessageState])

  const handleDismissError = useCallback(() => {
    updateActiveMessageState((prev) => ({ ...prev, streamError: null }))
  }, [updateActiveMessageState])

  const handleNewSession = useCallback(() => {
    const id = crypto.randomUUID()
    const session: SessionSummary = {
      id,
      title: '新会话',
      preview: '准备开始对话',
      time: '现在'
    }
    setSessions((prev) => [session, ...prev])
    setSessionMessages((prev) => ({ ...prev, [id]: createEmptyMessageState() }))
    setActiveThreadId(id)
  }, [])

  const filteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase()
    if (!query) return sessions
    return sessions.filter((session) =>
      `${session.title} ${session.preview}`.toLowerCase().includes(query)
    )
  }, [sessionSearch, sessions])

  const health = healthQuery.data
  const isOnline = health?.status === 'online'
  const statusText = healthQuery.isLoading
    ? 'checking'
    : isOnline
      ? health.status
      : healthQuery.error instanceof Error
        ? healthQuery.error.message
        : 'unavailable'

  const providerSummary = useMemo(() => loadProviderSummary(), [])

  const wsStatusText =
    wsStatus === 'connected'
      ? 'ws: 已连接'
      : wsStatus === 'connecting'
        ? 'ws: 连接中'
        : 'ws: 已断开'

  // 合并流式错误和 run 错误
  const displayError = messageState.streamError ?? (runError ? runError.message : null)

  return (
    <div className="grid grid-rows-[var(--titlebar-height)_minmax(0,1fr)_var(--statusbar-height)] h-screen min-h-[620px] overflow-hidden bg-app-bg text-text">
      {/* ── Title bar ── */}
      <header className="flex items-center justify-between min-w-0 bg-titlebar-bg border-b border-titlebar-border">
        <div className="flex items-center flex-1 gap-2.5 h-full min-w-0 px-3.5 [webkit-app-region:drag]">
          <span className="inline-flex items-center justify-center size-[22px] rounded-md bg-accent text-[#15120a] font-extrabold text-sm">
            π
          </span>
          <span>{appName}</span>
        </div>
        <div className="flex h-full [webkit-app-region:no-drag]">
          <button
            type="button"
            aria-label="最小化"
            className="w-11 h-full bg-transparent border-0 border-l border-titlebar-border relative hover:bg-titlebar-border"
          >
            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-2 rounded-full bg-muted" />
          </button>
          <button
            type="button"
            aria-label="最大化"
            className="w-11 h-full bg-transparent border-0 border-l border-titlebar-border relative hover:bg-titlebar-border"
          >
            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-2 rounded-full bg-muted" />
          </button>
          <button
            type="button"
            aria-label="关闭"
            className="w-11 h-full bg-transparent border-0 border-l border-titlebar-border relative hover:bg-titlebar-border"
          >
            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-2 rounded-full bg-muted" />
          </button>
        </div>
      </header>

      {/* ── Workspace grid ── */}
      <div className="grid grid-cols-[var(--sidebar-width)_minmax(480px,1fr)_var(--context-width)] min-h-0">
        {/* ── Sidebar ── */}
        <nav
          className="bg-surface-1 border-r border-border flex flex-col gap-3.5 min-w-0 overflow-hidden p-3.5"
          aria-label="会话"
        >
          <div className="flex items-center justify-between">
            <button
              className="inline-flex flex-1 items-center gap-2.5 min-h-[42px] min-w-0 px-2 py-1.5 rounded-lg bg-surface-2 border border-border text-text text-left"
              type="button"
              aria-label="切换 Agent"
            >
              <span className="inline-flex items-center justify-center size-7 rounded-[7px] bg-avatar-bg text-avatar-text text-xs font-extrabold shrink-0">
                pi
              </span>
              <span>
                <strong className="block font-[760] leading-tight">pi</strong>
                <small className="text-muted text-xs leading-snug">代码助手</small>
              </span>
            </button>
            <Button
              size="icon"
              className="shrink-0 text-xl font-bold"
              aria-label="新建会话"
              onClick={handleNewSession}
            >
              +
            </Button>
          </div>

          <label className="grid gap-1.5">
            <span className="text-muted text-xs font-bold">搜索会话</span>
            <input
              type="search"
              placeholder="搜索会话..."
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              className="bg-input-bg border border-border rounded-lg text-text min-w-0 min-h-[38px] px-2.5 outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/20"
            />
          </label>

          <div className="grid gap-2 min-h-0 overflow-auto" aria-label="今天">
            <p className="text-subtle text-xs font-[760] m-0">今天</p>
            {filteredSessions.map((session) => (
              <button
                className={`bg-transparent border rounded-lg text-text grid gap-1 min-h-[58px] p-2 text-left hover:bg-surface-2 hover:border-border focus-visible:bg-surface-2 focus-visible:border-border ${
                  session.id === activeThreadId
                    ? 'border-border bg-surface-2'
                    : 'border-transparent'
                }`}
                key={session.id}
                type="button"
                onClick={() => setActiveThreadId(session.id)}
              >
                <span>
                  <strong className="block font-[760] leading-tight">{session.title}</strong>
                  <small className="text-muted text-xs leading-snug">{session.preview}</small>
                </span>
                <time className="text-subtle text-[11px]">{session.time}</time>
              </button>
            ))}
          </div>
        </nav>

        {/* ── Chat main ── */}
        <main
          className="bg-[#12151b] grid grid-rows-[auto_auto_minmax(0,1fr)_auto] min-w-0 overflow-hidden"
          aria-label="PI Agent 工作台"
        >
          <header className="flex items-center justify-between gap-4 min-h-[78px] border-b border-border px-5 py-4">
            <div>
              <p className="text-subtle text-xs font-[760] m-0">PI Agent</p>
              <h1 className="text-[22px] font-[780] leading-tight mt-0.5">Agent 工作台</h1>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void healthQuery.refetch()}
                disabled={healthQuery.isFetching}
              >
                {healthQuery.isFetching ? '刷新中' : '刷新状态'}
              </Button>
              <Button size="sm" onClick={() => setRightPanel('provider')}>
                配置 Provider
              </Button>
            </div>
          </header>

          <section
            className="flex items-center justify-between gap-2.5 min-h-[44px] border-b border-border px-5"
            aria-label="运行状态"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`shrink-0 size-[9px] rounded-full ${isOnline ? 'bg-success shadow-[0_0_0_4px_rgba(47,209,124,0.16)]' : 'bg-danger shadow-[0_0_0_4px_rgba(255,107,107,0.16)]'}`}
              />
              <span className="text-xs">Agent Server</span>
              <strong className="text-xs font-bold font-mono break-anywhere">{statusText}</strong>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`shrink-0 size-[9px] rounded-full ${wsStatus === 'connected' ? 'bg-success shadow-[0_0_0_4px_rgba(47,209,124,0.16)]' : wsStatus === 'connecting' ? 'bg-accent shadow-[0_0_0_4px_rgba(242,193,78,0.16)]' : 'bg-danger shadow-[0_0_0_4px_rgba(255,107,107,0.16)]'}`}
              />
              <span className="text-xs font-mono">{wsStatusText}</span>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`shrink-0 size-[9px] rounded-full ${isRunning ? 'bg-accent shadow-[0_0_0_4px_rgba(242,193,78,0.16)]' : 'bg-muted'}`}
              />
              <span className="text-xs">AG-UI</span>
              <strong className="text-xs font-bold font-mono break-anywhere">
                {config.aguiBaseUrl}
              </strong>
            </div>
          </section>

          <MessageStream
            messages={messageState.messages}
            isStreaming={isRunning}
            streamError={displayError}
            onRetry={handleRetry}
            onDismissError={handleDismissError}
          />

          <InputArea
            onSend={handleSend}
            onAbort={handleAbort}
            isRunning={isRunning}
            disabled={!isOnline}
            value={drafts[activeThreadId] ?? ''}
            onChange={(text) =>
              setDrafts((prev) => ({
                ...prev,
                [activeThreadId]: text
              }))
            }
          />
        </main>

        {/* ── Context panel ── */}
        <aside
          className="bg-surface-1 border-l border-border grid grid-rows-[auto_minmax(0,1fr)] min-w-0 overflow-hidden"
          aria-label="上下文"
        >
          <Tabs
            value={rightPanel}
            onValueChange={(v) => setRightPanel(v as 'context' | 'provider')}
          >
            <TabsList className="w-full grid grid-cols-2 rounded-none border-b border-border bg-transparent h-11 p-0">
              <TabsTrigger
                value="context"
                className="rounded-none data-[state=active]:bg-surface-2 data-[state=active]:shadow-none"
              >
                上下文
              </TabsTrigger>
              <TabsTrigger
                value="provider"
                className="rounded-none data-[state=active]:bg-surface-2 data-[state=active]:shadow-none"
              >
                Provider
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {rightPanel === 'provider' ? (
            <ProviderBootstrap />
          ) : (
            <section className="grid gap-3.5 min-h-0 overflow-auto p-4 align-content-start">
              <div className="bg-surface-2 border border-border rounded-lg grid gap-1 p-3">
                <p className="text-subtle text-xs font-[760] m-0">模型</p>
                <strong className="font-[760] leading-tight">{providerSummary}</strong>
              </div>
              <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
                <PermissionModeSwitch />
              </div>
              <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-subtle text-xs font-[760] m-0">上下文压缩</p>
                    <p className="text-muted text-xs leading-relaxed m-0">
                      {getCompactStatusText(compactStatus)}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleCompact()}
                    disabled={!isOnline || compactStatus.state === 'running'}
                  >
                    {compactStatus.state === 'running' ? '压缩中' : '手动压缩上下文'}
                  </Button>
                </div>
                {compactStatus.state === 'success' || compactStatus.state === 'error' ? (
                  <p
                    className={`text-xs leading-relaxed m-0 ${compactStatus.state === 'success' ? 'text-success' : 'text-danger'}`}
                    role="status"
                  >
                    {compactStatus.message}
                  </p>
                ) : null}
              </div>
              <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-subtle text-xs font-[760] m-0">工具调用</p>
                  {executions.length > 0 && (
                    <Button variant="ghost" size="xs" onClick={clearExecutions}>
                      清空
                    </Button>
                  )}
                </div>
                <ToolCardList
                  executions={executions}
                  emptyHint="暂无工具调用，发送消息后这里会显示工具执行状态"
                />
              </div>
              <div className="bg-surface-2 border border-border rounded-lg grid gap-1 p-3">
                <p className="text-subtle text-xs font-[760] m-0">当前里程碑</p>
                <strong className="font-[760] leading-tight">F1 SSE 流式对话</strong>
              </div>
            </section>
          )}
        </aside>
      </div>

      {/* ── Status bar ── */}
      <footer className="flex items-center gap-3 min-w-0 overflow-hidden px-3 bg-statusbar-bg border-t border-statusbar-border">
        <span
          className={`shrink-0 size-[9px] rounded-full ${isOnline ? 'bg-success shadow-[0_0_0_4px_rgba(47,209,124,0.16)]' : 'bg-danger shadow-[0_0_0_4px_rgba(255,107,107,0.16)]'}`}
        />
        <span className="text-muted text-xs whitespace-nowrap">{statusText}</span>
        <span className="text-muted text-xs whitespace-nowrap">·</span>
        <PermissionModeSwitch compact />
        <span className="text-muted text-xs whitespace-nowrap">·</span>
        <span className="text-muted text-xs whitespace-nowrap">{wsStatusText}</span>
        <span className="text-muted text-xs whitespace-nowrap">·</span>
        <span className="text-muted text-xs whitespace-nowrap">{providerSummary}</span>
      </footer>

      {/* ── 确认对话框（由 WebSocket 事件驱动） ── */}
      <ConfirmationDialog request={pendingConfirmation} onRespond={respondConfirmation} />
    </div>
  )
}

function loadProviderSummary(): string {
  if (typeof window === 'undefined') return '未配置 Provider'

  const raw = window.localStorage.getItem('pi-agent.provider')
  if (!raw) return '未配置 Provider'

  try {
    const settings = JSON.parse(raw) as ProviderSettings
    return `${settings.provider} · ${settings.model}`
  } catch {
    return '未配置 Provider'
  }
}

function getCompactStatusText(status: CompactStatus): string {
  switch (status.state) {
    case 'running':
      return '正在调用 Pi SDK compact，完成前请避免重复触发。'
    case 'success':
      return '最近一次压缩已完成。'
    case 'error':
      return '最近一次压缩失败，请检查 Agent Server。'
    case 'idle':
      return '长对话时可手动触发 Pi SDK 会话压缩。'
  }
}

function createEmptyMessageState(): MessageStreamState {
  return {
    messages: [],
    activeRunId: null,
    streamError: null
  }
}

function loadSessions(): SessionSummary[] {
  const stored = loadJson<SessionSummary[]>('pi-agent.sessions')
  if (!stored || stored.length === 0) return defaultSessions
  return stored
}

function loadCurrentSessionId(sessions: SessionSummary[]): string {
  const stored = loadString('pi-agent.currentSessionId')
  if (stored && sessions.some((session) => session.id === stored)) {
    return stored
  }
  return sessions[0]?.id ?? 'desktop-main'
}

function loadSessionMessages(): Record<string, MessageStreamState> {
  return loadJson<Record<string, MessageStreamState>>('pi-agent.sessionMessages') ?? {}
}

function loadDrafts(): Record<string, string> {
  return loadJson<Record<string, string>>('pi-agent.drafts') ?? {}
}

function upsertSessionAfterSend(
  sessions: SessionSummary[],
  sessionId: string,
  text: string
): SessionSummary[] {
  const title = text.length > 24 ? `${text.slice(0, 24)}...` : text
  const preview = text.length > 42 ? `${text.slice(0, 42)}...` : text
  const existing = sessions.find((session) => session.id === sessionId)

  if (!existing) {
    return [
      {
        id: sessionId,
        title,
        preview,
        time: '现在'
      },
      ...sessions
    ]
  }

  return sessions.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          title: session.title === '新会话' ? title : session.title,
          preview,
          time: '现在'
        }
      : session
  )
}

function loadJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null

  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function saveJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

function loadString(key: string): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(key)
}

function saveString(key: string, value: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, value)
}
