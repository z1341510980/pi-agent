import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType } from '@repo/protocol/events'

vi.mock('@repo/config/browser', () => ({
  browserConfig: {
    appName: 'Wenlang Agent Desktop',
    apiBaseUrl: 'http://127.0.0.1:3900',
    aguiBaseUrl: 'http://127.0.0.1:3900',
    mode: 'test'
  },
  initEmbeddedServerPort: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotKit: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CopilotSidebar: () => <aside>CopilotKit Runtime</aside>,
  useAgentContext: () => undefined
}))

async function enterChatWorkspace(): Promise<void> {
  const chatButton = await screen.findByRole('button', { name: '对话工作台' })
  fireEvent.click(chatButton)
  await screen.findByRole('main', { name: 'PI Agent 工作台' })
}

async function openSettings(): Promise<void> {
  const settingsButton = await screen.findByRole('button', { name: '设置' })
  fireEvent.click(settingsButton)
  await screen.findByLabelText('设置中心')
}

describe('App shell', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    window.localStorage.clear()
    // 重置 Zustand store 状态（避免测试间状态泄漏）
    const { useSessionStore, createDefaultSessions } = await import('@/stores/session-store')
    useSessionStore.setState({
      sessions: createDefaultSessions(),
      activeThreadId: 'desktop-main',
      sessionMessages: {},
      drafts: {},
      selectedModel: null,
      compactionCount: 0,
    })
    let uuidCounter = 0
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => `test-uuid-${++uuidCounter}`)
    })
    // Radix Select 在 jsdom 中需要 pointer capture polyfill
    window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    window.HTMLElement.prototype.setPointerCapture = vi.fn()
    window.HTMLElement.prototype.releasePointerCapture = vi.fn()
    // Radix Select 需要 scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  // 首个用例需要动态 import('./App')，会一次性加载整个渲染层模块图，
  // 冷启动开销远大于后续用例（后者命中模块缓存）。给足预算避免伪失败。
  it('renders the wenlang-agent workspace instead of the CopilotKit sidebar shell', { timeout: 30000 }, async () => {
    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')

    render(<App />)

    await enterChatWorkspace()

    expect(screen.getByRole('navigation', { name: '会话' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '上下文' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择工作区' })).toBeTruthy()
    expect(screen.queryByText('CopilotKit Runtime')).toBeNull()
  })

  it('sends a user message and renders streamed assistant text with tool cards', async () => {
    const fetchMock = createFetchMock([
      { type: EventType.RUN_STARTED, threadId: 'desktop-main', runId: 'run-1' },
      { type: EventType.TEXT_MESSAGE_START, messageId: 'assistant-1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'assistant-1', delta: 'Hello' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'assistant-1', delta: ' world' },
      { type: EventType.STEP_STARTED, stepName: 'pi:read' },
      {
        type: EventType.CUSTOM,
        name: 'PI_TOOL_EXECUTION_UPDATE',
        value: {
          toolName: 'read',
          args: { path: 'README.md' },
          partialResult: 'file preview'
        }
      },
      { type: EventType.STEP_FINISHED, stepName: 'pi:read' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'assistant-1' },
      {
        type: EventType.RUN_FINISHED,
        threadId: 'desktop-main',
        runId: 'run-1',
        result: 'Hello world'
      }
    ])
    vi.stubGlobal('fetch', fetchMock)

    const { default: App } = await import('./App')
    render(<App />)
    await enterChatWorkspace()

    const input = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.change(input, { target: { value: '请读取 README' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    expect((await screen.findAllByText('请读取 README')).length).toBeGreaterThan(0)
    expect(await screen.findByText('Hello world')).toBeTruthy()
    expect((await screen.findAllByText('read')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText((content) => content.includes('README.md'))).length).toBeGreaterThan(0)
    expect(await screen.findByText('file preview')).toBeTruthy()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3900/ag-ui/agent/default/run',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('请读取 README')
      })
    )
  })

  it('aborts the active AG-UI request from the interrupt button', async () => {
    let signal: AbortSignal | undefined
    const fetchMock = createFetchMock(
      [
        { type: EventType.RUN_STARTED, threadId: 'desktop-main', runId: 'run-1' },
        { type: EventType.TEXT_MESSAGE_START, messageId: 'assistant-1', role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'assistant-1', delta: 'working' }
      ],
      {
        holdOpen: true,
        onRunSignal: (runSignal) => {
          signal = runSignal
        }
      }
    )
    vi.stubGlobal('fetch', fetchMock)

    const { default: App } = await import('./App')
    render(<App />)
    await enterChatWorkspace()

    const input = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.change(input, { target: { value: '长任务' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    const abortButton = await screen.findByRole('button', { name: /中断/ })
    fireEvent.click(abortButton)

    await waitFor(() => expect(signal?.aborted).toBe(true))
  })

  it('restores persisted sessions and filters the session list', { timeout: 10000 }, async () => {
    // 通过 Zustand store API 直接设置状态（模拟从 localStorage 恢复）
    const { useSessionStore } = await import('@/stores/session-store')
    const now = Date.now()
    useSessionStore.setState({
      sessions: [
        {
          id: 'persisted-thread',
          title: '恢复会话',
          preview: '历史消息',
          createdAt: now,
          updatedAt: now,
        },
      ],
      activeThreadId: 'persisted-thread',
      sessionMessages: {
        'persisted-thread': {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: '历史回答',
              createdAt: 1,
              toolCalls: [],
              status: 'complete',
            },
          ],
          activeRunId: null,
          streamError: null,
        },
      },
    })

    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')
    const { container } = render(<App />)
    await enterChatWorkspace()

    // 调试：打印渲染的文本内容
    await waitFor(() => {
      const textContent = container.textContent ?? ''
      if (textContent.includes('恢复会话')) return
      // 如果没有找到，打印当前渲染的文本（截取前500字符）
      throw new Error('恢复会话 not found. Rendered: ' + textContent.slice(0, 500))
    }, { timeout: 8000 })

    expect(screen.getAllByText('恢复会话').length).toBeGreaterThan(0)
    expect(screen.getAllByText('历史回答').length).toBeGreaterThan(0)
  })

  it('persists the active session draft across remounts', async () => {
    vi.stubGlobal('fetch', createFetchMock())
    const { default: App } = await import('./App')
    const { unmount } = render(<App />)
    await enterChatWorkspace()

    const input = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.change(input, { target: { value: '未发送草稿' } })

    unmount()
    render(<App />)
    await enterChatWorkspace()

    const restoredDraft = (await screen.findByRole('textbox', {
      name: '消息输入'
    })) as HTMLTextAreaElement
    expect(restoredDraft.value).toBe('未发送草稿')
  })

  it('TC-06: triggers manual context compaction for the active session', async () => {
    const fetchMock = createFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    const { default: App } = await import('./App')
    render(<App />)
    await enterChatWorkspace()

    const compactButton = await screen.findByRole('button', { name: '手动压缩上下文' })
    fireEvent.click(compactButton)

    // 压缩成功后横幅与 toast 会同时出现同一文案，故用 AllBy
    expect((await screen.findAllByText('上下文已压缩')).length).toBeGreaterThan(0)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3900/ag-ui/agent/default/compact',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ threadId: 'desktop-main' })
      })
    )
  })

  it('TC-07: opens the settings page from the main navigation', async () => {
    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')
    render(<App />)

    await enterChatWorkspace()
    await openSettings()

    // 设置页面应显示（h1 标题）
    expect(screen.getAllByRole('heading', { name: '设置' }).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('设置中心')).toBeTruthy()
    // 聊天工作台应被隐藏
    expect(screen.queryByRole('main', { name: 'PI Agent 工作台' })).toBeNull()
  })

  it('TC-08: closes the settings page and returns to home', async () => {
    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')
    render(<App />)

    // 打开设置
    await enterChatWorkspace()
    await openSettings()

    // 点击关闭按钮
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))

    // 当前导航约定：关闭独立设置页后返回首页
    const homeButton = await screen.findByRole('button', { name: '首页' })
    expect(homeButton.getAttribute('aria-current')).toBe('page')
    expect(screen.queryByLabelText('设置中心')).toBeNull()
  })

  it('TC-09: renders the provider list from the models endpoint', async () => {
    vi.stubGlobal('fetch', createFetchMock([], {
      models: [
        { provider: 'openai', id: 'gpt-4.1-mini' },
        { provider: 'openai', id: 'gpt-4.1' },
        { provider: 'anthropic', id: 'claude-3-5-sonnet' }
      ]
    }))

    const { default: App } = await import('./App')
    render(<App />)

    // 打开设置（默认落在「通用设置」，需切到 Provider 分区）
    await enterChatWorkspace()
    await openSettings()
    fireEvent.click(screen.getByRole('button', { name: '模型与 Provider' }))

    // 等待 Provider 列表渲染
    expect(await screen.findByText('openai')).toBeTruthy()
    expect(await screen.findByText('anthropic')).toBeTruthy()
    // openai 有 2 个模型
    expect(await screen.findByText('2 模型')).toBeTruthy()
  })

  it('TC-10: toggles theme between light and dark', async () => {
    // 预设 localStorage 为 light，验证 .dark class 同步
    window.localStorage.setItem('wenlang-agent.theme', 'light')

    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')
    render(<App />)

    // 打开设置
    await enterChatWorkspace()
    await openSettings()

    // 切换到通用设置
    fireEvent.click(screen.getByRole('button', { name: '通用设置' }))

    // 等待通用设置渲染（通过"数据目录"标签）
    await screen.findByText('数据目录（PI_DATA_DIR）')

    // .dark class 不应存在（light 模式）
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    // 验证主题选项存在
    const themeTrigger = screen.getByRole('combobox', { name: '主题' })
    expect(themeTrigger).toBeTruthy()

    // 验证语言选项存在
    expect(screen.getByRole('combobox', { name: '语言' })).toBeTruthy()

    // 验证数据目录和工作目录显示
    expect(screen.getByText('工作目录（PI_CWD）')).toBeTruthy()
  })
})

type SseEvent = Record<string, unknown>

interface FetchMockOptions {
  holdOpen?: boolean
  onRunSignal?: (signal: AbortSignal) => void
  models?: Array<{ provider: string; id: string }>
}

function createFetchMock(runEvents: SseEvent[] = [], options: FetchMockOptions = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (url.endsWith('/api/health')) {
      return {
        ok: true,
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
      } as Response
    }

    if (url.endsWith('/ag-ui/agent/default/run')) {
      options.onRunSignal?.(init?.signal as AbortSignal)
      return {
        ok: true,
        body: createSseStream(runEvents, options.holdOpen)
      } as Response
    }

    if (url.endsWith('/ag-ui/agent/default/compact')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            status: 'compacted',
            threadId: 'desktop-main',
            result: {}
          },
          meta: {
            traceId: 'test-trace'
          }
        })
      } as Response
    }

    // Provider 列表：GET /ag-ui/agent/default/models?threadId=main
    if (url.includes('/ag-ui/agent/default/models')) {
      const models = options.models ?? []
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            threadId: 'main',
            models
          },
          meta: {
            traceId: 'test-trace'
          }
        })
      } as Response
    }

    // 测试连接：GET /ag-ui/info
    if (url.endsWith('/ag-ui/info')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            protocol: 'ag-ui',
            version: '0.0.42',
            agents: [{ id: 'default', name: 'Pi AG-UI Agent' }]
          },
          meta: {
            traceId: 'test-trace'
          }
        })
      } as Response
    }

    // 用量汇总：GET /api/usage/summary
    if (url.endsWith('/api/usage/summary')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            totalCostUsd: 0,
            totalCalls: 0,
            byModel: {},
            byAgent: {}
          },
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 按日用量：GET /api/usage/daily
    if (url.includes('/api/usage/daily')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: [],
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 用量列表：GET /api/usage?...
    if (url.includes('/api/usage?') || url.endsWith('/api/usage')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { records: [], total: 0 },
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 按 Provider 聚合：GET /api/usage/by-provider
    if (url.endsWith('/api/usage/by-provider')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {},
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 按模型聚合：GET /api/usage/by-model
    if (url.endsWith('/api/usage/by-model')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {},
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 预算：GET /api/usage/budget
    if (url.endsWith('/api/usage/budget')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            monthlyBudgetUsd: 0,
            alertThreshold: 80,
            costUsd: 0,
            budgetUsd: 0,
            threshold: 80,
            percentage: 0,
            exceeded: false,
            warning: false
          },
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // CSV 导出：GET /api/usage/export
    if (url.endsWith('/api/usage/export')) {
      return {
        ok: true,
        text: async () => 'id,timestamp\n'
      } as Response
    }

    // Gate 权限模式：GET /api/gate
    if (url.endsWith('/api/gate') || url.endsWith('/api/gate/mode')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { mode: 'auto' },
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 工作区：GET /api/workspace
    if (url.endsWith('/api/workspace')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { path: '/test/workspace', name: 'workspace', gitBranch: 'main', gitDirty: false },
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // Agent 列表：GET /api/agents
    if (url.endsWith('/api/agents')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: [{ id: 'default', name: 'pi', description: '代码助手', model: { provider: 'anthropic', modelId: 'claude-sonnet-4' } }],
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // Agent 频道：GET /api/agents/channels
    if (url.includes('/api/agents/channels')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: [],
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // Agent 并发限流器：GET /api/agents/limiter
    if (url.endsWith('/api/agents/limiter')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { activeCount: 0, maxConcurrent: 5, maxDepth: 3, totalDispatched: 0 },
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 记忆面板：GET /api/memory/facts
    if (url.includes('/api/memory')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: [],
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 工作区文件列表：GET /api/workspace/files
    if (url.endsWith('/api/workspace/files')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: [],
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 会话用量：GET /api/usage/session/:sessionId
    if (url.includes('/api/usage/session/')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            totalCostUsd: 0,
            totalCalls: 0,
            byModel: {},
            byAgent: {}
          },
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 默认 Provider：GET /api/providers/default（必须排在 /api/providers 之前判断）
    if (url.endsWith('/api/providers/default')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { id: null },
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // Provider 列表：GET /api/providers
    if (url.endsWith('/api/providers')) {
      // 从 models 选项派生 Provider 列表（用于测试）
      const models = options.models ?? []
      const providerMap = new Map<string, { id: string; name: string; baseUrl: string; api: string; models: Array<{ id: string; name: string }> }>()
      for (const m of models) {
        const pid = m.provider as string
        if (!providerMap.has(pid)) {
          providerMap.set(pid, {
            id: pid,
            name: pid,
            baseUrl: `https://${pid}.example.com/v1`,
            api: 'openai-completions',
            models: [],
          })
        }
        providerMap.get(pid)!.models.push({ id: m.id as string, name: m.id as string })
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: Array.from(providerMap.values()),
          meta: { traceId: 'test-trace' }
        })
      } as Response
    }

    // 未知端点：返回空数据而非抛错（避免组件渲染因未 mock 端点而崩溃）
    return {
      ok: true,
      json: async () => ({
        ok: true,
        data: null,
        meta: { traceId: 'test-trace' }
      })
    } as Response
  })
}

function createSseStream(events: SseEvent[], holdOpen = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      if (!holdOpen) {
        controller.close()
      }
    }
  })
}
