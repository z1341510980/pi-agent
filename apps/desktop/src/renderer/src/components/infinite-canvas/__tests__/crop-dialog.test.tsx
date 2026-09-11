import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CropDialog } from '../crop-dialog'
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
    <CropDialog
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

function setField(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('裁剪对话框', () => {
  it('拖动右下角手柄缩小裁剪框并确认', () => {
    const { onConfirm } = renderDialog()
    drag(document.querySelector('[data-crop-handle="se"]')!, [
      { x: 480, y: 360 },
      { x: 240, y: 180 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 0, y: 0, width: 50, height: 50 })
  })

  it('拖动手柄时显示放大镜，松手后消失', () => {
    renderDialog()
    const handle = document.querySelector('[data-crop-handle="se"]')!
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 480, clientY: 360 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 240, clientY: 180 })
    expect(document.querySelector('[data-crop-loupe]')).not.toBeNull()
    expect(document.querySelector('[data-crop-loupe-label]')?.textContent).toMatch(
      /^\d+, \d+ · \d+×\d+$/
    )
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 240, clientY: 180 })
    expect(document.querySelector('[data-crop-loupe]')).toBeNull()
  })

  it('1:1 比例下拖动边中点手柄保持比例', () => {
    const { onConfirm } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '1:1' }))
    const handle = document.querySelector('[data-crop-handle="e"]')!
    drag(handle, [
      { x: 420, y: 180 },
      { x: 240, y: 180 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 12.5, y: 25, width: 37.5, height: 50 })
  })

  it('框内拖动整体移动', () => {
    const { onConfirm } = renderDialog()
    setField('宽', '50')
    setField('高', '50')
    drag(document.querySelector('[data-crop-move]')!, [
      { x: 120, y: 90 },
      { x: 240, y: 180 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 25, y: 25, width: 50, height: 50 })
  })

  it('空白处拖出新裁剪框', () => {
    const { onConfirm } = renderDialog()
    setField('宽', '50')
    setField('高', '50')
    drag(document.querySelector('[data-crop-overlay]')!, [
      { x: 240, y: 306 },
      { x: 336, y: 342 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 50, y: 85, width: 20, height: 10 })
  })

  it('误触的小拖拽恢复原框', () => {
    const { onConfirm } = renderDialog()
    setField('宽', '50')
    setField('高', '50')
    drag(document.querySelector('[data-crop-overlay]')!, [
      { x: 240, y: 306 },
      { x: 244.8, y: 309.6 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 0, y: 0, width: 50, height: 50 })
  })

  it('数字输入与拖动双向同步', () => {
    const { onConfirm } = renderDialog()
    setField('宽', '50')
    setField('高', '50')
    setField('X', '20')
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 20, y: 0, width: 50, height: 50 })
  })
})
