/**
 * Slot 信任边界测试（P2）
 *
 * 桌面端只执行本地编译产物中的 renderer：服务端 ui-contributions manifest 的
 * rendererKey 必须命中 RENDERERS 白名单才会被注册；未知 key、非 active 状态、
 * 单个贡献的渲染失败都不得影响宿主页面或其他贡献。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import { SlotProvider, requestSlotRevalidation } from './slot-context'
import { useSlotRegistry } from './slot-context-value'
import { SlotRenderer } from '../components/slot/SlotRenderer'
import { PluginUiRegistry } from '../ui/plugin-ui-registry'
import type { PluginUiContribution } from '../api/plugin-client'

vi.mock('../api/plugin-client', () => ({
  getPluginUiContributions: vi.fn(),
}))

// eslint-disable-next-line import/first
import { getPluginUiContributions } from '../api/plugin-client'

const mockGet = vi.mocked(getPluginUiContributions)

function contribution(
  overrides: Partial<PluginUiContribution> & { contributionId?: string } = {}
): PluginUiContribution {
  return {
    pluginId: 'test-plugin',
    activationGeneration: 1,
    contributionId: overrides.contributionId ?? 'contrib-1',
    slot: 'app.navigation',
    scope: 'app',
    priority: 10,
    rendererKey: 'builtin.hello-panel',
    props: {},
    state: 'active',
    ...overrides,
  }
}

/** 把 registry 暴露给测试，同时渲染 sidebar slot 的内容 */
let captured: PluginUiRegistry | null = null
function Probe(): ReactElement {
  const registry = useSlotRegistry()
  captured = registry
  return createElement(SlotRenderer, { name: 'sidebar.navigation' })
}

beforeEach(() => {
  captured = null
  mockGet.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ui-contributions → Slot 注册（白名单解析）', () => {
  it('active 且 rendererKey 在白名单内：注册到映射后的 slot 并合并 props', async () => {
    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [
        contribution({ props: { initialGreetCount: 3 } }),
      ],
    })

    render(createElement(SlotProvider, null, createElement(Probe)))

    await waitFor(() => {
      expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(1)
    })
    // 文案来自本地编译的 HelloPanelContribution，props 已透传
    expect(screen.getByText(/累计问候：3/)).toBeDefined()
  })

  it('rendererKey 不在白名单内：跳过且不留任何注册', async () => {
    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [contribution({ rendererKey: 'https://evil.example/payload.js' })],
    })

    render(createElement(SlotProvider, null, createElement(Probe)))

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled()
    })
    expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(0)
    expect(screen.queryByText(/Hello 插件/)).toBeNull()
  })

  it('label 下发到注册项，供 tab 栏等位置显示', async () => {
    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [
        contribution({
          slot: 'right-panel.tab',
          rendererKey: 'builtin.hello-right-panel',
          label: '我的插件视图',
        }),
      ],
    })

    render(createElement(SlotProvider, null, createElement(Probe)))

    await waitFor(() => {
      expect(captured?.rawEntries('right-panel.tab')).toHaveLength(1)
    })
    const entry = captured!.rawEntries('right-panel.tab')[0]!
    expect(entry.options.label).toBe('我的插件视图')
  })

  it('state 非 active 的贡献不注册', async () => {
    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [contribution({ state: 'restart-required' })],
    })

    render(createElement(SlotProvider, null, createElement(Probe)))

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled()
    })
    expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(0)
  })

  it('单个贡献注册冲突不影响其他贡献', async () => {
    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [
        contribution({ contributionId: 'a', priority: 10 }),
        // 同 pluginId+contributionId 会生成相同 entry id，第二次注册抛冲突
        contribution({ contributionId: 'a', priority: 10 }),
        contribution({ contributionId: 'b', priority: 20 }),
      ],
    })

    render(createElement(SlotProvider, null, createElement(Probe)))

    await waitFor(() => {
      expect(captured?.rawEntries('sidebar.navigation').length).toBeGreaterThan(0)
    })
    // 冲突的那个被跳过，健康的 b 正常注册
    const ids = captured?.rawEntries('sidebar.navigation').map((entry) => entry.id)
    expect(ids).toContain('test-plugin:1:b')
  })

  it('卸载时撤销全部注册', async () => {
    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [contribution()],
    })

    const { unmount } = render(createElement(SlotProvider, null, createElement(Probe)))
    await waitFor(() => {
      expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(1)
    })

    unmount()
    // registry 随 provider 销毁前已逐个 dispose：重新挂一个只读探针验证
    const registry = captured
    expect(registry?.rawEntries('sidebar.navigation')).toHaveLength(0)
  })

  it('服务端不可用时保留宿主 UI，不抛错', async () => {
    mockGet.mockRejectedValue(new Error('connection refused'))

    render(createElement(SlotProvider, null, createElement(Probe)))

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled()
    })
    expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(0)
  })
})

describe('运行期插件变更后的增量对齐', () => {
  it('插件被禁用后其贡献从 UI 撤销（不必等重启）', async () => {
    mockGet.mockResolvedValue({ schemaVersion: 1, contributions: [contribution()] })

    render(createElement(SlotProvider, null, createElement(Probe)))
    await waitFor(() => {
      expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(1)
    })

    // 服务端现在不再返回该贡献（插件被 disable）
    mockGet.mockResolvedValue({ schemaVersion: 1, contributions: [] })
    requestSlotRevalidation()

    await waitFor(() => {
      expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(0)
    })
    // ledger 记录为 disposed，而不是凭空消失
    const ledger = captured!
      .ledgerSnapshot()
      .find((item) => item.effectId === 'test-plugin:1:contrib-1')
    expect(ledger?.status).toBe('disposed')
  })

  it('未变化的贡献不重复注册（幂等对齐）', async () => {
    mockGet.mockResolvedValue({ schemaVersion: 1, contributions: [contribution()] })

    render(createElement(SlotProvider, null, createElement(Probe)))
    await waitFor(() => {
      expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(1)
    })
    const before = captured!.rawEntries('sidebar.navigation')[0]!.id

    requestSlotRevalidation()
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledTimes(2)
    })

    const entries = captured!.rawEntries('sidebar.navigation')
    expect(entries).toHaveLength(1)
    // 同一 entry 被保留，没有被撤销后重建
    expect(entries[0]!.id).toBe(before)
  })

  it('activationGeneration 换代时撤销旧贡献并注册新贡献', async () => {
    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [contribution({ activationGeneration: 1 })]
    })

    render(createElement(SlotProvider, null, createElement(Probe)))
    await waitFor(() => {
      expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(1)
    })

    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [contribution({ activationGeneration: 2 })]
    })
    requestSlotRevalidation()

    await waitFor(() => {
      const ids = captured!.rawEntries('sidebar.navigation').map((entry) => entry.id)
      expect(ids).toEqual(['test-plugin:2:contrib-1'])
    })
  })

  it('props 变化时替换注册（旧 entry 不残留）', async () => {
    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [contribution({ props: { initialGreetCount: 1 } })]
    })

    render(createElement(SlotProvider, null, createElement(Probe)))
    await waitFor(() => {
      expect(screen.getByText(/累计问候：1/)).toBeDefined()
    })

    mockGet.mockResolvedValue({
      schemaVersion: 1,
      contributions: [contribution({ props: { initialGreetCount: 9 } })]
    })
    requestSlotRevalidation()

    await waitFor(() => {
      expect(screen.getByText(/累计问候：9/)).toBeDefined()
    })
    expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(1)
  })

  it('重新拉取失败时保留已注册贡献（网络抖动不该让界面塌掉）', async () => {
    mockGet.mockResolvedValue({ schemaVersion: 1, contributions: [contribution()] })

    render(createElement(SlotProvider, null, createElement(Probe)))
    await waitFor(() => {
      expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(1)
    })

    mockGet.mockRejectedValue(new Error('temporary failure'))
    requestSlotRevalidation()

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledTimes(2)
    })
    expect(captured?.rawEntries('sidebar.navigation')).toHaveLength(1)
  })
})

describe('SlotRenderer 渲染错误隔离', () => {
  it('单个 entry 崩溃不影响同 slot 其他 entry 与宿主内容', async () => {
    mockGet.mockResolvedValue({ schemaVersion: 1, contributions: [] })

    // 屏蔽 React 的错误日志（预期内的崩溃）
    vi.spyOn(console, 'error').mockImplementation(() => {})

    function Boom(): never {
      throw new Error('contribution crashed')
    }

    render(
      createElement(SlotProvider, null,
        createElement(Probe),
        createElement('div', null, 'host-content')
      )
    )

    // 直接向当前 registry 注册一个会崩溃的组件
    const registry = captured
    await waitFor(() => {
      expect(registry).not.toBeNull()
    })
    registry!.register(
      {
        name: 'sidebar.navigation',
        pluginId: 'boom',
        contributionId: 'boom-entry',
        id: 'boom-entry',
      },
      Boom
    )

    // 宿主内容仍然在
    expect(screen.getByText('host-content')).toBeDefined()
    // 崩溃的 entry 不渲染任何内容，但 ledger 记录了 failed
    await waitFor(() => {
      const ledger = registry!
        .ledgerSnapshot()
        .find((item) => item.effectId === 'boom:boom-entry')
      expect(ledger?.status).toBe('failed')
    })
  })
})
