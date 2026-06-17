import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BrowserConfig } from '@repo/config/shared'
import { getApi } from '../../api'
import { ProviderBootstrap, type ProviderSettings } from '../settings/provider-bootstrap'

type HealthData = {
  service: string
  status: string
}

type ChatWorkspaceProps = {
  appName: string
  config: BrowserConfig
}

const defaultSessions = [
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

  const healthQuery = useQuery({
    queryKey: ['agent-server-health'],
    queryFn: () => getApi<HealthData>('/api/health'),
    refetchInterval: 10_000
  })

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

  return (
    <div className="app-frame">
      <header className="title-bar">
        <div className="title-bar__drag">
          <span className="app-mark">π</span>
          <span>{appName}</span>
        </div>
        <div className="title-bar__actions" aria-label="窗口操作">
          <button type="button" aria-label="最小化" />
          <button type="button" aria-label="最大化" />
          <button type="button" aria-label="关闭" />
        </div>
      </header>

      <div className="workspace-grid">
        <nav className="sidebar" aria-label="会话">
          <div className="sidebar__header">
            <button className="agent-switcher" type="button" aria-label="切换 Agent">
              <span className="agent-avatar">pi</span>
              <span>
                <strong>pi</strong>
                <small>代码助手</small>
              </span>
            </button>
            <button className="icon-button" type="button" aria-label="新建会话">
              +
            </button>
          </div>

          <label className="search-box">
            <span>搜索会话</span>
            <input type="search" placeholder="搜索会话..." />
          </label>

          <div className="session-group" aria-label="今天">
            <p>今天</p>
            {defaultSessions.map((session) => (
              <button className="session-item" key={session.id} type="button">
                <span>
                  <strong>{session.title}</strong>
                  <small>{session.preview}</small>
                </span>
                <time>{session.time}</time>
              </button>
            ))}
          </div>
        </nav>

        <main className="chat-main" aria-label="PI Agent 工作台">
          <header className="chat-header">
            <div>
              <p className="eyebrow">PI Agent</p>
              <h1>Agent 工作台</h1>
            </div>
            <div className="chat-header__actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void healthQuery.refetch()}
                disabled={healthQuery.isFetching}
              >
                {healthQuery.isFetching ? '刷新中' : '刷新状态'}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => setRightPanel('provider')}
              >
                配置 Provider
              </button>
            </div>
          </header>

          <section className="runtime-strip" aria-label="运行状态">
            <div>
              <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
              <span>Agent Server</span>
              <strong>{statusText}</strong>
            </div>
            <div>
              <span className="status-dot pending" />
              <span>AG-UI</span>
              <strong>{config.aguiBaseUrl}</strong>
            </div>
          </section>

          <section className="message-stage" aria-label="消息流">
            <article className="assistant-message">
              <div className="message-avatar">pi</div>
              <div className="message-body">
                <p className="message-meta">pi · 准备就绪</p>
                <p>
                  工作台骨架已接入。下一步会把输入区和 SSE 流式消息接到 AG-UI
                  端点，替换临时占位消息。
                </p>
              </div>
            </article>
          </section>

          <form className="composer" aria-label="发送消息">
            <textarea placeholder="询问 PI Agent..." rows={3} />
            <div className="composer__footer">
              <span>Auto · {providerSummary}</span>
              <button type="button" disabled>
                发送
              </button>
            </div>
          </form>
        </main>

        <aside className="context-panel" aria-label="上下文">
          <div className="panel-tabs" role="tablist" aria-label="右侧面板">
            <button
              className={rightPanel === 'context' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={rightPanel === 'context'}
              onClick={() => setRightPanel('context')}
            >
              上下文
            </button>
            <button
              className={rightPanel === 'provider' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={rightPanel === 'provider'}
              onClick={() => setRightPanel('provider')}
            >
              Provider
            </button>
          </div>

          {rightPanel === 'provider' ? (
            <ProviderBootstrap />
          ) : (
            <section className="context-stack">
              <div>
                <p className="panel-label">模型</p>
                <strong>{providerSummary}</strong>
              </div>
              <div>
                <p className="panel-label">权限</p>
                <strong>Auto</strong>
              </div>
              <div>
                <p className="panel-label">下一里程碑</p>
                <strong>F1 SSE 流式对话</strong>
              </div>
            </section>
          )}
        </aside>
      </div>

      <footer className="status-bar">
        <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
        <span>{statusText}</span>
        <span>Agent: pi</span>
        <span>{providerSummary}</span>
      </footer>
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
