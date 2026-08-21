/**
 * Slot context 的最小承载模块。
 *
 * 刻意只依赖 react 与类型：`SlotRenderer` 被聊天气泡、工具卡这类深层组件使用，
 * 如果它们经 `core` barrel 间接拉进 API client 和全部 trusted renderer，
 * 整个渲染树的导入成本都会被抬高（实测让无关单测超时）。
 * Provider 在 slot-context.tsx 中组装，那里才需要网络与组件依赖。
 */
import { createContext, useContext } from 'react'
import type { PluginUiRegistry } from '../ui/plugin-ui-registry'

export const SlotContext = createContext<PluginUiRegistry | null>(null)

export function useSlotRegistry(): PluginUiRegistry {
  const registry = useContext(SlotContext)
  if (!registry) throw new Error('useSlotRegistry must be used within SlotProvider')
  return registry
}

/**
 * 可选版本：没有 SlotProvider 时返回 null 而不是抛错。
 *
 * 渲染点分散在聊天气泡、工具卡、右栏这些深层组件里。让它们硬依赖 Provider
 * 会把"是否接了 slot"变成所有上游使用方（含单测和局部挂载）的负担。
 * 宿主 UI 在没有 registry 时应照常工作，只是不渲染任何插件贡献。
 */
export function useOptionalSlotRegistry(): PluginUiRegistry | null {
  return useContext(SlotContext)
}
