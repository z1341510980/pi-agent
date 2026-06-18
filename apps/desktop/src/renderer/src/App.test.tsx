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
})

type SseEvent = Record<string, unknown>

interface FetchMockOptions {
  holdOpen?: boolean
  onRunSignal?: (signal: AbortSignal) => void
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
