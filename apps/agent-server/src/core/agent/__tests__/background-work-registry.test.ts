import { describe, expect, it } from 'vitest'
import { BackgroundWorkRegistry } from '../background-work-registry.js'

describe('BackgroundWorkRegistry', () => {
  it('registers, lists, and disposes providers idempotently', () => {
    const registry = new BackgroundWorkRegistry()
    const dispose = registry.register('novel', { listActive: () => [{ id: 'chapter-1' }] })
    expect(registry.listActive()).toEqual([{ provider: 'novel', id: 'chapter-1' }])
    dispose()
    dispose()
    expect(registry.listActive()).toEqual([])
  })

  it('isolates provider failures', () => {
    const registry = new BackgroundWorkRegistry()
    registry.register('broken', { listActive: () => { throw new Error('boom') } })
    registry.register('healthy', { listActive: () => [{ id: 'ok' }] })
    expect(registry.listActive()).toEqual([{ provider: 'healthy', id: 'ok' }])
  })
})
