import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { createDesignBoardDoc, type DesignBoardDoc } from '../design-board-types'
import { DesignBoardEditor, type DesignBoardEditorProps } from '../design-board-editor'

afterEach(cleanup)

const boardNode: CanvasNodeData = {
  id: 'board1',
  type: 'design-board',
  title: '画板',
  position: { x: 0, y: 0 },
  width: 340,
  height: 240,
  metadata: { design: createDesignBoardDoc(1080, 1440) }
}

function setup(overrides: Partial<DesignBoardEditorProps> = {}): {
  onCommit: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onCommit = vi.fn()
  const onClose = vi.fn()
  render(
    <DesignBoardEditor
      node={boardNode}
      nodes={[boardNode]}
      onCommit={onCommit}
      onClose={onClose}
      {...overrides}
    />
  )
  return { onCommit, onClose }
}

describe('DesignBoardEditor', () => {
  it('renders board title, tools and resources panel', () => {
    setup()
    expect(screen.getByRole('button', { name: '添加文本' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加矩形' })).toBeTruthy()
    expect(screen.getByText('画布资源')).toBeTruthy()
    expect(screen.getByText(/1080×1440/)).toBeTruthy()
  })

  it('adds a text object centered on the board and commits on close', () => {
    const { onCommit, onClose } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加文本' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(1)
    expect(doc.objects[0]).toMatchObject({ kind: 'text', fontSize: 64 })
    expect(doc.objects[0].x).toBeGreaterThan(0)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('restores selection-free state and supports undo of creation', async () => {
    const { onCommit } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    // 撤销快照经 140ms debounce 落栈：等真实定时器触发后再撤销
    await new Promise((resolve) => setTimeout(resolve, 250))
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(0)
  })

  it('shows empty-resources hint when canvas has no image nodes', async () => {
    setup()
    expect(await screen.findByText('画布上暂无图片资源')).toBeTruthy()
  })

  it('inserts image object from resource panel', async () => {
    const imageNode: CanvasNodeData = {
      id: 'img1',
      type: 'image',
      title: '素材',
      position: { x: 0, y: 0 },
      width: 10,
      height: 10,
      metadata: { content: 'data:image/png;base64,AAA' }
    }
    const { onCommit } = setup({ nodes: [boardNode, imageNode] })
    fireEvent.click(await screen.findByRole('button', { name: /素材/ }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects[0]).toMatchObject({
      kind: 'image',
      source: { kind: 'node-ref', nodeId: 'img1', index: 0 }
    })
  })
})
