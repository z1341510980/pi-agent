import type { PluginSessionOptions } from '../../../../core/plugin/plugin-types.js'

export interface NovelModelRef {
  provider: string
  modelId: string
}

/** 与 PluginContext.createSession 使用同一模型选项类型，保留 thinkingLevel。 */
export type NovelModelSelection = NonNullable<PluginSessionOptions['modelId']>

/** 解析项目持久化的 `provider:modelId`；非法或空值视为未配置。 */
export function parseNovelModelRef(value: string | null | undefined): NovelModelRef | undefined {
  if (!value) return undefined
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return undefined
  const provider = value.slice(0, separator).trim()
  const modelId = value.slice(separator + 1).trim()
  return provider && modelId ? { provider, modelId } : undefined
}
