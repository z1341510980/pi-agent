/**
 * SettingsPage initialSection 测试：
 * 画布「打开设置」需直达「插件设置 → 媒体生成」分区（plugin:infinite-canvas）；
 * 未传 initialSection 时维持默认「通用设置」。
 *
 * mock 策略：plugin-client（插件设置声明 / 面板贡献 / 插件详情）与 '@/api'
 * （GeneralSettings 挂载时的偏好读取）按函数替换，其余导出保留原实现。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from '../../theme-provider'
import { SettingsPage, type SettingsSection } from '../settings-page'

const pluginApi = vi.hoisted(() => ({
  getPluginSettingsSchemas: vi.fn(),
  getPluginUiContributions: vi.fn(),
  getPlugin: vi.fn()
}))

vi.mock('@/api/plugin-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/plugin-client')>()
  return { ...actual, ...pluginApi }
})

const hostApi = vi.hoisted(() => ({
  getApi: vi.fn(),
  putApi: vi.fn(),
  postApi: vi.fn(),
  deleteApi: vi.fn()
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return { ...actual, ...hostApi }
})

function renderSettingsPage(props: { initialSection?: SettingsSection } = {}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SettingsPage onClose={vi.fn()} initialSection={props.initialSection} />
      </ThemeProvider>
    </QueryClientProvider>
  )
}

describe('SettingsPage initialSection', () => {
  afterEach(cleanup)

  beforeEach(() => {
    pluginApi.getPluginSettingsSchemas.mockResolvedValue({
      plugins: [{ pluginId: 'infinite-canvas', label: '无限画布', fields: [] }]
    })
    pluginApi.getPluginUiContributions.mockResolvedValue({ contributions: [] })
    pluginApi.getPlugin.mockResolvedValue({ config: {} })
    hostApi.getApi.mockResolvedValue({})
  })

  it('defaults to the general section when no initialSection is given', async () => {
    renderSettingsPage()

    const general = await screen.findByRole('button', { name: '通用设置' })
    expect(general.getAttribute('aria-current')).toBe('page')
    const canvas = await screen.findByRole('button', { name: '无限画布' })
    expect(canvas.getAttribute('aria-current')).toBeNull()
  })

  it('lands on the plugin media settings section for plugin:infinite-canvas', async () => {
    renderSettingsPage({ initialSection: 'plugin:infinite-canvas' })

    const canvas = await screen.findByRole('button', { name: '无限画布' })
    expect(canvas.getAttribute('aria-current')).toBe('page')
    // 右侧内容区渲染的是插件设置分区标题（SettingsPageHeader）
    expect(await screen.findByRole('heading', { name: '无限画布' })).toBeTruthy()
    const general = screen.getByRole('button', { name: '通用设置' })
    expect(general.getAttribute('aria-current')).toBeNull()
  })
})
