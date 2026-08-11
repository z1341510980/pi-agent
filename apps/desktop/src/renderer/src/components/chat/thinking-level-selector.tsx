import { useMemo, type ReactElement } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { BrainIcon } from 'lucide-react'
import {
  THINKING_LEVEL_LABELS,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './model-selector'

/**
 * ThinkingLevelSelector：模型思考强度选择器
 *
 * 显示条件：当前选中模型具有 ≥ 2 个可选项（考虑 supportedReasoningEfforts + allowDisableThinking）
 * - allowDisableThinking=true → 选项含 'off'
 * - supportedReasoningEfforts → 选项含各档位（low/medium/high/xhigh）
 * - 实际选项 = supportedReasoningEfforts ∪ (allowDisableThinking ? {'off'} : ∅)
 *
 * 业务约束：
 * - 'minimal' 档位：仅当 supportedReasoningEfforts 显式包含时才显示（不默认开启）
 * - 'auto' 表示透传请求层默认值（仅 ProviderConfigStore.defaultReasoningEffort='auto' 时显示，
 *   本选择器不直接提供 'auto' 选项，因为它是"未显式设置"的语义）
 */
export interface ThinkingLevelSelectorProps {
  /** 当前选中值；null 表示未显式设置（按模型默认） */
  value: ThinkingLevel | null
  /** 当前模型支持的强度档位 */
  supportedReasoningEfforts?: ThinkingLevel[]
  /** 是否允许"关闭思考"（即 'off' 可选） */
  allowDisableThinking?: boolean
  /** 默认思考强度（缺省 fallback） */
  defaultReasoningEffort?: ThinkingLevel | 'auto'
  /** 模型是否支持思考（reasoning）。supportedReasoningEfforts 为空但 reasoning=true 时
   *  给默认档位（低/中/高），避免"支持思考但选择器不出现"的割裂体验 */
  reasoning?: boolean
  onChange: (next: ThinkingLevel | null) => void
  disabled?: boolean
}

const DEFAULT_REASONING_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high']

const TRIGGER_CLASS =
  'min-w-[110px] h-7 rounded-md border-0 bg-surface-4 text-xs! text-subtle hover:bg-surface-3 focus:ring-0 focus:ring-offset-0 px-2'

export function ThinkingLevelSelector({
  value,
  supportedReasoningEfforts,
  allowDisableThinking,
  defaultReasoningEffort,
  reasoning = false,
  onChange,
  disabled = false,
}: ThinkingLevelSelectorProps): ReactElement | null {
  // 构造可选档位集合
  const availableLevels = useMemo<ThinkingLevel[]>(() => {
    // 已显式配置档位 → 用它；否则若模型支持思考 → 默认低/中/高
    const base =
      supportedReasoningEfforts && supportedReasoningEfforts.length > 0
        ? supportedReasoningEfforts
        : reasoning
          ? DEFAULT_REASONING_LEVELS
          : []
    const supported = new Set<ThinkingLevel>(base)
    if (allowDisableThinking) supported.add('off')
    if (supported.size === 0) return []
    // 按 THINKING_LEVELS 顺序输出（off/minimal/low/medium/high/xhigh）
    return THINKING_LEVELS.filter((l) => supported.has(l))
  }, [supportedReasoningEfforts, allowDisableThinking, reasoning])

  // 可选项 < 2 时不显示（避免出现"只有一个选项但又显示一个切换器"的尴尬 UI）
  if (availableLevels.length < 2) return null

  // 计算当前显示文本：value ?? fallback defaultReasoningEffort ?? 'auto'
  const displayValue = value ?? (defaultReasoningEffort === 'auto' || !defaultReasoningEffort ? null : defaultReasoningEffort)
  const currentLabel = displayValue ? THINKING_LEVEL_LABELS[displayValue] : '自动'

  return (
    <Select
      value={displayValue ?? '__auto__'}
      onValueChange={(v) => {
        if (v === '__auto__') onChange(null)
        else onChange(v as ThinkingLevel)
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className={TRIGGER_CLASS} aria-label="思考强度">
        <span className="flex items-center gap-1.5 truncate">
          <BrainIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{currentLabel}</span>
        </span>
      </SelectTrigger>
      <SelectContent>
        {/* 'auto' 选项（清除显式设置）—— 始终显示 */}
        <SelectItem value="__auto__">自动</SelectItem>
        {availableLevels.map((level) => (
          <SelectItem key={level} value={level}>
            {THINKING_LEVEL_LABELS[level]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}