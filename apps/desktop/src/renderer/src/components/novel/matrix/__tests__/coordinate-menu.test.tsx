/**
 * CoordinateMenu：按坐标弹出的浮层菜单
 *
 * 矩阵是虚拟化网格，不能给每个单元格套一个 Radix ContextMenu.Trigger，
 * 所以右键菜单走「记录 {x,y} → 受控打开」这条路，由 CoordinateMenu 把坐标
 * 包成 Popover 的锚点。
 *
 * 这里覆盖的是它替代手写实现后必须成立的那几条：受控开关、Esc 关闭、
 * 菜单语义。定位与碰撞规避交给 Radix，不在单测里断言像素。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoordinateMenu } from '../coordinate-menu'

afterEach(() => {
  cleanup()
})

describe('CoordinateMenu', () => {
  it('position 为 null 时不渲染内容', () => {
    render(
      <CoordinateMenu position={null} onClose={vi.fn()} ariaLabel="测试菜单">
        <button type="button">删除</button>
      </CoordinateMenu>,
    )

    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByText('删除')).toBeNull()
  })

  it('给出坐标即打开，并带 menu 语义与无障碍名称', () => {
    render(
      <CoordinateMenu position={{ x: 120, y: 240 }} onClose={vi.fn()} ariaLabel="章节操作">
        <button type="button">删除</button>
      </CoordinateMenu>,
    )

    expect(screen.getByRole('menu', { name: '章节操作' })).not.toBeNull()
    expect(screen.getByText('删除')).not.toBeNull()
  })

  it('Esc 触发 onClose（手写版本各自实现过一遍 keydown 监听）', () => {
    const onClose = vi.fn()
    render(
      <CoordinateMenu position={{ x: 10, y: 10 }} onClose={onClose} ariaLabel="测试菜单">
        <button type="button">删除</button>
      </CoordinateMenu>,
    )

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('菜单内部点击不会关闭 —— 无需再给每个条目挂 stopPropagation', () => {
    const onClose = vi.fn()
    const onPick = vi.fn()
    render(
      <CoordinateMenu position={{ x: 10, y: 10 }} onClose={onClose} ariaLabel="测试菜单">
        <button type="button" onClick={onPick}>
          删除
        </button>
      </CoordinateMenu>,
    )

    fireEvent.click(screen.getByText('删除'))

    expect(onPick).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('菜单上再次右键不穿透到底层', () => {
    render(
      <CoordinateMenu position={{ x: 10, y: 10 }} onClose={vi.fn()} ariaLabel="测试菜单">
        <button type="button">删除</button>
      </CoordinateMenu>,
    )

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    fireEvent(screen.getByRole('menu'), event)

    expect(event.defaultPrevented).toBe(true)
  })
})
