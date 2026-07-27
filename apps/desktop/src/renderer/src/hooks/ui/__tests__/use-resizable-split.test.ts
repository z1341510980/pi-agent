import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResizableSplit } from '../use-resizable-split'

describe('useResizableSplit', () => {
  beforeEach(() => {
    localStorage.clear()
    window.dispatchEvent = vi.fn()
  })

  it('初始化使用 defaultWidth', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, unit: 'ratio' }))
    expect(result.current.splitRatio).toBe(50)
  })

  it('从 storageKey 恢复持久化值', () => {
    localStorage.setItem('test-split', '70')
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, storageKey: 'test-split', unit: 'ratio' }))
    expect(result.current.splitRatio).toBe(70)
  })

  it('setSplitRatio 更新值并持久化', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, storageKey: 'test-split', unit: 'ratio' }))
    act(() => result.current.setSplitRatio(80))
    expect(result.current.splitRatio).toBe(80)
    expect(localStorage.getItem('test-split')).toBe('80')
  })

  it('unit=px 时按像素工作', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 400, unit: 'px', storageKey: 'test-px' }))
    expect(result.current.splitRatio).toBe(400)
  })

  it('setSplitRatio 钳制在 [minWidth, maxWidth]', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, minWidth: 20, maxWidth: 80, unit: 'ratio' }))
    act(() => result.current.setSplitRatio(10))
    expect(result.current.splitRatio).toBe(20)
    act(() => result.current.setSplitRatio(100))
    expect(result.current.splitRatio).toBe(80)
  })

  it('返回 dragHandle React 元素', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, unit: 'ratio' }))
    expect(result.current.dragHandle).toBeDefined()
    expect(result.current.dragHandle.type).toBe('div')
  })
})
