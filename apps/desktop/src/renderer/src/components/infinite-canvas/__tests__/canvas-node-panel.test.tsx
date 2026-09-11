import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { CanvasNodePanel, type OrderedReference } from '../canvas-node-panel'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import type { MediaProviderRow } from '@/api/media-provider-client'
import type { CanvasTheme } from '../canvas-theme'

// listMediaProviders 返回行数组（GET 响应的 rows 才是行）；行字段按真实 MediaProviderRow（keyHint/数字时间戳）
const mediaProviderRows = vi.hoisted(
  () =>
    [
      {
        id: 'p-image',
        name: 'ProviderA',
        modality: 'image',
        adapter: 'openai-images',
        baseUrl: '',
        model: 'img-a',
        params: { models: 'img-b\ncustom-x' },
        enabled: true,
        isDefault: true,
        keyHint: '',
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'p-video-off',
        name: 'ProviderB',
        modality: 'video',
        adapter: 'newapi-video',
        baseUrl: '',
        model: 'vid-a',
        params: {},
        enabled: false,
        isDefault: false,
        keyHint: '',
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'p-audio',
        name: 'ProviderC',
        modality: 'audio',
        adapter: 'openai-audio',
        baseUrl: '',
        model: 'tts-1',
        params: {},
        enabled: true,
        isDefault: true,
        keyHint: '',
        createdAt: 0,
        updatedAt: 0
      }
    ] satisfies MediaProviderRow[]
)

// 提升暴露 mock 函数：失败场景用 mockRejectedValueOnce 单次拒绝
const mediaProviderApi = vi.hoisted(() => ({
  listMediaProviders: vi.fn(async () => mediaProviderRows)
}))

vi.mock('@/api/media-provider-client', () => mediaProviderApi)

afterEach(cleanup)

const theme = {
  node: { panel: '#fff', fill: '#eee', text: '#111', muted: '#666', stroke: '#ddd', placeholder: '#999' },
  toolbar: { panel: '#fff', border: '#ddd', border2: '#ccc', item: '#333', itemHover: '#eee', activeBg: '#111', activeText: '#fff' },
  canvas: { background: '#fafafa' },
  connection: { default: '#ccc', label: '#666' }
} as unknown as CanvasTheme

function configNode(): CanvasNodeData {
  return {
    id: 'cfg-1',
    type: 'config',
    title: '生成配置',
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { generationMode: 'image', prompt: '测试' }
  }
}

function baseProps(node: CanvasNodeData): {
  node: CanvasNodeData
  theme: CanvasTheme
  isRunning: boolean
  onPromptChange: (nodeId: string, prompt: string) => void
  onModeChange: (nodeId: string, mode: string) => void
  onGenerate: (nodeId: string, prompt: string, mode: string) => void
  onStop: (nodeId: string) => void
  onClose: () => void
  onConfigChange: (nodeId: string, patch: Record<string, unknown>) => void
} {
  return {
    node,
    theme,
    isRunning: false,
    onPromptChange: vi.fn(),
    onModeChange: vi.fn(),
    onGenerate: vi.fn(),
    onStop: vi.fn(),
    onClose: vi.fn(),
    onConfigChange: vi.fn()
  }
}

const orderedReferences: OrderedReference[] = [
  { nodeId: 'img-self', title: '原图.jpg', src: 'data:image/png;base64,A', isSelf: true },
  { nodeId: 'img-up', title: '风格参考.png', src: 'data:image/png;base64,B', isSelf: false }
]

describe('节点面板：参考图顺序预览', () => {
  it('按发送顺序展示参考图，第 1 张标记为原图', () => {
    render(<CanvasNodePanel {...baseProps(configNode())} orderedReferences={orderedReferences} />)

    expect(screen.getByText('参考图（按发送顺序）')).toBeTruthy()
    expect(screen.getByText('原图.jpg')).toBeTruthy()
    expect(screen.getByText('第1张 · 原图')).toBeTruthy()
    expect(screen.getByText('风格参考.png')).toBeTruthy()
    expect(screen.getByText('参考图2')).toBeTruthy()
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('没有参考图时给出纯文字生成提示', () => {
    render(<CanvasNodePanel {...baseProps(configNode())} orderedReferences={[]} />)

    expect(screen.getByText('参考图（按发送顺序）')).toBeTruthy()
    expect(screen.getByText(/未连接图片参考/)).toBeTruthy()
  })
})

describe('节点面板：比例选择器', () => {
  it('弹出按真实长宽比渲染的比例选项并可选择', () => {
    function Harness(): ReactElement {
      const [metadata, setMetadata] = useState<Record<string, unknown>>({ generationMode: 'image' })
      const node: CanvasNodeData = { ...configNode(), metadata }
      return (
        <CanvasNodePanel
          {...baseProps(node)}
          orderedReferences={[]}
          onConfigChange={(_id, patch) => setMetadata((current) => ({ ...current, ...patch }))}
        />
      )
    }
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: /尺寸 自动/ })
    fireEvent.click(trigger)

    expect(screen.getByText('1:1')).toBeTruthy()
    expect(screen.getByText('16:9')).toBeTruthy()
    expect(screen.getByText('9:16')).toBeTruthy()
    expect(screen.getByText('1024x1024')).toBeTruthy()

    fireEvent.click(screen.getByText('16:9'))
    expect(screen.getByRole('button', { name: /尺寸 16:9 1536x864/ })).toBeTruthy()
  })
})

describe('节点模型选择', () => {
  function ModelHarness({
    initialMetadata,
    nodeType,
    onConfigChange
  }: {
    initialMetadata: Record<string, unknown>
    nodeType?: CanvasNodeData['type']
    onConfigChange?: (nodeId: string, patch: Record<string, unknown>) => void
  }): ReactElement {
    const [metadata, setMetadata] = useState<Record<string, unknown>>(initialMetadata)
    const node: CanvasNodeData = { ...configNode(), type: nodeType ?? 'config', metadata }
    return (
      <CanvasNodePanel
        {...baseProps(node)}
        orderedReferences={[]}
        onConfigChange={(nodeId, patch) => {
          onConfigChange?.(nodeId, patch)
          setMetadata((current) => ({ ...current, ...patch }))
        }}
      />
    )
  }

  it('下拉按模态聚合已启用 Provider 的候选模型，默认跟随全局默认', async () => {
    render(<ModelHarness initialMetadata={{ generationMode: 'image' }} />)

    await screen.findByText('ProviderA / img-a')
    expect(screen.getByText('ProviderA / img-b')).toBeTruthy()
    expect(screen.getByText('ProviderA / custom-x')).toBeTruthy()
    expect(screen.queryByText('ProviderB / vid-a')).toBeNull()
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('')
  })

  it('选择具体模型时按 provider:model 写回 metadata', async () => {
    const onConfigChange = vi.fn()
    render(
      <ModelHarness initialMetadata={{ generationMode: 'image' }} onConfigChange={onConfigChange} />
    )

    await screen.findByText('ProviderA / img-a')
    const select = screen.getByLabelText('模型') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'p-image:img-b' } })

    expect(onConfigChange).toHaveBeenCalledWith('cfg-1', { providerId: 'p-image', model: 'img-b' })
    expect(select.value).toBe('p-image:img-b')
  })

  it('预置节点模型时回显，改选跟随全局默认时清除', async () => {
    const onConfigChange = vi.fn()
    render(
      <ModelHarness
        initialMetadata={{ generationMode: 'image', providerId: 'p-image', model: 'img-b' }}
        onConfigChange={onConfigChange}
      />
    )

    const select = screen.getByLabelText('模型') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('p-image:img-b'))
    fireEvent.change(select, { target: { value: '' } })

    expect(onConfigChange).toHaveBeenCalledWith('cfg-1', {
      providerId: undefined,
      model: undefined
    })
  })

  it('模态无可用 Provider 时下拉禁用', async () => {
    render(<ModelHarness initialMetadata={{ generationMode: 'image' }} />)

    await screen.findByText('ProviderA / img-a')
    fireEvent.click(screen.getByRole('button', { name: '视频' }))

    const select = screen.getByLabelText('模型') as HTMLSelectElement
    await waitFor(() => expect(select.disabled).toBe(true))
    expect(screen.queryByText('ProviderA / img-a')).toBeNull()
  })

  it('listMediaProviders 失败时下拉禁用并提示', async () => {
    mediaProviderApi.listMediaProviders.mockRejectedValueOnce(new Error('boom'))
    render(<ModelHarness initialMetadata={{ generationMode: 'image' }} />)

    // 先等拒绝被兜住（提示文案出现），再断言禁用，避免 options===null 时断言恒真
    await screen.findByText('未配置可用的 Provider')
    expect((screen.getByLabelText('模型') as HTMLSelectElement).disabled).toBe(true)
  })

  it('图片/视频/音频工作流节点（非 config）面板同样显示模型选择', async () => {
    render(<ModelHarness initialMetadata={{ generationMode: 'image' }} nodeType="image" />)

    await screen.findByText('ProviderA / img-a')
    expect((screen.getByLabelText('模型') as HTMLSelectElement).disabled).toBe(false)
  })
})
