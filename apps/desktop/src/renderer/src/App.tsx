import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { CopilotKit, CopilotSidebar, useAgentContext } from '@copilotkit/react-core/v2'
import { browserConfig } from '@repo/config/browser'
import { getApi } from './api'

type HealthData = {
  service: string
  status: string
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000
    }
  }
})

const copilotRuntimeUrl = `${browserConfig.aguiBaseUrl}/copilotkit`

function CopilotContextBridge(): null {
  const value = useMemo(
    () => ({
      appName: browserConfig.appName,
      apiBaseUrl: browserConfig.apiBaseUrl,
      copilotRuntimeUrl
    }),
    []
  )

  useAgentContext({
    description: 'PI Agent desktop runtime configuration',
    value
  })

  return null
}

function HomeView(): ReactElement {
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

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">PI Agent Desktop</p>
            <h1>Agent 工作台</h1>
          </div>

          <button
            className="refresh-button"
            type="button"
            onClick={() => void healthQuery.refetch()}
            disabled={healthQuery.isFetching}
          >
            {healthQuery.isFetching ? '刷新中' : '刷新'}
          </button>
        </header>

        <section className="status-grid" aria-label="runtime status">
          <div className="status-panel">
            <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
            <div>
              <p className="status-label">Agent Server</p>
              <p className="status-value">{statusText}</p>
            </div>
          </div>

          <div className="status-panel">
            <span className="status-dot pending" />
            <div>
              <p className="status-label">CopilotKit Runtime</p>
              <p className="status-value">{copilotRuntimeUrl}</p>
            </div>
          </div>
        </section>

        <section className="integration-panel">
          <h2>当前集成状态</h2>
          <div className="integration-list">
            <div>
              <strong>React renderer</strong>
              <span>已接管 Electron 渲染入口</span>
            </div>
            <div>
              <strong>TanStack Query</strong>
              <span>用于健康检查、缓存、刷新和错误状态</span>
            </div>
            <div>
              <strong>CopilotKit Sidebar</strong>
              <span>前端组件已接入，等待后端 Runtime 端点</span>
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}

export default function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKit
        runtimeUrl={copilotRuntimeUrl}
        properties={{
          appName: browserConfig.appName
        }}
        onError={(event) => {
          console.warn('[copilotkit]', event)
        }}
      >
        <CopilotContextBridge />
        <HomeView />
        <CopilotSidebar
          agentId="pi-agent"
          threadId="desktop-main"
          defaultOpen
          width={440}
          labels={{
            chatInputPlaceholder: '询问 PI Agent...'
          }}
        />
      </CopilotKit>
    </QueryClientProvider>
  )
}
