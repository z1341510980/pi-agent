import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DesignBoardCreateDialog } from '../design-board-create-dialog'

afterEach(cleanup)

describe('DesignBoardCreateDialog', () => {
  it('lists presets with dimensions and confirms selection', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<DesignBoardCreateDialog onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.getByText('小红书竖图 3:4')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /创建画板/ }))
    expect(onConfirm).toHaveBeenCalledWith({ width: 1080, height: 1440 })
  })

  it('supports custom dimensions with clamping', () => {
    const onConfirm = vi.fn()
    render(<DesignBoardCreateDialog onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: /自定义/ }))
    fireEvent.change(screen.getByLabelText('宽'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('宽'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /创建画板/ }))
    expect(onConfirm).toHaveBeenCalledWith({ width: 100, height: 1440 })
  })
})
