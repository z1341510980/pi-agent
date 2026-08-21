/**
 * Slot 渲染点接线测试（P2）
 *
 * 覆盖本轮新接线的能力：keyed slot 按 entryKey 取席位、list slot 按 entryId
 * 取单条（tab 内容区）、chain slot 的 selector 短路、没有 SlotProvider 时
 * 宿主 UI 照常工作。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import { SlotContext } from './slot-context-value'
import { SlotRenderer } from '../components/slot/SlotRenderer'
import { PluginUiRegistry } from '../ui/plugin-ui-registry'

afterEach(cleanup)

function withRegistry(registry: PluginUiRegistry, ...children: ReactElement[]): ReactElement {
  return createElement(SlotContext.Provider, { value: registry }, ...children)
}

const label = (text: string) => () => createElement('span', null, text)

describe('keyed slot：workspace.main 按 entryKey 取席位', () => {
  it('只渲染命中 key 的贡献', () => {
    const registry = new PluginUiRegistry()
    registry.register(
      { name: 'workspace.main', pluginId: 'p', contributionId: 'a', key: 'page-a' },
      label('page-a-content')
    )
    registry.register(
      { name: 'workspace.main', pluginId: 'p', contributionId: 'b', key: 'page-b' },
      label('page-b-content')
    )

    render(
      withRegistry(
        registry,
        createElement(SlotRenderer, { name: 'workspace.main', entryKey: 'page-b' })
      )
    )

    expect(screen.getByText('page-b-content')).toBeDefined()
    expect(screen.queryByText('page-a-content')).toBeNull()
  })

  it('key 不存在时渲染 fallback —— 插件被禁用后不留空白页', () => {
    const registry = new PluginUiRegistry()
    render(
      withRegistry(
        registry,
        createElement(SlotRenderer, {
          name: 'workspace.main',
          entryKey: 'missing',
          fallback: createElement('div', null, 'unavailable')
        })
      )
    )
    expect(screen.getByText('unavailable')).toBeDefined()
  })
})

describe('list slot：right-panel.tab 按 entryId 取单条', () => {
  it('tab 内容区只渲染当前选中项', () => {
    const registry = new PluginUiRegistry()
    registry.register(
      { name: 'right-panel.tab', pluginId: 'p', contributionId: 'trace', id: 'trace' },
      label('trace-panel')
    )
    registry.register(
      { name: 'right-panel.tab', pluginId: 'p', contributionId: 'audit', id: 'audit' },
      label('audit-panel')
    )

    render(
      withRegistry(
        registry,
        createElement(SlotRenderer, { name: 'right-panel.tab', entryId: 'audit' })
      )
    )

    expect(screen.getByText('audit-panel')).toBeDefined()
    expect(screen.queryByText('trace-panel')).toBeNull()
  })

  it('不传 entryId 时渲染全部（tab 栏枚举用）', () => {
    const registry = new PluginUiRegistry()
    registry.register(
      { name: 'right-panel.tab', pluginId: 'p', contributionId: 'trace', id: 'trace' },
      label('trace-panel')
    )
    registry.register(
      { name: 'right-panel.tab', pluginId: 'p', contributionId: 'audit', id: 'audit' },
      label('audit-panel')
    )

    render(withRegistry(registry, createElement(SlotRenderer, { name: 'right-panel.tab' })))

    expect(screen.getByText('trace-panel')).toBeDefined()
    expect(screen.getByText('audit-panel')).toBeDefined()
  })
})

describe('list slot：chat.* 渲染点', () => {
  it('chat.header.actions / composer / message.actions 均可承载多条贡献', () => {
    const registry = new PluginUiRegistry()
    for (const slot of [
      'chat.header.actions',
      'chat.composer.left',
      'chat.composer.right',
      'chat.composer.dock',
      'chat.message.actions'
    ]) {
      registry.register(
        { name: slot, pluginId: 'p', contributionId: slot, id: slot },
        label(`${slot}-content`)
      )
      render(withRegistry(registry, createElement(SlotRenderer, { name: slot })))
      expect(screen.getByText(`${slot}-content`)).toBeDefined()
      cleanup()
    }
  })

  it('extraProps 透传给贡献组件', () => {
    const registry = new PluginUiRegistry()
    registry.register(
      { name: 'chat.header.actions', pluginId: 'p', contributionId: 'x', id: 'x' },
      (props: Record<string, unknown>) => createElement('span', null, String(props.threadId))
    )

    render(
      withRegistry(
        registry,
        createElement(SlotRenderer, {
          name: 'chat.header.actions',
          extraProps: { threadId: 'thread-42' }
        })
      )
    )
    expect(screen.getByText('thread-42')).toBeDefined()
  })
})

describe('chain slot', () => {
  it('select 返回 undefined 的 entry 跳过，其余按序渲染且拿到 selected', () => {
    const registry = new PluginUiRegistry()
    registry.declareSlot('test.chain', { kind: 'chain', scope: 'root' }, '(test)')
    registry.register(
      {
        name: 'test.chain',
        pluginId: 'p',
        contributionId: 'skip',
        priority: 1,
        select: () => undefined
      },
      label('should-not-render')
    )
    registry.register(
      {
        name: 'test.chain',
        pluginId: 'p',
        contributionId: 'take',
        priority: 2,
        select: (owner: { value: string }) => owner.value
      },
      (props: Record<string, unknown>) => createElement('span', null, String(props.selected))
    )

    render(
      withRegistry(
        registry,
        createElement(SlotRenderer, { name: 'test.chain', chainOwner: { value: 'chained' } })
      )
    )

    expect(screen.getByText('chained')).toBeDefined()
    expect(screen.queryByText('should-not-render')).toBeNull()
  })
})

describe('没有 SlotProvider 时', () => {
  it('渲染 fallback 而不抛错 —— 宿主组件可被局部挂载', () => {
    expect(() =>
      render(
        createElement(SlotRenderer, {
          name: 'chat.header.actions',
          fallback: createElement('div', null, 'host-only')
        })
      )
    ).not.toThrow()
    expect(screen.getByText('host-only')).toBeDefined()
  })
})
