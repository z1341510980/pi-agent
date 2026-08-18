/**
 * ModelPicker：输入框旁模型选择器（per-call 模型切换）
 *
 * 形态：单层模型清单（数据源 GET /api/providers），
 * 供聊天/创作输入框旁"自由选择本次模型"。选中即"本次使用该模型"，
 * 未选择（默认）= 各 Agent 配置或项目主模型。
 *
 * 模型信息卡显示上下文、输出上限和价格等元数据；卡片内可调思考强度。
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Brain, Check, ChevronRight, CircleHelp, Sparkles } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getApi } from '@/api/http-client'
import {
  THINKING_LEVEL_LABELS,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@/components/chat/model-selector'
import type { NovelAgentModelRef } from '@/stores/novel-ui-store'

interface ProviderBrief {
  id: string
  name: string
  models: Array<{
    id: string
    name: string
    reasoning?: boolean
    supportedReasoningEfforts?: ThinkingLevel[]
    allowDisableThinking?: boolean
    defaultReasoningEffort?: ThinkingLevel | 'auto'
    contextWindow?: number
    maxTokens?: number
    cost?: { input: number; output: number }
  }>
}

interface ModelOption {
  provider: string
  providerName: string
  id: string
  name: string
  reasoning?: boolean
  supportedReasoningEfforts?: ThinkingLevel[]
  allowDisableThinking?: boolean
  defaultReasoningEffort?: ThinkingLevel | 'auto'
  contextWindow?: number
  maxTokens?: number
  cost?: { input: number; output: number }
}

function modelThinkingLevels(model: ModelOption): ThinkingLevel[] {
  const base = model.supportedReasoningEfforts?.length
    ? model.supportedReasoningEfforts
    : model.reasoning
      ? ['low', 'medium', 'high'] as ThinkingLevel[]
      : []
  const supported = new Set(base)
  if (model.allowDisableThinking) supported.add('off')
  return THINKING_LEVELS.filter((level) => supported.has(level))
}

export type ModelRef = NovelAgentModelRef

export interface ModelPickerProps {
  /** 当前选中（null = 默认） */
  value: ModelRef | null
  /** 变化回调 */
  onChange: (value: ModelRef | null) => void
  /** 可选：显示文字（如"本次创作使用"） */
  label?: string
  /** 紧凑模式：顶栏 Tab 旁使用，隐藏图标与标签、收窄按钮 */
  compact?: boolean
}

export function ModelPicker({ value, onChange, label, compact = false }: ModelPickerProps): ReactElement {
  const [providers, setProviders] = useState<ProviderBrief[]>([])
  const [open, setOpen] = useState(false)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [thinkingOpenKey, setThinkingOpenKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getApi<ProviderBrief[]>('/api/providers')
      .then((list) => {
        if (!cancelled) setProviders(list)
      })
      .catch(() => {
        /* 加载失败不阻塞 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const models = useMemo<ModelOption[]>(
    () => providers.flatMap((provider) => provider.models.map((model) => ({
      ...model,
      provider: provider.id,
      providerName: provider.name,
      name: model.name || model.id,
    }))),
    [providers],
  )

  const selectedModel = models.find((model) => model.provider === value?.provider && model.id === value?.modelId)
  const previewModel = models.find((model) => `${model.provider}:${model.id}` === hoveredKey) ?? selectedModel ?? models[0]
  function chooseModel(model: ModelOption): void {
    onChange({ provider: model.provider, modelId: model.id, thinkingLevel: null })
    setThinkingOpenKey(null)
    setOpen(false)
  }

  function chooseThinkingLevel(model: ModelOption, level: ThinkingLevel | null): void {
    onChange({ provider: model.provider, modelId: model.id, thinkingLevel: level })
    setThinkingOpenKey(null)
    setOpen(false)
  }

  function modelSummary(model: ModelOption): string {
    if (model.contextWindow) return `上下文 ${Math.round(model.contextWindow / 1000)}k tokens`
    if (model.maxTokens) return `最大输出 ${model.maxTokens.toLocaleString()} tokens`
    return '已配置模型'
  }

  return (
    <div className="flex items-center gap-1.5 text-xs">
      {!compact && <Sparkles className="size-3.5 text-primary shrink-0" aria-hidden />}
      {!compact && label && <span className="text-nano text-subtle whitespace-nowrap">{label}</span>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-left text-nano text-text transition-[background-color,border-color,transform] hover:border-primary/50 hover:bg-surface-3 active:scale-[0.96]',
              compact ? 'min-w-[140px] max-w-[200px]' : 'min-w-[180px] max-w-[260px]',
            )}
            aria-label="选择模型"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{selectedModel?.name ?? '默认模型'}</span>
            {value?.thinkingLevel ? <span className="shrink-0 text-[10px] text-primary">{THINKING_LEVEL_LABELS[value.thinkingLevel]}</span> : null}
            <ChevronRight className="size-3 shrink-0 rotate-90 text-muted-foreground" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side={compact ? 'bottom' : 'top'}
          collisionPadding={12}
          className="w-[min(680px,calc(100vw-1rem))] max-h-[calc(100vh-2rem)] !overflow-hidden p-2"
        >
          <div className="mb-1 flex items-center justify-between px-2 py-1">
            <div className="text-xs font-semibold text-text">全部模型</div>
            <div className="text-[10px] text-muted-foreground">右侧查看模型简介</div>
          </div>
          <div className="grid min-h-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_250px]">
            <div className="min-w-0">
              <button
                type="button"
                className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-surface-2"
                onClick={() => { onChange(null); setThinkingOpenKey(null); setOpen(false) }}
              >
                <span className="flex size-6 items-center justify-center rounded-full bg-surface-3 text-muted-foreground"><CircleHelp className="size-3.5" /></span>
                <span className="min-w-0 flex-1"><span className="block font-medium text-text">默认模型</span><span className="block text-[10px] text-muted-foreground">使用项目或 Agent 默认配置</span></span>
                {!selectedModel && <Check className="size-3.5 text-primary" />}
              </button>
              <div className="max-h-[min(20rem,calc(100vh-13rem))] space-y-0.5 overflow-y-auto pr-1">
                {models.map((model) => {
                  const key = `${model.provider}:${model.id}`
                  const selected = selectedModel?.provider === model.provider && selectedModel.id === model.id
                  return (
                    <div key={key} onMouseEnter={() => setHoveredKey(key)}>
                      <button
                        type="button"
                        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors', selected ? 'bg-primary/10' : 'hover:bg-surface-2')}
                        onFocus={() => setHoveredKey(key)}
                        onClick={() => chooseModel(model)}
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] text-primary">{model.providerName.slice(0, 1)}</span>
                        <span className="min-w-0 flex-1"><span className="block truncate font-medium text-text">{model.name}</span><span className="block truncate text-[10px] text-muted-foreground">{model.providerName} · {modelSummary(model)}</span></span>
                        {model.reasoning ? <Brain className="size-3.5 shrink-0 text-primary" aria-label="支持思考" /> : null}
                        {selected && <Check className="size-3.5 shrink-0 text-primary" />}
                      </button>
                    </div>
                  )
                })}
                {models.length === 0 && <div className="p-4 text-center text-xs text-muted-foreground">暂无已配置模型</div>}
              </div>
            </div>

            <div className="min-h-40 min-w-0 rounded-lg border border-border bg-surface-2/60 p-3" onMouseEnter={() => previewModel && setHoveredKey(`${previewModel.provider}:${previewModel.id}`)}>
              {previewModel ? (
                (() => {
                  const key = `${previewModel.provider}:${previewModel.id}`
                  const levels = modelThinkingLevels(previewModel)
                  const selected = selectedModel?.provider === previewModel.provider && selectedModel.id === previewModel.id
                  return (
                    <div className="flex h-full min-h-40 flex-col">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-text">{previewModel.name}</div>
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{previewModel.providerName}</div>
                        </div>
                        {previewModel.reasoning ? <Brain className="size-4 shrink-0 text-primary" /> : null}
                      </div>
                      <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
                        {modelSummary(previewModel)}。{previewModel.cost ? `输入 ${previewModel.cost.input} · 输出 ${previewModel.cost.output}` : '可用于当前会话。'}
                      </p>
                      {levels.length > 0 && (
                        <div className="relative mt-auto pt-3">
                          <button type="button" className="flex w-full items-center justify-between rounded-md border border-border bg-background/50 px-2 py-1.5 text-left text-[11px] hover:bg-surface-2" onClick={() => setThinkingOpenKey((current) => current === key ? null : key)}>
                            <span className="flex items-center gap-1.5"><Brain className="size-3.5 text-primary" /> 思考强度</span><span className="text-muted-foreground">{selected && value?.thinkingLevel ? THINKING_LEVEL_LABELS[value.thinkingLevel] : '自动'} <ChevronRight className="inline size-3" /></span>
                          </button>
                          {thinkingOpenKey === key && (
                            <div className="absolute right-0 bottom-full z-20 mb-1 w-36 rounded-md border border-border bg-popover p-1 shadow-lg">
                              <button type="button" className="flex w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-surface-2" onClick={() => chooseThinkingLevel(previewModel, null)}>自动</button>
                              {levels.map((level) => <button key={level} type="button" className="flex w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-surface-2" onClick={() => chooseThinkingLevel(previewModel, level)}>{THINKING_LEVEL_LABELS[level]}</button>)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })()
              ) : (
                <div className="flex h-full min-h-40 items-center justify-center text-center text-xs text-muted-foreground">
                  选择模型后查看简介
                </div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
