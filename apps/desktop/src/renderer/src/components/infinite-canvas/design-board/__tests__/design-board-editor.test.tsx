import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  container: HTMLElement
} {
  const onCommit = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <DesignBoardEditor
      node={boardNode}
      nodes={[boardNode]}
      onCommit={onCommit}
      onClose={onClose}
      {...overrides}
    />
  )
  return { onCommit, onClose, container: view.container }
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

  it('saves and closes via the top-bar X button', () => {
    const { onCommit, onClose } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并关闭' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(1)
    expect(doc.objects[0]).toMatchObject({ kind: 'rect' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preserves text draft when adding a rect mid-edit', () => {
    const { onCommit } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加文本' }))
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '你好' } })
    fireEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(2)
    expect(doc.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'text', text: '你好' }),
        expect.objectContaining({ kind: 'rect' })
      ])
    )
  })

  it('commits the previous draft when adding another text mid-edit', () => {
    const { onCommit } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加文本' }))
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '你好' } })
    fireEvent.click(screen.getByRole('button', { name: '添加文本' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(2)
    expect(doc.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'text', text: '你好' }),
        expect.objectContaining({ kind: 'text', text: '' })
      ])
    )
  })

  it('commits text draft on blur and keeps it when finishing', () => {
    const { onCommit } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加文本' }))
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '你好' } })
    // React 19 把 onBlur 委托到冒泡的 focusout（原生 blur 不冒泡，React 收不到）
    fireEvent.focusOut(textarea)
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(1)
    expect(doc.objects[0]).toMatchObject({ kind: 'text', text: '你好' })
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

  it('画板对象层存在 overflow-hidden 裁切容器（越界对象隐藏）', () => {
    const { container } = setup()
    const artboard = container.querySelector('[data-design-board-artboard]')
    expect(artboard).toBeTruthy()
    const objectLayer = artboard?.firstElementChild
    expect(objectLayer).toBeTruthy()
    expect(objectLayer?.className).toContain('overflow-hidden')
  })

  it('选择手柄为屏幕恒定尺寸（命中区/视觉条不随缩放）', () => {
    const { container } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    const handles = [...container.querySelectorAll('[data-design-board-handle]')] as HTMLElement[]
    // RESIZE_HANDLE_IDS 顺序：nw, n, ne, e, se, s, sw, w
    expect(handles).toHaveLength(8)
    expect(handles[0].style.width).toBe('24px')
    expect(handles[0].style.height).toBe('24px')
    expect(handles[1].style.width).toBe('32px')
    expect(handles[1].style.height).toBe('24px')
    expect(handles[3].style.width).toBe('24px')
    expect(handles[3].style.height).toBe('32px')
    const cornerVisual = handles[0].firstElementChild as HTMLElement
    expect(cornerVisual).toBeTruthy()
    expect(cornerVisual.style.width).toBe('12px')
    expect(cornerVisual.style.height).toBe('12px')
  })

  it('invokes export callback with current doc and default png format', () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    const { onClose } = setup({ onExport })
    fireEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    fireEvent.click(screen.getByRole('button', { name: '导出图片' }))
    expect(onExport).toHaveBeenCalledTimes(1)
    expect(onExport).toHaveBeenCalledWith(
      'png',
      expect.objectContaining({ objects: expect.any(Array) })
    )
    const doc = onExport.mock.calls[0][1] as DesignBoardDoc
    expect(doc.objects).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('exports jpg when the jpg format radio is selected', () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    setup({ onExport })
    fireEvent.click(screen.getByRole('radio', { name: 'JPG' }))
    fireEvent.click(screen.getByRole('button', { name: '导出图片' }))
    expect(onExport).toHaveBeenCalledWith(
      'jpg',
      expect.objectContaining({ objects: expect.any(Array) })
    )
  })

  it('merges pending text draft into the exported doc', () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    setup({ onExport })
    fireEvent.click(screen.getByRole('button', { name: '添加文本' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '导出文本' } })
    fireEvent.click(screen.getByRole('button', { name: '导出图片' }))
    const doc = onExport.mock.calls[0][1] as DesignBoardDoc
    expect(doc.objects[0]).toMatchObject({ kind: 'text', text: '导出文本' })
  })

  it('hides export controls when onExport is not provided', () => {
    setup()
    expect(screen.queryByRole('button', { name: '导出图片' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'PNG' })).toBeNull()
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

  it('zoom step buttons scale the zoom percent by 1.1 steps', () => {
    setup()
    const slider = screen.getByLabelText('缩放') as HTMLInputElement
    const initial = Number(slider.value)
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    const zoomed = Number(slider.value)
    expect(zoomed).toBeGreaterThan(initial)
    fireEvent.click(screen.getByRole('button', { name: '缩小' }))
    expect(Number(slider.value)).toBeLessThan(zoomed)
    fireEvent.click(screen.getByRole('button', { name: '缩小' }))
    expect(Number(slider.value)).toBeLessThan(initial)
  })

  it('适配 button restores the fit zoom on the slider', () => {
    setup()
    const slider = screen.getByLabelText('缩放') as HTMLInputElement
    const fitValue = Number(slider.value)
    fireEvent.change(slider, { target: { value: '200' } })
    expect(Number(slider.value)).toBe(200)
    fireEvent.click(screen.getByRole('button', { name: '适配' }))
    expect(Number(slider.value)).toBe(fitValue)
  })

  it('Ctrl+1 triggers fit zoom', () => {
    setup()
    const slider = screen.getByLabelText('缩放') as HTMLInputElement
    const fitValue = Number(slider.value)
    fireEvent.change(slider, { target: { value: '200' } })
    fireEvent.keyDown(window, { key: '1', ctrlKey: true })
    expect(Number(slider.value)).toBe(fitValue)
  })

  it('opens context menu on object right-click, deletes and closes', () => {
    const { onCommit, container } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    // 视口空白处按下取消选中，右键对象时应先切换回选中
    fireEvent.pointerDown(container.querySelector('[data-design-board-viewport]') as HTMLElement)
    expect(container.querySelectorAll('[data-design-board-handle]')).toHaveLength(0)
    const objectEl = container.querySelector('[data-design-board-object]') as HTMLElement
    fireEvent.contextMenu(objectEl)
    const menu = container.querySelector('[data-design-board-context-menu]') as HTMLElement
    expect(menu).toBeTruthy()
    expect(container.querySelectorAll('[data-design-board-handle]')).toHaveLength(8)
    fireEvent.click(within(menu).getByRole('button', { name: '删除' }))
    expect(container.querySelector('[data-design-board-context-menu]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(0)
  })

  it('context menu 复制 duplicates the object', () => {
    const { onCommit, container } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    const objectEl = container.querySelector('[data-design-board-object]') as HTMLElement
    fireEvent.contextMenu(objectEl)
    const menu = container.querySelector('[data-design-board-context-menu]') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '复制' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(2)
  })

  it('closes context menu on Escape and outside pointerdown', () => {
    const { container } = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    const objectEl = container.querySelector('[data-design-board-object]') as HTMLElement
    fireEvent.contextMenu(objectEl)
    expect(container.querySelector('[data-design-board-context-menu]')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('[data-design-board-context-menu]')).toBeNull()
    fireEvent.contextMenu(objectEl)
    fireEvent.pointerDown(container.querySelector('[data-design-board-viewport]') as HTMLElement)
    expect(container.querySelector('[data-design-board-context-menu]')).toBeNull()
  })

  it('does not open context menu on blank viewport right-click', () => {
    const { container } = setup()
    const viewport = container.querySelector('[data-design-board-viewport]') as HTMLElement
    fireEvent.contextMenu(viewport)
    expect(container.querySelector('[data-design-board-context-menu]')).toBeNull()
  })
})
