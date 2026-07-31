/**
 * Segmented 分段选择器
 *
 * 收口小说工作台此前四处手写的 segmented 实现。作为共享 primitive，
 * 它的键盘与 aria 契约会被多处依赖，故单独覆盖。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Segmented, type SegmentedOption } from '../segmented'

type Mode = 'a' | 'b' | 'c'

const OPTIONS: ReadonlyArray<SegmentedOption<Mode>> = [
  { value: 'a', label: '甲' },
  { value: 'b', label: '乙', title: '乙的提示' },
  { value: 'c', label: '丙', dataTour: 'tour-c' },
]

afterEach(() => {
  cleanup()
})

describe('Segmented', () => {
  it('用 tablist / tab + aria-selected 表达选中态', () => {
    render(<Segmented options={OPTIONS} value="b" onChange={vi.fn()} ariaLabel="测试分段" />)

    expect(screen.getByRole('tablist', { name: '测试分段' })).not.toBeNull()
    expect(screen.getByRole('tab', { name: '乙' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: '甲' }).getAttribute('aria-selected')).toBe('false')
  })

  it('点击回传对应 value', () => {
    const onChange = vi.fn()
    render(<Segmented options={OPTIONS} value="a" onChange={onChange} ariaLabel="测试分段" />)

    fireEvent.click(screen.getByRole('tab', { name: '丙' }))

    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('只有选中项进 Tab 序列（tablist 惯例，其余靠方向键到达）', () => {
    render(<Segmented options={OPTIONS} value="b" onChange={vi.fn()} ariaLabel="测试分段" />)

    expect(screen.getByRole('tab', { name: '乙' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('tab', { name: '甲' }).getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('tab', { name: '丙' }).getAttribute('tabindex')).toBe('-1')
  })

  it('左右方向键移动选中项并在首尾循环', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Segmented options={OPTIONS} value="a" onChange={onChange} ariaLabel="测试分段" />,
    )
    const list = screen.getByRole('tablist')

    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('b')

    // 头部左移循环到尾部
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('c')

    // 尾部右移循环回头部
    rerender(<Segmented options={OPTIONS} value="c" onChange={onChange} ariaLabel="测试分段" />)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('a')
  })

  it('无关按键不触发变更', () => {
    const onChange = vi.fn()
    render(<Segmented options={OPTIONS} value="a" onChange={onChange} ariaLabel="测试分段" />)

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowDown' })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('title 缺省回落到 label，dataTour 落到对应选项上', () => {
    render(<Segmented options={OPTIONS} value="a" onChange={vi.fn()} ariaLabel="测试分段" />)

    expect(screen.getByRole('tab', { name: '甲' }).getAttribute('title')).toBe('甲')
    expect(screen.getByRole('tab', { name: '乙' }).getAttribute('title')).toBe('乙的提示')
    expect(screen.getByRole('tab', { name: '丙' }).getAttribute('data-tour')).toBe('tour-c')
  })
})
