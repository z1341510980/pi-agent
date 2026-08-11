import { useMemo, type ReactElement } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Pi-ai SDK 原生思考强度档位（与 ThinkingLevel 对齐） */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
}

export interface ModelOption {
  provider: string
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** 模型是否支持思考（reasoning）。无则按 false 处理 */
  reasoning?: boolean
  /** 模型支持的思考强度档位（来自 ProviderConfigStore supportedReasoningEfforts，
   *  或由后端从 SDK thinkingLevelMap 反推）。仅在 reasoning=true 时相关 */
  supportedReasoningEfforts?: ThinkingLevel[]
  /** 是否允许"关闭思考"档位（allowDisableThinking） */
  allowDisableThinking?: boolean
  /** 默认思考强度（'auto' 表示透传 SDK 全局默认） */
  defaultReasoningEffort?: ThinkingLevel | 'auto'
}

export interface ModelSelectorProps {
  models: ModelOption[]
  /** 当前选中值，格式 `${provider}:${id}`；null 表示未选中 */
  value: string | null
  onChange: (provider: string, modelId: string) => void
  disabled?: boolean
}

const EMPTY_PLACEHOLDER = '未配置模型'
const SELECT_PLACEHOLDER = '选择模型'

function makeKey(provider: string, id: string): string {
  return `${provider}:${id}`
}

function parseKey(key: string): { provider: string; modelId: string } {
  const idx = key.indexOf(':')
  if (idx === -1) {
    return { provider: key, modelId: '' }
  }
  return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) }
}

/**
 * ModelSelector：模型选择器（Craft 风格）
 *
 * - 圆角无边框，背景 #F1F5F9
 * - 左侧紫色小圆点 + 模型名称
 * - 按 Provider 分组展示
 */
export function ModelSelector({
  models,
  value,
  onChange,
  disabled = false,
}: ModelSelectorProps): ReactElement {
  const grouped = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of models) {
      const list = map.get(m.provider) ?? []
      list.push(m)
      map.set(m.provider, list)
    }
    return Array.from(map.entries())
  }, [models])

  const selectedModel = useMemo(() => {
    if (!value) return null
    return models.find((m) => makeKey(m.provider, m.id) === value) ?? null
  }, [models, value])

  const isEmpty = models.length === 0
  const placeholder = isEmpty ? EMPTY_PLACEHOLDER : SELECT_PLACEHOLDER

  return (
    <Select
      value={value ?? undefined}
      onValueChange={(key) => {
        const { provider, modelId } = parseKey(key)
        onChange(provider, modelId)
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        data-tour="model-selector"
        className="min-w-[120px] max-w-[200px] h-7 rounded-md border-0 bg-surface-4 text-xs! text-subtle hover:bg-surface-3 focus:ring-0 focus:ring-offset-0"
      >
        <SelectValue placeholder={placeholder}>
          {selectedModel ? (
            <span className="flex items-center gap-1.5 truncate">
              <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span className="truncate">{selectedModel.name ?? selectedModel.id}</span>
            </span>
          ) : (
            <span className="text-muted-foreground truncate">{placeholder}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {isEmpty ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            请先在设置中配置 Provider
          </div>
        ) : (
          grouped.map(([provider, items]) => (
            <SelectGroup key={provider}>
              <SelectLabel>{provider}</SelectLabel>
              {items.map((m) => (
                <SelectItem key={makeKey(m.provider, m.id)} value={makeKey(m.provider, m.id)}>
                  {m.name ?? m.id}
                </SelectItem>
              ))}
            </SelectGroup>
          ))
        )}
      </SelectContent>
    </Select>
  )
}
