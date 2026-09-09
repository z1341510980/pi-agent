import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { CanvasNodePanel, type OrderedReference } from '../canvas-node-panel'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import type { CanvasTheme } from '../canvas-theme'

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
