import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../events/event-bus.js'

describe('EventBus', () => {
  it('订阅和发布事件', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('test:event', handler)
    bus.emit('test:event', { value: 42 })
    expect(handler).toHaveBeenCalledWith({ value: 42 })
  })

  it('取消订阅后不再收到事件', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('test:event', handler)
    bus.off('test:event', handler)
    bus.emit('test:event', { value: 1 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('同一事件多个处理器', () => {
    const bus = new EventBus()
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    bus.on('test:event', handler1)
    bus.on('test:event', handler2)
    bus.emit('test:event', {})
    expect(handler1).toHaveBeenCalled()
    expect(handler2).toHaveBeenCalled()
  })

  it('一次性订阅', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.once('test:event', handler)
    bus.emit('test:event', {})
    bus.emit('test:event', {})
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('无订阅者时 emit 不报错', () => {
    const bus = new EventBus()
    expect(() => bus.emit('nonexistent', {})).not.toThrow()
  })

  it('处理器抛出异常不影响其他处理器', () => {
    const bus = new EventBus()
    const handler1 = vi.fn(() => {
      throw new Error('handler1 error')
    })
    const handler2 = vi.fn()
    bus.on('test:event', handler1)
    bus.on('test:event', handler2)
    bus.emit('test:event', {})
    expect(handler2).toHaveBeenCalled()
  })
})
