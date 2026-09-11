/**
 * 无限画布插件「媒体生成」设置面板测试
 * （自宿主 settings/__tests__/media-settings.test.tsx 迁入）
 *
 * 覆盖：图片/视频/音频三模态 tab 渲染与切换懒加载、图片 Provider 卡片渲染
 * （名称/默认徽标/keyHint 掩码/额外模型 chips）、空态引导卡、formSchema 驱动的
 * 动态表单字段（openai-images ↔ apimart + textarea 类型）、模型列表公共字段
 * （params.models 提交规范化/编辑回显/清空清除）、设为默认调用客户端、
 * 反推提示词模型选择（回显/选择触发 PUT/清除/失败回退）。
 * （文字生成属宿主 LLM 体系，留在「模型与 Provider」页，不在本面板范围。）
 *
 * mock 策略：媒体客户端整体替换（@/api/media-provider-client）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  MediaAdapterMeta,
  MediaProviderRow,
  TextProviderBrief
} from '@/api/media-provider-client'
import { InfiniteCanvasMediaSettings } from '../media-settings-panel'

const mediaApi = vi.hoisted(() => ({
  listMediaAdapters: vi.fn(),
  listMediaProviders: vi.fn(),
  createMediaProvider: vi.fn(),
  updateMediaProvider: vi.fn(),
  deleteMediaProvider: vi.fn(),
  setMediaProviderDefault: vi.fn(),
  getMediaPrefs: vi.fn(),
  setMediaPrefs: vi.fn(),
  listTextProviders: vi.fn()
}))

vi.mock('@/api/media-provider-client', () => mediaApi)

// formSchema 与服务端 adapter 声明对齐（openai-images: size；apimart: resolution/language）
const ADAPTERS: MediaAdapterMeta[] = [
  {
    id: 'openai-images',
    label: 'OpenAI Images 兼容',
    modality: 'image',
    capabilities: { generate: true, edit: true, mask: true },
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
      <InfiniteCanvasMediaSettings />
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
  mediaApi.getMediaPrefs.mockResolvedValue({ analyzeModel: null })
  mediaApi.setMediaPrefs.mockResolvedValue({ analyzeModel: null })
  mediaApi.listTextProviders.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('媒体生成设置面板', () => {
  it('渲染图片/视频/音频三个模态 tab，默认落在图片 tab 并懒加载列表', async () => {
    renderMediaSettings()

    expect(screen.getByRole('tablist', { name: '媒体模态' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '图片' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: '视频' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '音频' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '文字' })).toBeNull()

    // 图片 tab 即默认 tab：挂载即拉取该模态 Provider 列表
    expect(await screen.findByText('主图库')).toBeTruthy()
    expect(mediaApi.listMediaProviders).toHaveBeenCalledWith('image')
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

  it('提交新增表单携带规范化的 params.models（trim 各行/去空行/去重）', async () => {
    mediaApi.createMediaProvider.mockResolvedValue(DEFAULT_ROW)
    renderMediaSettings()
    openImageTab()
    fireEvent.click(await screen.findByRole('button', { name: '新增 Provider' }))

    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '多模型图库' } })
    fireEvent.change(await screen.findByLabelText('模型列表（可选）'), {
      target: {
        value: ' minimax_h3_lightx2v \n\nminimax_h3_lightx2v_no_pic\nminimax_h3_lightx2v\n'
      }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mediaApi.createMediaProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '多模型图库',
          modality: 'image',
          adapter: 'openai-images',
          // 换行分隔规范化：trim 各行、去空行、去重（保序）
          params: { models: 'minimax_h3_lightx2v\nminimax_h3_lightx2v_no_pic' }
        })
      )
    })
  })

  it('编辑表单回显 params.models；清空后提交不再携带 models key', async () => {
    mediaApi.listMediaProviders.mockResolvedValue([
      mediaRow({ params: { size: '1024x1024', models: 'm-a\nm-b' } })
    ])
    renderMediaSettings()
    openImageTab()

    fireEvent.click(await screen.findByRole('button', { name: '编辑 主图库' }))
    const modelsTextarea = (await screen.findByLabelText('模型列表（可选）')) as HTMLTextAreaElement
    expect(modelsTextarea.value).toBe('m-a\nm-b')

    fireEvent.change(modelsTextarea, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mediaApi.updateMediaProvider).toHaveBeenCalledWith(
        'mp-1',
        expect.objectContaining({
          // 空列表 → 不携带 models key，旧值被清除
          params: { size: '1024x1024' }
        })
      )
    })
  })

  it('卡片在默认模型下方渲染额外模型 chips（过滤同默认项，最多 3 个 + N）', async () => {
    mediaApi.listMediaProviders.mockResolvedValue([
      mediaRow({
        model: 'gpt-image',
        params: { size: '1024x1024', models: 'gpt-image\nm1\n m2 \nm1\nm3\nm4\nm5' }
      })
    ])
    renderMediaSettings()
    openImageTab()

    expect(await screen.findByText('主图库')).toBeTruthy()
    expect(screen.getByText('m1')).toBeTruthy()
    expect(screen.getByText('m2')).toBeTruthy()
    expect(screen.getByText('m3')).toBeTruthy()
    expect(screen.getByText('+2')).toBeTruthy()
    // 与默认模型相同的项与去重后的重复项不出现
    expect(screen.queryByText('gpt-image')).toBeNull()
    expect(screen.queryByText('m4')).toBeNull()
  })

  it('formSchema 的 textarea 类型字段按多行输入渲染（rows=3）并随表单提交', async () => {
    mediaApi.listMediaAdapters.mockResolvedValue({
      adapters: [
        {
          id: 'textarea-adapter',
          label: '多行字段适配器',
          modality: 'image',
          capabilities: { generate: true },
          formSchema: [
            {
              key: 'prompt_suffix',
              label: '提示词后缀',
              type: 'textarea',
              placeholder: '每行一条'
            }
          ]
        }
      ]
    })
    renderMediaSettings()
    openImageTab()
    fireEvent.click(await screen.findByRole('button', { name: '新增 Provider' }))

    const suffixField = (await screen.findByLabelText('提示词后缀')) as HTMLTextAreaElement
    expect(suffixField.tagName).toBe('TEXTAREA')
    expect(suffixField.getAttribute('rows')).toBe('3')

    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '多行图库' } })
    fireEvent.change(suffixField, { target: { value: '高清\n赛博朋克' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mediaApi.createMediaProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '多行图库',
          params: { prompt_suffix: '高清\n赛博朋克' }
        })
      )
    })
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

  it('模态清单里没有对应 adapter 时渲染引导卡（mock 未含音视频 adapter）', async () => {
    renderMediaSettings()

    fireEvent.click(screen.getByRole('tab', { name: '视频' }))
    expect(await screen.findByText('该模态即将支持，将在后续版本提供配置')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '音频' }))
    expect(await screen.findByText('该模态即将支持，将在后续版本提供配置')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新增 Provider' })).toBeNull()
  })

  it('音视频 adapter 上线后列表模式自动可用（openai-audio formSchema 驱动字段）', async () => {
    mediaApi.listMediaAdapters.mockResolvedValue({
      adapters: [
        ...ADAPTERS,
        {
          id: 'openai-audio',
          label: 'OpenAI 语音合成',
          modality: 'audio',
          capabilities: { generate: true },
          formSchema: [
            {
              key: 'voice',
              label: '音色',
              type: 'select',
              options: [
                { value: 'alloy', label: 'alloy' },
                { value: 'nova', label: 'nova' }
              ]
            },
            {
              key: 'format',
              label: '音频格式',
              type: 'select',
              options: [{ value: 'mp3', label: 'mp3' }]
            },
            { key: 'speed', label: '语速 (0.25-4)', type: 'number', placeholder: '1' }
          ]
        }
      ]
    })
    mediaApi.listMediaProviders.mockImplementation(async (modality: string) =>
      modality === 'audio'
        ? [
            mediaRow({
              id: 'mp-audio',
              name: '配音库',
              modality: 'audio',
              adapter: 'openai-audio',
              model: 'tts-1',
              params: { voice: 'nova' },
              keyHint: 'sk-a…wxyz'
            })
          ]
        : []
    )
    renderMediaSettings()

    fireEvent.click(screen.getByRole('tab', { name: '音频' }))
    expect(await screen.findByText('配音库')).toBeTruthy()
    expect(screen.getByText(/OpenAI 语音合成 · tts-1/)).toBeTruthy()
  })
})

describe('反推提示词模型选择', () => {
  const TEXT_PROVIDERS: TextProviderBrief[] = [
    {
      id: 'p1',
      name: '供应商一',
      models: [
        { id: 'm1', name: 'M1' },
        { id: 'm2', name: 'M2' }
      ]
    },
    { id: 'p2', name: '供应商二', models: [{ id: 'v1', name: 'V1' }] },
    { id: 'p3', name: '空模型', models: [] }
  ]

  function openAnalyzeSelect(): void {
    fireEvent.keyDown(screen.getByRole('combobox', { name: '反推提示词模型' }), {
      key: 'Enter'
    })
  }

  it('渲染图片 tab 顶部小节：标题/说明/下拉，models 为空的 Provider 不出现', async () => {
    mediaApi.listTextProviders.mockResolvedValue(TEXT_PROVIDERS)
    renderMediaSettings()

    expect(await screen.findByText('反推提示词模型')).toBeTruthy()
    expect(screen.getByText('用于图片反推提示词的视觉理解模型；留空跟随默认文字模型')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '反推提示词模型' })).toBeTruthy()

    // 打开下拉验证选项清单：'provider:model' value 的 label 为 `{provider 名} / {model}`
    openAnalyzeSelect()
    expect(await screen.findByRole('option', { name: '跟随默认文字模型' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '供应商一 / m1' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '供应商一 / m2' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '供应商二 / v1' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /空模型/ })).toBeNull()
  })

  it('挂载时 GET 回显已保存偏好（触发器显示选中模型）', async () => {
    mediaApi.getMediaPrefs.mockResolvedValue({ analyzeModel: 'p1:m2' })
    mediaApi.listTextProviders.mockResolvedValue(TEXT_PROVIDERS)
    renderMediaSettings()

    expect(await screen.findByText('供应商一 / m2')).toBeTruthy()
    expect(mediaApi.getMediaPrefs).toHaveBeenCalledTimes(1)
  })

  it('选择模型立即 PUT 保存（乐观 UI 更新触发器显示）', async () => {
    mediaApi.listTextProviders.mockResolvedValue(TEXT_PROVIDERS)
    mediaApi.setMediaPrefs.mockResolvedValue({ analyzeModel: 'p2:v1' })
    renderMediaSettings()

    // 等偏好加载完成（哨兵 value 对应项「跟随默认文字模型」出现在触发器）再打开下拉
    await screen.findByText('跟随默认文字模型')
    openAnalyzeSelect()
    fireEvent.click(await screen.findByRole('option', { name: '供应商二 / v1' }))

    await waitFor(() => {
      expect(mediaApi.setMediaPrefs).toHaveBeenCalledWith({ analyzeModel: 'p2:v1' })
    })
    expect(await screen.findByText('供应商二 / v1')).toBeTruthy()
  })

  it('选择「跟随默认文字模型」清除偏好（PUT null）', async () => {
    mediaApi.getMediaPrefs.mockResolvedValue({ analyzeModel: 'p1:m1' })
    mediaApi.listTextProviders.mockResolvedValue(TEXT_PROVIDERS)
    mediaApi.setMediaPrefs.mockResolvedValue({ analyzeModel: null })
    renderMediaSettings()

    await screen.findByText('供应商一 / m1')
    openAnalyzeSelect()
    fireEvent.click(await screen.findByRole('option', { name: '跟随默认文字模型' }))

    await waitFor(() => {
      expect(mediaApi.setMediaPrefs).toHaveBeenCalledWith({ analyzeModel: null })
    })
  })

  it('保存失败回退到旧值并提示', async () => {
    mediaApi.getMediaPrefs.mockResolvedValue({ analyzeModel: 'p1:m1' })
    mediaApi.listTextProviders.mockResolvedValue(TEXT_PROVIDERS)
    mediaApi.setMediaPrefs.mockRejectedValue(new Error('网络错误'))
    renderMediaSettings()

    expect(await screen.findByText('供应商一 / m1')).toBeTruthy()
    openAnalyzeSelect()
    fireEvent.click(await screen.findByRole('option', { name: '供应商二 / v1' }))

    // 失败后回退显示旧值 + 错误提示（err.message 透传）
    expect(await screen.findByText('供应商一 / m1')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('网络错误')
    expect(mediaApi.setMediaPrefs).toHaveBeenCalledWith({ analyzeModel: 'p2:v1' })
  })
})
