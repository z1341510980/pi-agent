import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SplitDialog } from '../split-dialog'
import type { CanvasTheme } from '../canvas-theme'

vi.mock('../media-stage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media-stage')>()
  return { ...actual, useImageNaturalSize: () => ({ width: 800, height: 600 }) }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const theme = {
  node: {
    panel: '#fff',
    fill: '#eee',
    text: '#111',
    muted: '#666',
    stroke: '#ddd',
    placeholder: '#999',
    activeStroke: '#2563eb'
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

const stageRect = {
  left: 0,
  top: 0,
  width: 480,
  height: 360,
  right: 480,
  bottom: 360,
  x: 0,
  y: 0,
  toJSON: () => ({})
} as DOMRect

function renderDialog(): { onConfirm: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(stageRect)
  render(
    <SplitDialog
      theme={theme}
      source="data:image/png;base64,A"
      onClose={vi.fn()}
      onConfirm={onConfirm}
    />
  )
  return { onConfirm }
}

function drag(element: Element, points: Array<{ x: number; y: number }>): void {
  const last = points[points.length - 1]
  fireEvent.pointerDown(element, { pointerId: 1, clientX: points[0].x, clientY: points[0].y })
  for (const point of points.slice(1)) {
    fireEvent.pointerMove(element, { pointerId: 1, clientX: point.x, clientY: point.y })
  }
  fireEvent.pointerUp(element, { pointerId: 1, clientX: last.x, clientY: last.y })
}

describe('拆分对话框', () => {
  it('默认 2×2 均分确认', () => {
    const { onConfirm } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [50],
      columnCuts: [50]
    })
  })

  it('拖动列切割线改变位置并显示浮签', () => {
    const { onConfirm } = renderDialog()
    const line = document.querySelector('[data-cut="column"][data-cut-index="0"]')!
    fireEvent.pointerDown(line, { pointerId: 1, clientX: 240, clientY: 180 })
    fireEvent.pointerMove(line, { pointerId: 1, clientX: 120, clientY: 180 })
    expect(document.querySelector('[data-cut-label]')).not.toBeNull()
    expect(document.querySelector('[data-cut-label]')?.textContent).toContain('25%')
    fireEvent.pointerUp(line, { pointerId: 1, clientX: 120, clientY: 180 })
    expect(document.querySelector('[data-cut-label]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [50],
      columnCuts: [25]
    })
  })

  it('切割线钳制最小间距', () => {
    const { onConfirm } = renderDialog()
    drag(document.querySelector('[data-cut="column"][data-cut-index="0"]')!, [
      { x: 240, y: 180 },
      { x: 0, y: 180 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [50],
      columnCuts: [5]
    })
  })

  it('行数增加时在最大空隙中点插入切割线', () => {
    const { onConfirm } = renderDialog()
    fireEvent.change(screen.getByLabelText('行数'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '创建 6 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 3,
      columns: 2,
      rowCuts: [25, 50],
      columnCuts: [50]
    })
  })

  it('行数减少时移除最接近中间的切割线', () => {
    const { onConfirm } = renderDialog()
    fireEvent.change(screen.getByLabelText('行数'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('行数'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [25],
      columnCuts: [50]
    })
  })

  it('拖动行切割线改变位置', () => {
    const { onConfirm } = renderDialog()
    drag(document.querySelector('[data-cut="row"][data-cut-index="0"]')!, [
      { x: 240, y: 180 },
      { x: 240, y: 90 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [25],
      columnCuts: [50]
    })
  })
})
