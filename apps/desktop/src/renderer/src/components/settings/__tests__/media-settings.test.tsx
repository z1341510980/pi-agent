/**
 * 媒体生成设置分区测试
 *
 * 覆盖：四模态 tab 渲染与切换懒加载、图片 Provider 卡片渲染（名称/默认徽标/keyHint 掩码）、
 * 空态引导卡、formSchema 驱动的动态表单字段（openai-images ↔ apimart）、
 * 设为默认调用客户端、文字 tab 内嵌 ProviderManager。
 *
 * mock 策略：媒体客户端整体替换（@/api/media-provider-client）；
 * 文字 tab 内嵌的 ProviderManager 走 '@/api' 通用 HTTP 客户端，给最小 mock 让其空列表落地。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MediaAdapterMeta, MediaProviderRow } from '@/api/media-provider-client'
import { MediaSettings } from '../media-settings'

const mediaApi = vi.hoisted(() => ({
  listMediaAdapters: vi.fn(),
  listMediaProviders: vi.fn(),
  createMediaProvider: vi.fn(),
  updateMediaProvider: vi.fn(),
  deleteMediaProvider: vi.fn(),
  setMediaProviderDefault: vi.fn()
}))

vi.mock('@/api/media-provider-client', () => mediaApi)

const httpApi = vi.hoisted(() => ({
  getApi: vi.fn(),
  postApi: vi.fn(),
  deleteApi: vi.fn(),
  getAgui: vi.fn()
}))

vi.mock('@/api', () => httpApi)

// formSchema 与服务端 adapter 声明对齐（openai-images: size；apimart: resolution/language）
const ADAPTERS: MediaAdapterMeta[] = [
  {
    id: 'openai-images',
    label: 'OpenAI Images 兼容',
    modality: 'image',
    capabilities: { generate: true, edit: true, mask: true, analyze: true },
    formSchema: [
      {
        key: 'size',
        label: '尺寸',
        type: 'select',
        options: [
          { value: '1024x1024', label: '1024x1024' },
          { value: '1792x1024', label: '1792x1024' },
          { value: '1024x1792', label: '1024x1792' },
          { value: '512x512', label: '512x512' }
        ]
      }
    ]
  },
  {
    id: 'apimart',
    label: 'APIMart 异步任务',
    modality: 'image',
    capabilities: { generate: true },
    formSchema: [
      {
        key: 'resolution',
        label: '分辨率',
        type: 'select',
        options: [
          { value: '1k', label: '1k' },
          { value: '2k', label: '2k' },
          { value: '4k', label: '4k' }
        ]
      },
      { key: 'language', label: '任务语言', type: 'text', placeholder: 'en' }
    ]
  }
]

function mediaRow(overrides: Partial<MediaProviderRow>): MediaProviderRow {
  return {
    id: 'mp-1',
    name: '主图库',
    modality: 'image',
    adapter: 'openai-images',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image',
    params: { size: '1024x1024' },
    enabled: true,
    isDefault: true,
    keyHint: 'sk-t…abcd',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const DEFAULT_ROW = mediaRow({})
const SECONDARY_ROW = mediaRow({
  id: 'mp-2',
  name: '备图库',
  adapter: 'apimart',
  model: 'gpt-image-2',
  params: { resolution: '2k', language: 'en' },
  isDefault: false,
  keyHint: ''
})

function renderMediaSettings(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MediaSettings />
    </QueryClientProvider>
  )
}

function openImageTab(): void {
  fireEvent.click(screen.getByRole('tab', { name: '图片' }))
}

beforeEach(() => {
  mediaApi.listMediaAdapters.mockResolvedValue({ adapters: ADAPTERS })
  mediaApi.listMediaProviders.mockResolvedValue([DEFAULT_ROW, SECONDARY_ROW])
  mediaApi.createMediaProvider.mockResolvedValue(DEFAULT_ROW)
  mediaApi.updateMediaProvider.mockResolvedValue(DEFAULT_ROW)
  mediaApi.deleteMediaProvider.mockResolvedValue(undefined)
  mediaApi.setMediaProviderDefault.mockResolvedValue(undefined)
  // ProviderManager（文字 tab）的后端列表 / 默认 / 模型请求
  httpApi.getApi.mockResolvedValue([])
  httpApi.postApi.mockResolvedValue({})
  httpApi.deleteApi.mockResolvedValue({})
  httpApi.getAgui.mockResolvedValue({ threadId: 'main', models: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('媒体生成分区', () => {
  it('渲染四个模态 tab，默认落在文字 tab 并内嵌 ProviderManager', async () => {
    renderMediaSettings()

    expect(screen.getByRole('tablist', { name: '媒体模态' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '文字' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: '图片' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '视频' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '音频' })).toBeTruthy()

    // 文字 tab：ProviderManager 自管数据加载；媒体 Provider 列表不被拉取
    expect(screen.getByText('Provider 管理')).toBeTruthy()
    expect(mediaApi.listMediaProviders).not.toHaveBeenCalled()
    await screen.findByText(/暂无已注册的 Provider/)
  })

  it('切换图片 tab 懒加载列表并渲染卡片（名称/默认徽标/keyHint 掩码）', async () => {
    renderMediaSettings()
    openImageTab()

    expect(await screen.findByText('主图库')).toBeTruthy()
    expect(mediaApi.listMediaProviders).toHaveBeenCalledWith('image')
    expect(screen.getByText('备图库')).toBeTruthy()
    expect(screen.getByText('默认')).toBeTruthy()
    expect(screen.getByText('Key：sk-t…abcd')).toBeTruthy()
    expect(screen.getByText('Key：未设置')).toBeTruthy()
    expect(screen.getByText(/OpenAI Images 兼容 · gpt-image/)).toBeTruthy()
    expect(screen.getByText(/APIMart 异步任务 · gpt-image-2/)).toBeTruthy()
    // 默认行不出现「设为默认」，非默认行出现
    expect(screen.getByRole('button', { name: '将 备图库 设为默认' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '将 主图库 设为默认' })).toBeNull()
  })

  it('图片 tab 无 Provider 时渲染空态引导卡与新增按钮', async () => {
    mediaApi.listMediaProviders.mockResolvedValue([])
    renderMediaSettings()
    openImageTab()

    expect(await screen.findByText(/尚未配置图片生成 Provider/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '新增 Provider' })).toBeTruthy()
  })

  it('新增表单按 adapter formSchema 动态渲染字段', async () => {
    renderMediaSettings()
    openImageTab()
    fireEvent.click(await screen.findByRole('button', { name: '新增 Provider' }))

    expect(await screen.findByLabelText('名称')).toBeTruthy()

    // 默认选中第一个 adapter（openai-images）→ 出现尺寸 select，无 apimart 字段
    const adapterSelect = await screen.findByRole('combobox', { name: '适配器' })
    expect(screen.getByRole('combobox', { name: '尺寸' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '分辨率' })).toBeNull()
    expect(screen.queryByLabelText('任务语言')).toBeNull()

    // 切到 apimart → 出现分辨率 select 与任务语言输入，尺寸消失
    fireEvent.keyDown(adapterSelect, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'APIMart 异步任务' }))
    expect(await screen.findByRole('combobox', { name: '分辨率' })).toBeTruthy()
    expect(screen.getByLabelText('任务语言')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '尺寸' })).toBeNull()
  })

  it('提交新增表单调用 createMediaProvider 并携带 formSchema 参数', async () => {
    mediaApi.createMediaProvider.mockResolvedValue(DEFAULT_ROW)
    mediaApi.listMediaProviders.mockResolvedValue([DEFAULT_ROW])
    renderMediaSettings()
    openImageTab()
    fireEvent.click(await screen.findByRole('button', { name: '新增 Provider' }))

    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '测试图库' } })
    const sizeSelect = await screen.findByRole('combobox', { name: '尺寸' })
    fireEvent.keyDown(sizeSelect, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: '1024x1792' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mediaApi.createMediaProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '测试图库',
          modality: 'image',
          adapter: 'openai-images',
          params: { size: '1024x1792' }
        })
      )
    })
    // 保存成功后表单关闭并刷新列表
    await waitFor(() => {
      expect(screen.queryByLabelText('名称')).toBeNull()
    })
    expect(mediaApi.listMediaProviders).toHaveBeenCalledTimes(2)
  })

  it('点击设为默认调用 setMediaProviderDefault 并刷新列表', async () => {
    renderMediaSettings()
    openImageTab()

    fireEvent.click(await screen.findByRole('button', { name: '将 备图库 设为默认' }))

    await waitFor(() => {
      expect(mediaApi.setMediaProviderDefault).toHaveBeenCalledWith('mp-2')
    })
    // 首次懒加载 + 操作后刷新
    await waitFor(() => {
      expect(mediaApi.listMediaProviders).toHaveBeenCalledTimes(2)
    })
  })

  it('视频/音频 tab 渲染阶段二引导卡', async () => {
    renderMediaSettings()

    fireEvent.click(screen.getByRole('tab', { name: '视频' }))
    expect(await screen.findByText('该模态即将支持，将在后续版本提供配置')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '音频' }))
    expect(await screen.findByText('该模态即将支持，将在后续版本提供配置')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新增 Provider' })).toBeNull()
  })
})
