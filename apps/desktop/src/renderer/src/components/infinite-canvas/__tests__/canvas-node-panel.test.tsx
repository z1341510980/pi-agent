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

// 存模板：mock 资产库，断言 saveCanvasAsset 收到提示词内容
const assetLibrary = vi.hoisted(() => ({
  saveCanvasAsset: vi.fn((asset: { kind: 'text'; title: string; content: string }) => ({
    id: 'asset-1',
    kind: asset.kind,
    title: asset.title,
    content: asset.content,
    createdAt: 0
  }))
}))

vi.mock('../asset-library', () => assetLibrary)

afterEach(cleanup)

const theme = {
  node: {
    panel: '#fff',
    fill: '#eee',
    text: '#111',
    muted: '#666',
    stroke: '#ddd',
    placeholder: '#999'
  },
  toolbar: {
    panel: '#fff',
    border: '#ddd',
    border2: '#ccc',
    item: '#333',
    itemHover: '#eee',
    activeBg: '#111',
    activeText: '#fff'
  },
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

  it('视频模式同样展示参考图顺序预览，首张标记为主参考', () => {
    render(
      <CanvasNodePanel
        {...baseProps({ ...configNode(), metadata: { generationMode: 'video', prompt: '测试' } })}
        orderedReferences={orderedReferences}
      />
    )

    expect(screen.getByText('· 首张为生成主参考')).toBeTruthy()
    expect(screen.getByText('第1张 · 主参考')).toBeTruthy()
    expect(screen.getByText('风格参考.png')).toBeTruthy()
    expect(screen.getByText('参考图2')).toBeTruthy()
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('视频模式没有参考图时提示按纯文字生成视频', () => {
    render(
      <CanvasNodePanel
        {...baseProps({ ...configNode(), metadata: { generationMode: 'video', prompt: '测试' } })}
        orderedReferences={[]}
      />
    )

    expect(screen.getByText('未连接图片参考，将按纯文字生成视频。')).toBeTruthy()
  })
})

describe('节点面板：图像设置弹窗（替代原比例选择器）', () => {
  function Harness({
    initialMetadata,
    onPatch
  }: {
    initialMetadata?: Record<string, unknown>
    onPatch?: (patch: Record<string, unknown>) => void
  }): ReactElement {
    const [metadata, setMetadata] = useState<Record<string, unknown>>({
      generationMode: 'image',
      ...initialMetadata
    })
    const node: CanvasNodeData = { ...configNode(), metadata }
    return (
      <CanvasNodePanel
        {...baseProps(node)}
        orderedReferences={[]}
        onConfigChange={(_id, patch) => {
          onPatch?.(patch)
          setMetadata((current) => ({ ...current, ...patch }))
        }}
      />
    )
  }

  it('快照 pill 文本随 size/quality/count 变化', () => {
    const { unmount } = render(
      <CanvasNodePanel
        {...baseProps({ ...configNode(), metadata: { generationMode: 'image', count: 3 } })}
      />
    )
    expect(screen.getByText('自动·3张')).toBeTruthy()
    unmount()

    render(
      <CanvasNodePanel
        {...baseProps({
          ...configNode(),
          metadata: { generationMode: 'image', size: '1536x864', count: 2 }
        })}
      />
    )
    expect(screen.getByText('16:9·2张')).toBeTruthy()
    unmount()

    render(
      <CanvasNodePanel
        {...baseProps({
          ...configNode(),
          metadata: { generationMode: 'image', size: '1536x864', count: 2, quality: 'high' }
        })}
      />
    )
    expect(screen.getByText('高·16:9·2张')).toBeTruthy()
  })

  it('弹出宽高比 tile 并可选择，选择后快照更新', async () => {
    render(<Harness />)

    fireEvent.click(screen.getByText('自动·1张'))
    expect(await screen.findByText('质量')).toBeTruthy()
    expect(screen.getByText('1:1')).toBeTruthy()
    expect(screen.getByText('16:9')).toBeTruthy()
    expect(screen.getByText('9:16')).toBeTruthy()
    expect((screen.getByLabelText('宽度') as HTMLInputElement).value).toBe('1024')

    fireEvent.click(screen.getByText('16:9'))
    expect(screen.getByText('16:9·1张')).toBeTruthy()
  })

  it('点 21:9 tile 后选分辨率 2k → 按比例基准缩放写 size', async () => {
    const patches: Array<Record<string, unknown>> = []
    render(<Harness onPatch={(patch) => patches.push(patch)} />)

    fireEvent.click(screen.getByText('自动·1张'))
    expect(await screen.findByText('质量')).toBeTruthy()
    fireEvent.click(screen.getByText('21:9'))
    fireEvent.click(screen.getByText('2k'))

    expect(patches.at(-1)).toEqual({ size: '3584x1536' })
  })

  it('分辨率档以比例 1k 基准缩放：21:9 @2k 重选当前档幂等、点 4k 得 7168x3072', async () => {
    const patches: Array<Record<string, unknown>> = []
    render(
      <Harness initialMetadata={{ size: '3584x1536' }} onPatch={(patch) => patches.push(patch)} />
    )

    fireEvent.click(screen.getByText('21:9·1张'))
    expect(await screen.findByText('质量')).toBeTruthy()
    fireEvent.click(screen.getByText('2k'))
    expect(patches.at(-1)).toEqual({ size: '3584x1536' })

    fireEvent.click(screen.getByText('4k'))
    expect(patches.at(-1)).toEqual({ size: '7168x3072' })
  })

  it('size auto 时点分辨率 4k → 1:1 基准得 4096x4096', async () => {
    const patches: Array<Record<string, unknown>> = []
    render(<Harness onPatch={(patch) => patches.push(patch)} />)

    fireEvent.click(screen.getByText('自动·1张'))
    expect(await screen.findByText('质量')).toBeTruthy()
    fireEvent.click(screen.getByText('4k'))

    expect(patches.at(-1)).toEqual({ size: '4096x4096' })
  })

  it('质量/透明背景/张数写入对应 metadata（张数钳 1-10）', async () => {
    const patches: Array<Record<string, unknown>> = []
    render(<Harness onPatch={(patch) => patches.push(patch)} />)

    fireEvent.click(screen.getByText('自动·1张'))
    fireEvent.click(await screen.findByText('高'))
    expect(patches.at(-1)).toEqual({ quality: 'high' })

    fireEvent.click(screen.getByRole('switch', { name: '透明背景' }))
    expect(patches.at(-1)).toEqual({ background: 'transparent' })

    const countInput = screen.getByLabelText('生成张数') as HTMLInputElement
    fireEvent.change(countInput, { target: { value: '12' } })
    expect(patches.at(-1)).toEqual({ count: 10 })
  })
})

describe('节点面板：图像快捷栏', () => {
  it('展开图标打开 Dialog，编辑提示词回调 onPromptChange', async () => {
    const onPromptChange = vi.fn()
    render(<CanvasNodePanel {...baseProps(configNode())} onPromptChange={onPromptChange} />)

    fireEvent.click(screen.getByTitle('展开编辑提示词'))
    const dialogTextarea = (await screen.findByLabelText('提示词全文')) as HTMLTextAreaElement
    expect(dialogTextarea.value).toBe('测试')
    fireEvent.change(dialogTextarea, { target: { value: '新的提示词' } })

    expect(onPromptChange).toHaveBeenCalledWith('cfg-1', '新的提示词')
  })

  it('存模板按钮调用 saveCanvasAsset 保存当前提示词', () => {
    assetLibrary.saveCanvasAsset.mockClear()
    render(<CanvasNodePanel {...baseProps(configNode())} />)

    fireEvent.click(screen.getByTitle('存为提示词模板'))

    expect(assetLibrary.saveCanvasAsset).toHaveBeenCalledTimes(1)
    const arg = assetLibrary.saveCanvasAsset.mock.calls[0][0]
    expect(arg.content).toBe('测试')
    expect(arg.kind).toBe('text')
  })

  it('参考图上传按钮把选中文件交给 onAddReferenceImages', () => {
    const onAddReferenceImages = vi.fn()
    const { container } = render(
      <CanvasNodePanel {...baseProps(configNode())} onAddReferenceImages={onAddReferenceImages} />
    )

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(onAddReferenceImages).toHaveBeenCalledTimes(1)
    expect(onAddReferenceImages.mock.calls[0][0]).toBe('cfg-1')
    expect(onAddReferenceImages.mock.calls[0][1][0]).toBe(file)
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

    const combobox = await screen.findByRole('combobox', { name: '模型' })
    await waitFor(() => expect(combobox.textContent).toContain('跟随全局默认'))

    fireEvent.keyDown(combobox, { key: 'Enter' })
    expect(await screen.findByRole('option', { name: 'ProviderA / img-a' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'ProviderA / img-b' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'ProviderA / custom-x' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'ProviderB / vid-a' })).toBeNull()
    expect(combobox.textContent).toContain('跟随全局默认')
  })

  it('选择具体模型时按 provider:model 写回 metadata', async () => {
    const onConfigChange = vi.fn()
    render(
      <ModelHarness initialMetadata={{ generationMode: 'image' }} onConfigChange={onConfigChange} />
    )

    const combobox = await screen.findByRole('combobox', { name: '模型' })
    await waitFor(() => expect(combobox.textContent).toContain('跟随全局默认'))
    fireEvent.keyDown(combobox, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'ProviderA / img-b' }))

    expect(onConfigChange).toHaveBeenCalledWith('cfg-1', { providerId: 'p-image', model: 'img-b' })
    await waitFor(() => expect(combobox.textContent).toContain('ProviderA / img-b'))
  })

  it('预置节点模型时回显，改选跟随全局默认时清除', async () => {
    const onConfigChange = vi.fn()
    render(
      <ModelHarness
        initialMetadata={{ generationMode: 'image', providerId: 'p-image', model: 'img-b' }}
        onConfigChange={onConfigChange}
      />
    )

    const combobox = await screen.findByRole('combobox', { name: '模型' })
    await waitFor(() => expect(combobox.textContent).toContain('ProviderA / img-b'))
    fireEvent.keyDown(combobox, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: '跟随全局默认' }))

    expect(onConfigChange).toHaveBeenCalledWith('cfg-1', {
      providerId: undefined,
      model: undefined
    })
    await waitFor(() => expect(combobox.textContent).toContain('跟随全局默认'))
  })

  it('模态无可用 Provider 时下拉禁用', async () => {
    render(<ModelHarness initialMetadata={{ generationMode: 'image' }} />)

    const combobox = await screen.findByRole('combobox', { name: '模型' })
    await waitFor(() => expect(combobox.textContent).toContain('跟随全局默认'))
    fireEvent.click(screen.getByRole('button', { name: '视频' }))

    // 切模式后 ModelPicker 换分支重挂载（ImageQuickBar → ConfigSettingsRow 行），重新查询
    const videoCombobox = await screen.findByRole('combobox', { name: '模型' })
    await waitFor(() => expect((videoCombobox as HTMLButtonElement).disabled).toBe(true))
    expect(videoCombobox.textContent).toContain('未配置可用的 Provider')
    fireEvent.keyDown(videoCombobox, { key: 'Enter' })
    expect(screen.queryByRole('option', { name: 'ProviderA / img-a' })).toBeNull()
  })

  it('listMediaProviders 失败时下拉禁用并提示', async () => {
    mediaProviderApi.listMediaProviders.mockRejectedValueOnce(new Error('boom'))
    render(<ModelHarness initialMetadata={{ generationMode: 'image' }} />)

    // 先等拒绝被兜住（提示文案出现），再断言禁用，避免 options===null 时断言恒真
    await screen.findByText('未配置可用的 Provider')
    expect((screen.getByRole('combobox', { name: '模型' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('模型列表解析期间显示加载中，解析为空时显示未配置提示', async () => {
    let resolveLoading: (() => void) | undefined
    mediaProviderApi.listMediaProviders.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveLoading = resolve
      })
      return []
    })
    render(<ModelHarness initialMetadata={{ generationMode: 'image' }} />)

    const combobox = await screen.findByRole('combobox', { name: '模型' })
    expect(combobox.textContent).toContain('加载模型中…')
    expect((combobox as HTMLButtonElement).disabled).toBe(true)

    resolveLoading?.()
    await waitFor(() => expect(combobox.textContent).toContain('未配置可用的 Provider'))
    expect((combobox as HTMLButtonElement).disabled).toBe(true)
  })

  it('图片/视频/音频工作流节点（非 config）面板同样显示模型选择', async () => {
    render(<ModelHarness initialMetadata={{ generationMode: 'image' }} nodeType="image" />)

    const combobox = await screen.findByRole('combobox', { name: '模型' })
    await waitFor(() => expect(combobox.textContent).toContain('跟随全局默认'))
    expect((combobox as HTMLButtonElement).disabled).toBe(false)
  })
})
