import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@repo/config/browser', () => ({
  browserConfig: {
    appName: 'PI Agent Desktop',
    apiBaseUrl: 'http://127.0.0.1:3900',
    aguiBaseUrl: 'http://127.0.0.1:3900',
    mode: 'test'
  }
}))

vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotKit: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CopilotSidebar: () => <aside>CopilotKit Runtime</aside>,
  useAgentContext: () => undefined
}))

describe('App shell', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          ok: true,
          data: {
            service: 'agent-server',
            status: 'online'
          },
          meta: {
            traceId: 'test-trace'
          }
        })
      }))
    )
  })

  it('renders the pi-agent workspace instead of the CopilotKit sidebar shell', async () => {
    const { default: App } = await import('./App')

    render(<App />)

    expect(screen.getByRole('main', { name: 'PI Agent 工作台' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '会话' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '上下文' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '配置 Provider' })).toBeInTheDocument()
    expect(screen.queryByText('CopilotKit Runtime')).not.toBeInTheDocument()
  })
})
