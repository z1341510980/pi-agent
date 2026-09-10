import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import {
  createDesignBoardDoc,
  createImageObject,
  createLineObject,
  createPolygonObject,
  createRectObject,
  createTextObject,
  type DesignBoardDoc
} from '../design-board-types'
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

function viewportOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-design-board-viewport]') as HTMLElement
}

/**
 * 形状工具流：展开下拉选形状 → 画板空白区按下/抬起。
 * jsdom 视口 0 尺寸：fit 缩放 = floor(min(200/1080, 200/1440)·100)/100 = 0.13。
 */
function drawShapeOnBoard(container: HTMLElement, label: string): void {
  fireEvent.click(screen.getByRole('button', { name: '形状' }))
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.pointerDown(viewportOf(container), { clientX: 108, clientY: 130 })
  fireEvent.pointerUp(window)
}

/** 文字工具流：进入点选放置模式 → 画板点击创建文本（进入编辑态）。 */
function placeTextOnBoard(container: HTMLElement): void {
  fireEvent.click(screen.getByRole('button', { name: '文字' }))
  fireEvent.pointerDown(viewportOf(container), { clientX: 108, clientY: 130 })
}

describe('DesignBoardEditor', () => {
  it('renders board title, bottom tools and side navigation rail', () => {
    setup()
    expect(screen.getByRole('button', { name: '文字' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '形状' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '图片' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '图层' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '画布资源' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '快捷键' })).toBeTruthy()
    expect(screen.getByText(/1080×1440/)).toBeTruthy()
  })

  it('floating side panels open exclusively and toggle off on repeat click', () => {
    const { container } = setup()
    expect(container.querySelectorAll('[data-design-board-side-panel]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '画布资源' }))
    expect(container.querySelectorAll('[data-design-board-side-panel]')).toHaveLength(1)
    expect(screen.getByText('画布资源')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    expect(container.querySelectorAll('[data-design-board-side-panel]')).toHaveLength(1)
    expect(screen.getByText('图层')).toBeTruthy()
    expect(screen.queryByText('画布上暂无图片资源')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    expect(container.querySelectorAll('[data-design-board-side-panel]')).toHaveLength(0)
  })

  it('places a text object via point-click, enters editing and commits on close', () => {
    const { onCommit, onClose, container } = setup()
    placeTextOnBoard(container)
    expect(screen.getByRole('textbox')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(1)
    expect(doc.objects[0]).toMatchObject({ kind: 'text', fontSize: 64, width: 320 })
    expect(doc.objects[0].x).toBeGreaterThan(0)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('图片 button opens the shared images side panel', async () => {
    const { container } = setup()
    fireEvent.click(screen.getByRole('button', { name: '图片' }))
    expect(container.querySelectorAll('[data-design-board-side-panel]')).toHaveLength(1)
    expect(await screen.findByText('画布上暂无图片资源')).toBeTruthy()
  })

  it('shape dropdown draws an ellipse via pointer sequence and commits it', () => {
    const { onCommit, container } = setup()
    const viewport = viewportOf(container)
    fireEvent.click(screen.getByRole('button', { name: '形状' }))
    fireEvent.click(screen.getByRole('button', { name: '椭圆' }))
    expect(viewport.style.cursor).toBe('crosshair')
    const scale = Math.floor(Math.min(200 / 1080, 200 / 1440) * 100) / 100
    fireEvent.pointerDown(viewport, { clientX: 108, clientY: 130 })
    // 拖画中出现虚线预览层
    fireEvent.pointerMove(window, { clientX: 135, clientY: 156 })
    expect(container.querySelector('[data-design-board-shape-draft]')).toBeTruthy()
    fireEvent.pointerUp(window)
    // 创建后退出绘制模式
    expect(viewport.style.cursor).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(1)
    expect(doc.objects[0]).toMatchObject({ kind: 'ellipse', fill: '#262626', strokeWidth: 0 })
    expect(doc.objects[0].width).toBeCloseTo(27 / scale, 0)
    expect(doc.objects[0].height).toBeCloseTo(26 / scale, 0)
  })

  it('Escape exits draw mode so board clicks no longer create objects', () => {
    const { onCommit, container } = setup()
    const viewport = viewportOf(container)
    fireEvent.click(screen.getByRole('button', { name: '形状' }))
    fireEvent.click(screen.getByRole('button', { name: '椭圆' }))
    expect(viewport.style.cursor).toBe('crosshair')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(viewport.style.cursor).toBe('')
    fireEvent.pointerDown(viewport, { clientX: 108, clientY: 130 })
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(0)
  })

  it('near-click drag creates the default-size shape centered at the start point', () => {
    const { onCommit, container } = setup()
    drawShapeOnBoard(container, '矩形')
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(1)
    const rect = doc.objects[0]
    expect(rect).toMatchObject({ kind: 'rect' })
    // 默认尺寸 = round(min(1080, 1440)·0.16) = 173，起点为按下场景点
    expect(rect.width).toBe(173)
    expect(rect.height).toBe(173)
    expect(rect.x).toBeCloseTo(108 / 0.13 - 173 / 2, 0)
  })

  it('saves and closes via the top-bar X button', () => {
    const { onCommit, onClose, container } = setup()
    drawShapeOnBoard(container, '矩形')
    fireEvent.click(screen.getByRole('button', { name: '保存并关闭' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(1)
    expect(doc.objects[0]).toMatchObject({ kind: 'rect' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preserves text draft when adding a rect mid-edit', () => {
    const { onCommit, container } = setup()
    placeTextOnBoard(container)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '你好' } })
    drawShapeOnBoard(container, '矩形')
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

  it('commits the previous draft when placing another text mid-edit', () => {
    const { onCommit, container } = setup()
    placeTextOnBoard(container)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '你好' } })
    placeTextOnBoard(container)
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
    const { onCommit, container } = setup()
    placeTextOnBoard(container)
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
    const { onCommit, container } = setup()
    drawShapeOnBoard(container, '矩形')
    // 撤销快照经 140ms debounce 落栈：等真实定时器触发后再撤销
    await new Promise((resolve) => setTimeout(resolve, 250))
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(0)
  })

  it('shows empty-resources hint when canvas has no image nodes', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: '画布资源' }))
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
    drawShapeOnBoard(container, '矩形')
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
    const { onClose, container } = setup({ onExport })
    drawShapeOnBoard(container, '矩形')
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
    const { container } = setup({ onExport })
    placeTextOnBoard(container)
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
    fireEvent.click(screen.getByRole('button', { name: '画布资源' }))
    fireEvent.click(await screen.findByRole('button', { name: /素材/ }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects[0]).toMatchObject({
      kind: 'image',
      source: { kind: 'node-ref', nodeId: 'img1', index: 0 }
    })
  })

  it('图层面板图片条目显示来源节点标题（资源插入流）', async () => {
    const imageNode: CanvasNodeData = {
      id: 'img1',
      type: 'image',
      title: '海边日落',
      position: { x: 0, y: 0 },
      width: 10,
      height: 10,
      metadata: { content: 'data:image/png;base64,AAA' }
    }
    const { container } = setup({ nodes: [boardNode, imageNode] })
    fireEvent.click(screen.getByRole('button', { name: '画布资源' }))
    fireEvent.click(await screen.findByRole('button', { name: /海边日落/ }))
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    const panel = container.querySelector('[data-design-board-layers-panel]') as HTMLElement
    const rows = [...panel.querySelectorAll('[data-design-board-layer-item]')] as HTMLElement[]
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByTitle('海边日落')).toBeTruthy()
  })

  it('图片图层按来源区分名称：节点标题，空标题/缺失节点/url 回退「图片」', () => {
    const titled: CanvasNodeData = {
      id: 'img1',
      type: 'image',
      title: '海边日落',
      position: { x: 0, y: 0 },
      width: 10,
      height: 10,
      metadata: { content: 'data:image/png;base64,AAA' }
    }
    const untitled: CanvasNodeData = {
      id: 'img2',
      type: 'image',
      title: '',
      position: { x: 0, y: 0 },
      width: 10,
      height: 10,
      metadata: { content: 'data:image/png;base64,BBB' }
    }
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push(
      createImageObject({ kind: 'node-ref', nodeId: 'img1', index: 0 }, 10, 10, 100, 80),
      createImageObject({ kind: 'node-ref', nodeId: 'img2', index: 0 }, 10, 200, 100, 80),
      createImageObject({ kind: 'url', url: 'https://example.com/a.png' }, 10, 400, 100, 80),
      createImageObject({ kind: 'node-ref', nodeId: 'missing', index: 0 }, 10, 600, 100, 80)
    )
    const { container } = setup({
      node: { ...boardNode, metadata: { design: doc } },
      nodes: [boardNode, titled, untitled]
    })
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    const panel = container.querySelector('[data-design-board-layers-panel]') as HTMLElement
    const rows = [...panel.querySelectorAll('[data-design-board-layer-item]')] as HTMLElement[]
    expect(rows).toHaveLength(4)
    // 倒序展示：missing 节点 / url / 空标题节点 / 有标题节点
    expect(within(rows[0]).getByTitle('图片')).toBeTruthy()
    expect(within(rows[1]).getByTitle('图片')).toBeTruthy()
    expect(within(rows[2]).getByTitle('图片')).toBeTruthy()
    expect(within(rows[3]).getByTitle('海边日落')).toBeTruthy()
  })

  it('文本图层显示内容截断（超过 12 字符加省略号），空内容回退「文本」', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push(
      { ...createTextObject(10, 10, 320), text: '这是一段超过十二个字符的文本内容' },
      createTextObject(10, 300, 320)
    )
    const { container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    const panel = container.querySelector('[data-design-board-layers-panel]') as HTMLElement
    const rows = [...panel.querySelectorAll('[data-design-board-layer-item]')] as HTMLElement[]
    expect(rows).toHaveLength(2)
    // 倒序展示：空文本在前，长文本截断在后
    expect(within(rows[0]).getByTitle('文本')).toBeTruthy()
    expect(within(rows[1]).getByTitle('这是一段超过十二个字符的…')).toBeTruthy()
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
    drawShapeOnBoard(container, '矩形')
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
    drawShapeOnBoard(container, '矩形')
    const objectEl = container.querySelector('[data-design-board-object]') as HTMLElement
    fireEvent.contextMenu(objectEl)
    const menu = container.querySelector('[data-design-board-context-menu]') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '复制' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(2)
  })

  it('context menu 置顶 moves the object to the end of the objects array', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    const first = createRectObject(10, 10, 100, 80)
    const second = createRectObject(300, 10, 100, 80)
    doc.objects.push(first, second)
    const { onCommit, container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    const objectEls = [...container.querySelectorAll('[data-design-board-object]')] as HTMLElement[]
    fireEvent.contextMenu(objectEls[0])
    const menu = container.querySelector('[data-design-board-context-menu]') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '置顶' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const committed = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(committed.objects.map((object) => object.id)).toEqual([second.id, first.id])
  })

  it('属性工具栏包含层级四钮，上移一层后完成编辑提交顺序变化', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    const first = createRectObject(10, 10, 100, 80)
    const second = createRectObject(300, 10, 100, 80)
    doc.objects.push(first, second)
    const { onCommit, container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    const objectEls = [...container.querySelectorAll('[data-design-board-object]')] as HTMLElement[]
    fireEvent.pointerDown(objectEls[0], { button: 0 })
    const toolbar = container.querySelector('[data-design-board-property-toolbar]') as HTMLElement
    for (const name of ['置顶', '置底', '上移一层', '下移一层']) {
      expect(within(toolbar).getByRole('button', { name })).toBeTruthy()
    }
    fireEvent.click(within(toolbar).getByRole('button', { name: '上移一层' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const committed = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(committed.objects.map((object) => object.id)).toEqual([second.id, first.id])
  })

  it('Ctrl+] 上移一层调整选中对象层级', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    const first = createRectObject(10, 10, 100, 80)
    const second = createRectObject(300, 10, 100, 80)
    const third = createRectObject(600, 10, 100, 80)
    doc.objects.push(first, second, third)
    const { onCommit, container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    const objectEls = [...container.querySelectorAll('[data-design-board-object]')] as HTMLElement[]
    fireEvent.pointerDown(objectEls[0], { button: 0 })
    fireEvent.keyDown(window, { key: ']', ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const committed = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(committed.objects.map((object) => object.id)).toEqual([second.id, first.id, third.id])
  })

  it('Ctrl+Shift+[ 置底调整选中对象层级', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    const first = createRectObject(10, 10, 100, 80)
    const second = createRectObject(300, 10, 100, 80)
    const third = createRectObject(600, 10, 100, 80)
    doc.objects.push(first, second, third)
    const { onCommit, container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    const objectEls = [...container.querySelectorAll('[data-design-board-object]')] as HTMLElement[]
    fireEvent.pointerDown(objectEls[2], { button: 0 })
    fireEvent.keyDown(window, { key: '[', ctrlKey: true, shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const committed = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(committed.objects.map((object) => object.id)).toEqual([third.id, first.id, second.id])
  })

  it('closes context menu on Escape and outside pointerdown', () => {
    const { container } = setup()
    drawShapeOnBoard(container, '矩形')
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

  it('选中矩形后显示浮动属性工具栏（含填充颜色输入，定位在对象上方居中）', () => {
    const { container } = setup()
    drawShapeOnBoard(container, '矩形')
    const toolbar = container.querySelector('[data-design-board-property-toolbar]') as HTMLElement
    expect(toolbar).toBeTruthy()
    expect(within(toolbar).getByLabelText('填充颜色')).toBeTruthy()
    expect(within(toolbar).getByLabelText('描边颜色')).toBeTruthy()
    expect(within(toolbar).getByLabelText('描边宽度')).toBeTruthy()
    expect(within(toolbar).getByLabelText('圆角')).toBeTruthy()
    expect((within(toolbar).getByLabelText('填充颜色') as HTMLInputElement).value).toBe('#262626')
    // 定位公式：top = y·scale − 44，left = (x + width/2)·scale（从对象元素实测推回）
    const objectEl = container.querySelector('[data-design-board-object]') as HTMLElement
    const objectTop = Number.parseFloat(objectEl.style.top)
    const objectLeft = Number.parseFloat(objectEl.style.left)
    const objectWidth = Number.parseFloat(objectEl.style.width)
    expect(Number.parseFloat(toolbar.style.top)).toBeCloseTo(objectTop - 44)
    expect(Number.parseFloat(toolbar.style.left)).toBeCloseTo(objectLeft + objectWidth / 2)
  })

  it('对象贴近画板顶部时属性工具栏翻转到对象下方', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push(createRectObject(120, 0, 240, 120))
    const { container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    const objectEl = container.querySelector('[data-design-board-object]') as HTMLElement
    fireEvent.pointerDown(objectEl, { button: 0 })
    const toolbar = container.querySelector('[data-design-board-property-toolbar]') as HTMLElement
    expect(toolbar).toBeTruthy()
    const objectTop = Number.parseFloat(objectEl.style.top)
    const objectHeight = Number.parseFloat(objectEl.style.height)
    expect(Number.parseFloat(toolbar.style.top)).toBeCloseTo(objectTop + objectHeight + 8)
  })

  it('shape 属性组：多边形边数可编辑，直线仅描边色/宽无填充', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push(createPolygonObject(10, 10, 100, 80))
    doc.objects.push(createLineObject(10, 400, 200, 4))
    const { container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    const objectEls = [...container.querySelectorAll('[data-design-board-object]')] as HTMLElement[]
    fireEvent.pointerDown(objectEls[0], { button: 0 })
    const toolbar = container.querySelector('[data-design-board-property-toolbar]') as HTMLElement
    const sidesInput = within(toolbar).getByLabelText('边数') as HTMLInputElement
    expect(sidesInput.value).toBe('6')
    expect(within(toolbar).getByLabelText('填充颜色')).toBeTruthy()
    fireEvent.change(sidesInput, { target: { value: '9' } })
    expect(sidesInput.value).toBe('9')
    fireEvent.pointerDown(objectEls[1], { button: 0 })
    const lineToolbar = container.querySelector(
      '[data-design-board-property-toolbar]'
    ) as HTMLElement
    expect(within(lineToolbar).getByLabelText('描边颜色')).toBeTruthy()
    expect(within(lineToolbar).getByLabelText('描边宽度')).toBeTruthy()
    expect(within(lineToolbar).queryByLabelText('填充颜色')).toBeNull()
    expect(within(lineToolbar).queryByLabelText('边数')).toBeNull()
  })

  it('文本编辑态隐藏属性工具栏，退出编辑后恢复', () => {
    const { container } = setup()
    placeTextOnBoard(container)
    expect(container.querySelector('[data-design-board-property-toolbar]')).toBeNull()
    // 失焦提交草稿退出编辑，选中保持
    fireEvent.focusOut(screen.getByRole('textbox'))
    expect(container.querySelector('[data-design-board-property-toolbar]')).toBeTruthy()
  })

  it('属性工具栏修改文本字号并随完成编辑提交', () => {
    const { onCommit, container } = setup()
    placeTextOnBoard(container)
    fireEvent.focusOut(screen.getByRole('textbox'))
    const fontSizeInput = screen.getByLabelText('字号') as HTMLInputElement
    fireEvent.change(fontSizeInput, { target: { value: '32' } })
    expect(fontSizeInput.value).toBe('32')
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects[0]).toMatchObject({ kind: 'text', fontSize: 32 })
  })

  it('属性工具栏描边颜色以白色占位显示 transparent 并写回新 hex', () => {
    const { onCommit, container } = setup()
    drawShapeOnBoard(container, '矩形')
    const toolbar = container.querySelector('[data-design-board-property-toolbar]') as HTMLElement
    const strokeInput = within(toolbar).getByLabelText('描边颜色') as HTMLInputElement
    expect(strokeInput.value).toBe('#ffffff')
    fireEvent.change(strokeInput, { target: { value: '#ff0000' } })
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects[0]).toMatchObject({ kind: 'rect', stroke: '#ff0000' })
  })

  it('属性工具栏删除选中对象', () => {
    const { onCommit, container } = setup()
    drawShapeOnBoard(container, '矩形')
    const toolbar = container.querySelector('[data-design-board-property-toolbar]') as HTMLElement
    fireEvent.click(within(toolbar).getByRole('button', { name: '删除' }))
    expect(container.querySelector('[data-design-board-property-toolbar]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(doc.objects).toHaveLength(0)
  })

  it('文本按显式换行渲染为逐行 div（与 canvas 排版同源）', () => {
    const { container } = setup()
    placeTextOnBoard(container)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a\nb' } })
    // 失焦提交草稿：对象切到非编辑态，按排版结果逐行渲染
    fireEvent.focusOut(screen.getByRole('textbox'))
    const lines = container.querySelectorAll('[data-design-board-text-line]')
    expect(lines).toHaveLength(2)
  })

  it('图层面板按 z 序倒序列出条目，点条目选中对象并高亮', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    const first = createRectObject(10, 10, 100, 80)
    const second = createRectObject(300, 10, 100, 80)
    doc.objects.push(first, second)
    const { container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    const panel = container.querySelector('[data-design-board-layers-panel]') as HTMLElement
    // 数组后者在上：首行是 second
    const rows = [...panel.querySelectorAll('[data-design-board-layer-item]')] as HTMLElement[]
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByTitle('矩形')).toBeTruthy()
    expect(within(rows[1]).getByTitle('矩形')).toBeTruthy()
    fireEvent.click(within(rows[1]).getByTitle('矩形'))
    // 选中反馈：属性工具栏出现该类型控件 + 条目主题 active 底色
    const toolbar = container.querySelector('[data-design-board-property-toolbar]') as HTMLElement
    expect(within(toolbar).getByLabelText('填充颜色')).toBeTruthy()
    expect(rows[1].style.backgroundColor).toBe('rgb(231, 229, 223)')
    expect(rows[0].style.backgroundColor).toBe('')
  })

  it('图层面板眼睛切换隐藏对象：画布 DOM 不渲染且提交 visible=false', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push(createRectObject(10, 10, 100, 80))
    const { onCommit, container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    expect(container.querySelector('[data-design-board-object]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    const panel = container.querySelector('[data-design-board-layers-panel]') as HTMLElement
    fireEvent.click(within(panel).getByRole('button', { name: '隐藏图层' }))
    expect(container.querySelector('[data-design-board-object]')).toBeNull()
    expect(within(panel).getByRole('button', { name: '显示图层' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const committed = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(committed.objects[0].visible).toBe(false)
  })

  it('图层面板 ↑（上移一层）调整对象层级并随完成编辑提交', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    const first = createRectObject(10, 10, 100, 80)
    const second = createRectObject(300, 10, 100, 80)
    doc.objects.push(first, second)
    const { onCommit, container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    const panel = container.querySelector('[data-design-board-layers-panel]') as HTMLElement
    const rows = [...panel.querySelectorAll('[data-design-board-layer-item]')] as HTMLElement[]
    // first 在面板底部一行，↑ 后移到数组末尾（z 序最上层）
    fireEvent.click(within(rows[1]).getByRole('button', { name: '上移一层' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const committed = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(committed.objects.map((object) => object.id)).toEqual([second.id, first.id])
  })

  it('图层面板拖拽手柄 drop 到目标条目后按索引重排', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    const first = createRectObject(10, 10, 100, 80)
    const second = createRectObject(300, 10, 100, 80)
    doc.objects.push(first, second)
    const { onCommit, container } = setup({ node: { ...boardNode, metadata: { design: doc } } })
    fireEvent.click(screen.getByRole('button', { name: '图层' }))
    const panel = container.querySelector('[data-design-board-layers-panel]') as HTMLElement
    const rows = [...panel.querySelectorAll('[data-design-board-layer-item]')] as HTMLElement[]
    const handle = rows[1].querySelector('[data-design-board-layer-handle]') as HTMLElement
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => first.id) }
    fireEvent.dragStart(handle, { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', first.id)
    fireEvent.dragOver(rows[0], { dataTransfer })
    fireEvent.drop(rows[0], { dataTransfer })
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const committed = onCommit.mock.calls[0][0] as DesignBoardDoc
    expect(committed.objects.map((object) => object.id)).toEqual([second.id, first.id])
  })

  it('帮助面板静态列出全部编辑器快捷键', () => {
    const { container } = setup()
    fireEvent.click(screen.getByRole('button', { name: '快捷键' }))
    const panel = container.querySelector('[data-design-board-side-panel]') as HTMLElement
    for (const keys of ['Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+D', 'Ctrl+1', 'Escape', 'Ctrl+滚轮']) {
      expect(within(panel).getByText(keys)).toBeTruthy()
    }
    expect(within(panel).getByText('Delete / Backspace')).toBeTruthy()
  })
})
