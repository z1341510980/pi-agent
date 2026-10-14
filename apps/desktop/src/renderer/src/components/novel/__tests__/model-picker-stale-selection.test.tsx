/**
 * ModelPicker 失效选择自动清理。
 *
 * 背景：Provider 模型列表裁剪后（如删除不可用的 mistral/gemini），
 * localStorage 里持久化的旧选择仍指向不存在的模型；后端会直接报
 * "未找到所选模型"让整次创作失败。选择器应在清单加载后主动校验并恢复默认。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../model-picker'

const getApi = vi.fn()

vi.mock('@/api/http-client', () => ({
  getApi: (...args: unknown[]) => getApi(...args)
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/hooks/use-toast', () => ({
  toastWarning: vi.fn()
}))

afterEach(cleanup)

const PROVIDERS = [
  {
    id: 'xkiro',
    name: 'xkiro',
    models: [{
      id: 'minimax/minimax-m2.7',
      name: 'minimax-m2.7',
      reasoning: true,
      supportedReasoningEfforts: ['low', 'high'],
    }]
  }
]

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderWithQueryClient(ui: ReactElement, queryClient = createQueryClient()): void {
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function renderPicker(value: { provider: string; modelId: string } | null, onChange = vi.fn()): { onChange: typeof onChange } {
  renderWithQueryClient(<ModelPicker value={value} onChange={onChange} />)
  return { onChange }
}

describe('ModelPicker 失效选择自动清理', () => {
  it('持久化选择指向已下架模型时，自动回调 onChange(null) 并提示', async () => {
    getApi.mockResolvedValue(PROVIDERS)
    const onChange = vi.fn()
    renderPicker({ provider: 'xkiro', modelId: 'nvidia/nemotron-3-ultra' }, onChange)

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(null)
    })
    // 触发器文案回落为默认（mock 同时渲染 trigger 与内容区，文本会出现多次）
    await waitFor(() => {
      expect(screen.getAllByText('默认模型').length).toBeGreaterThan(0)
    })
  })

  it('有效选择不触发清理', async () => {
    getApi.mockResolvedValue(PROVIDERS)
    const onChange = vi.fn()
    renderPicker({ provider: 'xkiro', modelId: 'minimax/minimax-m2.7' }, onChange)

    await waitFor(() => {
      expect(getApi).toHaveBeenCalled()
    })
    // 留出 effect 执行窗口
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getAllByText('minimax-m2.7').length).toBeGreaterThan(0)
  })

  it('小说顶栏支持在统一模型与按 Agent 模式间切换', async () => {
    getApi.mockResolvedValue(PROVIDERS)
    const onModeChange = vi.fn()
    renderWithQueryClient(
      <ModelPicker
        value={null}
        onChange={vi.fn()}
        mode="per-agent"
        onModeChange={onModeChange}
        onAgentModelChange={vi.fn()}
        agentModels={[{ agentType: 'writer', label: '写作 Agent', model: null }]}
      />,
    )

    expect(screen.getByRole('button', { name: '统一模型' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '按 Agent' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '统一模型' }))
    expect(onModeChange).toHaveBeenCalledWith('unified')
  })

  it('按 Agent 模式选择模型时回调对应角色', async () => {
    getApi.mockResolvedValue(PROVIDERS)
    const onAgentModelChange = vi.fn()
    renderWithQueryClient(
      <ModelPicker
        value={null}
        onChange={vi.fn()}
        mode="per-agent"
        onModeChange={vi.fn()}
        onAgentModelChange={onAgentModelChange}
        agentModels={[{ agentType: 'writer', label: '写作 Agent', model: null }]}
      />,
    )

    const selector = await screen.findByRole('combobox', { name: '写作 Agent模型' })
    expect(selector.getAttribute('data-slot')).toBe('select-trigger')
    fireEvent.pointerDown(selector, { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('option', { name: /minimax-m2\.7/ }))
    expect(onAgentModelChange).toHaveBeenCalledWith('writer', {
      provider: 'xkiro',
      modelId: 'minimax/minimax-m2.7',
      thinkingLevel: null,
    })
  })

  it('按 Agent 模式可以单独选择思考强度', async () => {
    getApi.mockResolvedValue(PROVIDERS)
    const onAgentModelChange = vi.fn()
    renderWithQueryClient(
      <ModelPicker
        value={null}
        onChange={vi.fn()}
        mode="per-agent"
        onModeChange={vi.fn()}
        onAgentModelChange={onAgentModelChange}
        agentModels={[{
          agentType: 'writer',
          label: '写作 Agent',
          model: { provider: 'xkiro', modelId: 'minimax/minimax-m2.7', thinkingLevel: 'low' },
        }]}
      />,
    )

    const thinkingSelector = await screen.findByRole('combobox', { name: '写作 Agent思考强度' })
    expect(thinkingSelector.getAttribute('data-slot')).toBe('select-trigger')
    await waitFor(() => expect(thinkingSelector.textContent).toContain('低'))
    fireEvent.pointerDown(thinkingSelector, { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('option', { name: '高' }))
    expect(onAgentModelChange).toHaveBeenCalledWith('writer', {
      provider: 'xkiro',
      modelId: 'minimax/minimax-m2.7',
      thinkingLevel: 'high',
    })
  })

  it('Provider 列表缓存失效后会显示新添加的模型', async () => {
    getApi.mockClear()
    const updatedProviders = [
      ...PROVIDERS,
      { id: 'new-provider', name: 'New Provider', models: [{ id: 'new-model', name: '新模型' }] },
    ]
    getApi.mockResolvedValueOnce(PROVIDERS).mockResolvedValueOnce(updatedProviders)
    const queryClient = createQueryClient()
    renderWithQueryClient(
      <ModelPicker value={null} onChange={vi.fn()} />,
      queryClient,
    )

    await screen.findAllByText('minimax-m2.7')
    await queryClient.invalidateQueries({ queryKey: ['providers'] })

    expect(await screen.findByText('新模型')).toBeTruthy()
    expect(getApi).toHaveBeenCalledTimes(2)
  })
})
