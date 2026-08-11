/**
 * ModelPicker：输入框旁模型选择器（per-call 模型切换）
 *
 * 形态：Provider → Model 两级下拉（数据源 GET /api/providers），
 * 供聊天/创作输入框旁"自由选择本次模型"。选中即"本次使用该模型"，
 * 未选择（默认）= 各 Agent 配置或项目主模型。
 *
 * 后续可扩展截图样式：显示消耗速度/思考强度/价格倍数。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Sparkles } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getApi } from '@/api/http-client'

interface ProviderBrief {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

export interface ModelRef {
  provider: string
  modelId: string
}

export interface ModelPickerProps {
  /** 当前选中（null = 默认） */
  value: ModelRef | null
  /** 变化回调 */
  onChange: (value: ModelRef | null) => void
  /** 可选：显示文字（如"本次创作使用"） */
  label?: string
}

export function ModelPicker({ value, onChange, label }: ModelPickerProps): ReactElement {
  const [providers, setProviders] = useState<ProviderBrief[]>([])
  const [providerId, setProviderId] = useState(value?.provider ?? '')
  const [modelId, setModelId] = useState(value?.modelId ?? '')

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

  // 外部 value 变化时同步（如重置为默认）
  useEffect(() => {
    setProviderId(value?.provider ?? '')
    setModelId(value?.modelId ?? '')
  }, [value?.provider, value?.modelId])

  const availableModels = providers.find((p) => p.id === providerId)?.models ?? []
  // 外部展示用：当前选中 provider 名称
  const currentProviderName = providers.find((p) => p.id === providerId)?.name

  const handleProviderChange = (v: string): void => {
    const next = v === '__default__' ? '' : v
    setProviderId(next)
    setModelId('')
    onChange(next && modelId ? { provider: next, modelId } : null)
  }

  const handleModelChange = (v: string): void => {
    const next = v === '__default__' ? '' : v
    setModelId(next)
    onChange(providerId && next ? { provider: providerId, modelId: next } : null)
  }

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Sparkles className="size-3.5 text-primary shrink-0" aria-hidden />
      {label && <span className="text-nano text-subtle whitespace-nowrap">{label}</span>}
      <Select value={providerId} onValueChange={handleProviderChange}>
        <SelectTrigger className="h-6 w-[88px] px-2 text-nano">
          <SelectValue placeholder={currentProviderName ?? 'Provider'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">默认</SelectItem>
          {providers.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={modelId} onValueChange={handleModelChange}>
        <SelectTrigger className="h-6 w-[110px] px-2 text-nano">
          <SelectValue placeholder="模型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">默认</SelectItem>
          {availableModels.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
