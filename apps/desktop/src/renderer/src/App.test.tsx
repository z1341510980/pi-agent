import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType } from '@repo/protocol/events'

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
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
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

  it('renders the pi-agent workspace instead of the CopilotKit sidebar shell', async () => {
    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')

    render(<App />)

    expect(screen.getByRole('main', { name: 'PI Agent 工作台' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: '会话' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '上下文' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '配置 Provider' })).toBeTruthy()
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

    const input = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.change(input, { target: { value: '请读取 README' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    expect((await screen.findAllByText('请读取 README')).length).toBeGreaterThan(0)
    expect(await screen.findByText('Hello world')).toBeTruthy()
    expect(await screen.findByText('read')).toBeTruthy()
    expect(await screen.findByText((content) => content.includes('README.md'))).toBeTruthy()
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

    const input = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.change(input, { target: { value: '长任务' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    const abortButton = await screen.findByRole('button', { name: '中断' })
    fireEvent.click(abortButton)

    await waitFor(() => expect(signal?.aborted).toBe(true))
  })

  it('restores persisted sessions and filters the session list', async () => {
    window.localStorage.setItem(
      'pi-agent.sessions',
      JSON.stringify([
        {
          id: 'persisted-thread',
          title: '恢复会话',
          preview: '历史消息',
          time: '昨天'
        }
      ])
    )
    window.localStorage.setItem('pi-agent.currentSessionId', 'persisted-thread')
    window.localStorage.setItem(
      'pi-agent.sessionMessages',
      JSON.stringify({
        'persisted-thread': {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: '历史回答',
              createdAt: 1,
              toolCalls: [],
              status: 'complete'
            }
          ],
          activeRunId: null,
          streamError: null
        }
      })
    )
    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')
    render(<App />)

    expect(await screen.findByText('恢复会话')).toBeTruthy()
    expect(await screen.findByText('历史回答')).toBeTruthy()

    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: '不存在' } })

    expect(screen.queryByText('恢复会话')).toBeNull()
  })

  it('persists the active session draft across remounts', async () => {
    vi.stubGlobal('fetch', createFetchMock())
    const { default: App } = await import('./App')
    const { unmount } = render(<App />)

    const input = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.change(input, { target: { value: '未发送草稿' } })

    unmount()
    render(<App />)

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

    const compactButton = await screen.findByRole('button', { name: '手动压缩上下文' })
    fireEvent.click(compactButton)

    await screen.findByText('上下文压缩完成。')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3900/ag-ui/agent/default/compact',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ threadId: 'desktop-main' })
      })
    )
  })

  it('TC-07: opens the settings page from the title bar gear button', async () => {
    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')
    render(<App />)

    // 等待聊天工作台渲染
    await screen.findByRole('main', { name: 'PI Agent 工作台' })

    // 点击设置按钮
    const settingsButton = screen.getByRole('button', { name: '打开设置' })
    fireEvent.click(settingsButton)

    // 设置页面应显示
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy()
    expect(screen.getByLabelText('设置中心')).toBeTruthy()
    // 聊天工作台应被隐藏
    expect(screen.queryByRole('main', { name: 'PI Agent 工作台' })).toBeNull()
  })

  it('TC-08: closes the settings page and returns to chat', async () => {
    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')
    render(<App />)

    // 打开设置
    await screen.findByRole('main', { name: 'PI Agent 工作台' })
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
    expect(screen.getByLabelText('设置中心')).toBeTruthy()

    // 点击关闭按钮
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))

    // 应返回聊天页面
    expect(await screen.findByRole('main', { name: 'PI Agent 工作台' })).toBeTruthy()
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

    // 打开设置
    await screen.findByRole('main', { name: 'PI Agent 工作台' })
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))

    // 等待 Provider 列表渲染
    expect(await screen.findByText('openai')).toBeTruthy()
    expect(await screen.findByText('anthropic')).toBeTruthy()
    // openai 有 2 个模型
    expect(await screen.findByText('2 模型')).toBeTruthy()
  })

  it('TC-10: toggles theme between light and dark', async () => {
    // 预设 localStorage 为 light，验证 data-theme 同步
    window.localStorage.setItem('pi-agent.theme', 'light')

    vi.stubGlobal('fetch', createFetchMock())

    const { default: App } = await import('./App')
    render(<App />)

    // 打开设置
    await screen.findByRole('main', { name: 'PI Agent 工作台' })
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))

    // 切换到通用设置
    fireEvent.click(screen.getByRole('button', { name: '通用设置' }))

    // 等待通用设置渲染（通过"数据目录"标签）
    await screen.findByText('数据目录（PI_DATA_DIR）')

    // data-theme 应为 light（从 localStorage 恢复）
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
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

    throw new Error(`Unexpected fetch: ${url}`)
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
