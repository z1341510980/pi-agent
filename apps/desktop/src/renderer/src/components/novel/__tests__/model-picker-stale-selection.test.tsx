/**
 * ModelPicker 失效选择自动清理。
 *
 * 背景：Provider 模型列表裁剪后（如删除不可用的 mistral/gemini），
 * localStorage 里持久化的旧选择仍指向不存在的模型；后端会直接报
 * "未找到所选模型"让整次创作失败。选择器应在清单加载后主动校验并恢复默认。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    models: [{ id: 'minimax/minimax-m2.7', name: 'minimax-m2.7' }]
  }
]

function renderPicker(value: { provider: string; modelId: string } | null, onChange = vi.fn()) {
  render(<ModelPicker value={value} onChange={onChange} />)
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
})
