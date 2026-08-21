import { describe, expect, it, vi } from 'vitest'
import { PluginUiRegistry } from '../ui/plugin-ui-registry'
import type { SlotSpec } from '../ui/slot-types'

const component = () => null
const declare = (registry: PluginUiRegistry, name: string, spec: SlotSpec): void => {
  registry.declareSlot(name, spec, 'test-host')
}

describe('PluginUiRegistry', () => {
  it('要求先声明 Slot，并通过 disposer 幂等回收注册', () => {
    const registry = new PluginUiRegistry()
    expect(() => registry.register({ name: 'undeclared', pluginId: 'a' }, component)).toThrow(
      '未声明'
    )

    declare(registry, 'test.list', { kind: 'list', scope: 'root' })
    const dispose = registry.register(
      { name: 'test.list', pluginId: 'a', id: 'entry-a' },
      component
    )
    expect(registry.entriesOfSlot('test.list')).toHaveLength(1)
    dispose()
    dispose()
    expect(registry.entriesOfSlot('test.list')).toHaveLength(0)
    expect(registry.ledgerSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ effectId: 'a:contribution-1', status: 'disposed' })
      ])
    )
  })

  it('single 同 priority 冲突，较高 priority 可 shadow', () => {
    const registry = new PluginUiRegistry()
    declare(registry, 'test.single', { kind: 'single', scope: 'root' })
    registry.register({ name: 'test.single', pluginId: 'a', priority: 10 }, component)
    expect(() =>
      registry.register({ name: 'test.single', pluginId: 'b', priority: 10 }, component)
    ).toThrow('冲突')
    registry.register({ name: 'test.single', pluginId: 'b', priority: 20 }, component)
    expect(registry.entriesOfSlot('test.single')[0].pluginId).toBe('a')
    expect(
      registry
        .ledgerSnapshot()
        .filter((item) => item.slot === 'test.single')
        .map((item) => item.active)
    ).toEqual([true, false])
  })

  it('keyed 每个 key 独立选举，list 保留全部条目并按 order 排序', () => {
    const registry = new PluginUiRegistry()
    declare(registry, 'test.keyed', { kind: 'keyed', scope: 'session-maybe' })
    registry.register({ name: 'test.keyed', pluginId: 'a', key: 'one', priority: 20 }, component)
    registry.register({ name: 'test.keyed', pluginId: 'b', key: 'one', priority: 10 }, component)
    registry.register({ name: 'test.keyed', pluginId: 'c', key: 'two', priority: 10 }, component)
    expect(registry.entriesOfSlot('test.keyed').map((item) => item.pluginId)).toEqual(['b', 'c'])

    declare(registry, 'test.list', { kind: 'list', scope: 'root' })
    registry.register({ name: 'test.list', pluginId: 'a', id: 'a', order: 20 }, component)
    registry.register({ name: 'test.list', pluginId: 'b', id: 'b', order: 10 }, component)
    expect(registry.entriesOfSlot('test.list').map((item) => item.pluginId)).toEqual(['b', 'a'])
  })

  it('chain 要求 selector，并按 priority 返回候选链', () => {
    const registry = new PluginUiRegistry()
    declare(registry, 'test.chain', { kind: 'chain', scope: 'session' })
    const select = () => true
    registry.register({ name: 'test.chain', pluginId: 'a', priority: 20, select }, component)
    registry.register({ name: 'test.chain', pluginId: 'b', priority: 10, select }, component)
    expect(registry.entriesOfSlot('test.chain').map((item) => item.pluginId)).toEqual(['b', 'a'])
    expect(() => registry.register({ name: 'test.chain', pluginId: 'bad' }, component)).toThrow(
      'options.select'
    )
  })

  it('children 声明构建树，disposer 同时撤销子 Slot', () => {
    const registry = new PluginUiRegistry()
    declare(registry, 'test.parent', { kind: 'list', scope: 'root' })
    const dispose = registry.register(
      {
        name: 'test.parent',
        pluginId: 'parent',
        id: 'parent-entry',
        children: { 'test.parent.child': { kind: 'list', scope: 'session' } }
      },
      component
    )
    expect(registry.spec('test.parent.child')).toEqual({ kind: 'list', scope: 'session' })
    expect(registry.snapshot('test.parent')[0].children[0].name).toBe('test.parent.child')
    dispose()
    expect(registry.spec('test.parent.child')).toBeUndefined()
  })

  it('snapshot 标记 shadowed、active 和渲染失败', () => {
    const registry = new PluginUiRegistry()
    declare(registry, 'test.single', { kind: 'single', scope: 'root' })
    const first = registry.register({ name: 'test.single', pluginId: 'a', priority: 1 }, component)
    const second = registry.register({ name: 'test.single', pluginId: 'b', priority: 2 }, component)
    const entries = registry.rawEntries('test.single')
    registry.reportEntryError('test.single', entries[0], new Error('render failed'))
    const snapshot = registry.snapshot('test.single')[0]
    expect(snapshot.occupants.find((item) => item.pluginId === 'a')?.status).toBe('failed')
    expect(snapshot.occupants.find((item) => item.pluginId === 'b')?.active).toBe(true)
    first()
    second()
  })

  it('订阅通知隔离 listener 错误', () => {
    const registry = new PluginUiRegistry()
    declare(registry, 'test.list', { kind: 'list', scope: 'root' })
    const listener = vi.fn(() => {
      throw new Error('listener failed')
    })
    const healthy = vi.fn()
    registry.subscribe('test.list', listener)
    registry.subscribe('test.list', healthy)
    const dispose = registry.register({ name: 'test.list', pluginId: 'a', id: 'a' }, component)
    expect(listener).toHaveBeenCalled()
    expect(healthy).toHaveBeenCalled()
    dispose()
  })
})
