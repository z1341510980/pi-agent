import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { CanvasNode } from '../../canvas-node'
import { canvasThemes } from '../../canvas-theme'
import { createDesignBoardDoc, createRectObject, createTextObject } from '../design-board-types'

afterEach(cleanup)

function boardNode(): CanvasNodeData {
  const doc = createDesignBoardDoc(1080, 1440)
  return {
    id: 'b1',
    type: 'design-board',
    title: '画板',
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { design: doc }
  }
}

function renderNode(overrides: { data?: CanvasNodeData; boardPreviewUrl?: string } = {}): {
  onOpenBoard: ReturnType<typeof vi.fn>
  node: CanvasNodeData
} {
  const onOpenBoard = vi.fn()
  const node = overrides.data ?? boardNode()
  render(
    <CanvasNode
      data={node}
      theme={canvasThemes.light}
      scale={1}
      isSelected={false}
      isRelated={false}
      isFocusRelated={false}
      isConnectionTarget={false}
      isConnecting={false}
      showPanel={false}
      showImageInfo={false}
      onMouseDown={vi.fn()}
      onHoverStart={vi.fn()}
      onHoverEnd={vi.fn()}
      onConnectStart={vi.fn()}
      onResizeStart={vi.fn()}
      onResize={vi.fn()}
      onResizeEnd={vi.fn()}
      onContentChange={vi.fn()}
      onTitleChange={vi.fn()}
      onContextMenu={vi.fn()}
      onOpenBoard={onOpenBoard}
      boardPreviewUrl={overrides.boardPreviewUrl}
    />
  )
  return { onOpenBoard, node }
}

describe('design-board 节点渲染', () => {
  it('空画板显示提示与尺寸标签，双击触发 onOpenBoard', () => {
    const { onOpenBoard, node } = renderNode()
    expect(screen.getByText('双击开始设计')).toBeTruthy()
    expect(screen.getByText('1080×1440')).toBeTruthy()
    fireEvent.dblClick(screen.getByText('双击开始设计'))
    expect(onOpenBoard).toHaveBeenCalledTimes(1)
    expect(onOpenBoard).toHaveBeenCalledWith(node)
  })

  it('提供 boardPreviewUrl 时渲染缩略图并隐藏空态提示', () => {
    renderNode({ boardPreviewUrl: 'data:image/png;base64,AAA' })
    expect(screen.getByAltText('画板预览')).toBeTruthy()
    expect(screen.queryByText('双击开始设计')).toBeNull()
    expect(screen.getByText('1080×1440')).toBeTruthy()
  })

  it('有对象时显示对象数量', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push(createRectObject(0, 0, 100, 60), createTextObject(10, 10, 200))
    renderNode({ data: { ...boardNode(), metadata: { design: doc } } })
    expect(screen.getByText('2 个对象')).toBeTruthy()
    expect(screen.queryByText('双击开始设计')).toBeNull()
  })
})
