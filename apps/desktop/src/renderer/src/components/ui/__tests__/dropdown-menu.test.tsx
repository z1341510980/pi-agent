/**
 * DropdownMenu primitive
 *
 * 补齐这个 primitive 的目的就是替掉手写的 `absolute` 浮层 +
 * `document.addEventListener('mousedown')`。手写版本共同缺失的是菜单语义与键盘操作，
 * 所以这里覆盖的正是那几条：role、上下键遍历、选中后自动关闭、Esc 关闭、禁用项不可选。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu'

afterEach(() => {
  cleanup()
})

function Harness({ onPick = vi.fn() }: { onPick?: (v: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>打开菜单</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => onPick('auto')}>自动</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick('plan')}>计划</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled onSelect={() => onPick('full')}>
          完全控制
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

describe('DropdownMenu', () => {
  it('默认关闭，点击 trigger 后展开为 role=menu', () => {
    render(<Harness />)

    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.pointerDown(
      screen.getByText('打开菜单'),
      new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }),
    )

    expect(screen.getByRole('menu')).not.toBeNull()
    expect(screen.getAllByRole('menuitem').length).toBe(3)
  })

  it('trigger 用 aria-expanded 表达开合', () => {
    render(<Harness />)
    const trigger = screen.getByText('打开菜单')

    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('方向键即可打开并把焦点送进菜单（手写浮层只能用鼠标）', () => {
    render(<Harness />)

    fireEvent.keyDown(screen.getByText('打开菜单'), { key: 'ArrowDown' })

    // 打开后焦点直接落在首个条目上，无需先 Tab 进浮层
    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toBe(document.activeElement)
    expect(items[0].getAttribute('data-highlighted')).not.toBeNull()
  })

  it('选中条目后回传并自动关闭', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)

    fireEvent.keyDown(screen.getByText('打开菜单'), { key: 'Enter' })
    fireEvent.click(screen.getByText('计划'))

    expect(onPick).toHaveBeenCalledWith('plan')
    expect(screen.getByText('打开菜单').getAttribute('aria-expanded')).toBe('false')
  })

  it('禁用条目不触发 onSelect', () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)

    fireEvent.keyDown(screen.getByText('打开菜单'), { key: 'Enter' })
    fireEvent.click(screen.getByText('完全控制'))

    expect(onPick).not.toHaveBeenCalled()
  })

  it('Esc 关闭', () => {
    render(<Harness />)
    const trigger = screen.getByText('打开菜单')

    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
