import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Plus, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AUTOSAVE_DEBOUNCE_MS,
  describeSaveState,
  type SaveState,
} from '../save-contract'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { type NovelNodeType } from '@/stores/novel-ui-store'
import {
  type CharacterHistoryField,
  type ChapterRhythm,
  type ChapterStatus,
  type ClimaxType,
  type ConflictPlotFunction,
  type ConflictProgressionMode,
  type ConflictStage,
  type ConflictTier,
  type ConflictType,
  type ForeshadowStatus,
  type NovelCharacterPlotRole,
  type NovelForeshadowCategory,
  type NovelFactionStatus,
  type NovelFactionStrength,
  type NovelFactionType,
  type NovelItemStatus,
  type NovelItemType,
  type NovelLocationSignificance,
  type NovelLocationStatus,
  type NovelLocationType,
  type NovelWorldElementCategory,
  type StoryStage,
  type TargetPlatform,
} from '@/api/novel-client'

// ── 字段组件 ──

export function FieldRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

export function TextInput(props: React.ComponentProps<typeof Input>): ReactElement {
  return <Input {...props} />
}

export type TextAreaVariant = 'short' | 'medium' | 'long'

export const TEXTAREA_VARIANT_CLASS: Record<TextAreaVariant, string> = {
  short: 'min-h-[60px]',
  medium: 'min-h-[100px]',
  long: 'min-h-[200px]',
}

export function TextArea({
  variant = 'short',
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { variant?: TextAreaVariant }): ReactElement {
  return (
    <textarea
      {...props}
      className={cn(
        'w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30',
        TEXTAREA_VARIANT_CLASS[variant],
        className,
      )}
    />
  )
}

// ── JSON 对象编辑器 ──
// 用于 personality / speechStyle 等"后端是 TEXT 但实际存 JSON 字符串"的字段。
// 兼容策略：空字符串 → 空对象；合法 JSON → 结构化展示；纯文本 → 纯文本 + 转结构化按钮。

export function tryParseJsonObject(s: string): Record<string, unknown> | null {
  const trimmed = s.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

export function JsonObjectEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}): ReactElement {
  const parsed = useMemo(() => tryParseJsonObject(value), [value])

  // 纯文本兜底：显示原文 + 「转为结构化」按钮（清空为空对象）
  if (parsed === null) {
    return (
      <div className="space-y-1.5">
        <TextArea variant="long" value={value} onChange={(e) => onChange(e.target.value)} />
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-micro text-muted-foreground"
          onClick={() => onChange('{}')}
        >
          转为结构化编辑
        </Button>
      </div>
    )
  }

  const entries = Object.entries(parsed)

  const updateEntry = (key: string, newVal: unknown) => {
    const next = { ...parsed, [key]: newVal }
    onChange(JSON.stringify(next, null, 2))
  }
  const removeEntry = (key: string) => {
    const next = { ...parsed }
    delete next[key]
    onChange(JSON.stringify(next, null, 2))
  }
  const addEntry = () => {
    let n = 1
    while (parsed[`字段${n}`] !== undefined) n++
    const key = `字段${n}`
    onChange(JSON.stringify({ ...parsed, [key]: '' }, null, 2))
  }
  const renameKey = (oldKey: string, newKey: string) => {
    const trimmed = newKey.trim()
    if (!trimmed || trimmed === oldKey) return
    if (parsed[trimmed] !== undefined) return // 不允许重复 key
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(parsed)) {
      next[k === oldKey ? trimmed : k] = v
    }
    onChange(JSON.stringify(next, null, 2))
  }

  return (
    <div className="space-y-2">
      {entries.length === 0 && (
        <p className="text-micro text-muted-foreground py-2 text-center">
          暂无内容，点击下方按钮添加字段
        </p>
      )}
      {entries.map(([key, val]) => (
        <JsonObjectEntry
          key={key}
          entryKey={key}
          value={val}
          onRenameKey={(nk) => renameKey(key, nk)}
          onChangeValue={(nv) => updateEntry(key, nv)}
          onRemove={() => removeEntry(key)}
        />
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 text-micro text-muted-foreground"
        onClick={addEntry}
      >
        <Plus className="size-3" /> 添加字段
      </Button>
    </div>
  )
}

export function JsonObjectEntry({
  entryKey,
  value,
  onRenameKey,
  onChangeValue,
  onRemove,
}: {
  entryKey: string
  value: unknown
  onRenameKey: (nk: string) => void
  onChangeValue: (nv: unknown) => void
  onRemove: () => void
}): ReactElement {
  const [keyInput, setKeyInput] = useState(entryKey)
  useEffect(() => {
    setKeyInput(entryKey)
  }, [entryKey])

  const handleKeyBlur = () => {
    const trimmed = keyInput.trim()
    if (trimmed && trimmed !== entryKey) {
      onRenameKey(trimmed)
    } else {
      setKeyInput(entryKey)
    }
  }

  // 按 value 类型选择控件
  let valueControl: ReactNode
  if (typeof value === 'string') {
    const isLong = value.length > 30 || value.includes('\n')
    valueControl = isLong ? (
      <TextArea variant="short" value={value} onChange={(e) => onChangeValue(e.target.value)} />
    ) : (
      <Input
        className="h-8"
        value={value}
        onChange={(e) => onChangeValue(e.target.value)}
      />
    )
  } else if (isStringArray(value)) {
    valueControl = <StringListEditor items={value} onChange={(items) => onChangeValue(items)} />
  } else if (typeof value === 'number') {
    valueControl = (
      <Input
        type="number"
        className="h-8"
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChangeValue(e.target.value === '' ? '' : Number(e.target.value))}
      />
    )
  } else if (typeof value === 'boolean') {
    valueControl = (
      <Select value={value ? 'true' : 'false'} onValueChange={(v) => onChangeValue(v === 'true')}>
        <SelectTrigger className="h-8 w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">是</SelectItem>
          <SelectItem value="false">否</SelectItem>
        </SelectContent>
      </Select>
    )
  } else {
    // 对象 / 其他数组：退化为 JSON 文本编辑
    valueControl = (
      <TextArea
        variant="medium"
        value={JSON.stringify(value, null, 2)}
        onChange={(e) => {
          try {
            onChangeValue(JSON.parse(e.target.value))
          } catch {
            // 解析失败时忽略，等用户改对再更新
          }
        }}
      />
    )
  }

  return (
    <div className="space-y-1 rounded-md border border-border bg-surface-2/40 p-2">
      <div className="flex items-center gap-1.5">
        <Input
          className="h-7 flex-1 text-xs font-medium"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          onBlur={handleKeyBlur}
        />
        <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label="删除字段">
          <Trash2 className="size-3" />
        </Button>
      </div>
      {valueControl}
    </div>
  )
}

export function StringListEditor({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}): ReactElement {
  const updateItem = (i: number, val: string) => {
    onChange(items.map((x, idx) => (idx === i ? val : x)))
  }
  const removeItem = (i: number) => {
    onChange(items.filter((_, idx) => idx !== i))
  }
  const addItem = () => {
    onChange([...items, ''])
  }

  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-1">
          <span className="text-nano text-muted-foreground pt-1.5 w-4 shrink-0 tabular-nums text-right">
            {i + 1}.
          </span>
          <TextArea
            variant="short"
            className="min-h-[40px] text-xs"
            value={item}
            onChange={(e) => updateItem(i, e.target.value)}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            className="mt-0.5 shrink-0"
            onClick={() => removeItem(i)}
            aria-label="删除项"
          >
            <X className="size-3" />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 text-micro text-muted-foreground"
        onClick={addItem}
      >
        <Plus className="size-3" /> 添加项
      </Button>
    </div>
  )
}

// ── 工具：容错解析 JSON: string[]（旧数据/非法 JSON 返回空数组）──

export function safeParseParticipants(raw: string): string[] {
  try {
    const p = JSON.parse(raw)
    if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }
  return []
}

// ── 分组标题（iOS Settings 风格） ──

export function SectionHeader({ title, hint }: { title: string; hint?: string }): ReactElement {
  return (
    <div className="pt-4 pb-1.5 first:pt-0">
      <div className="text-micro font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {hint && <div className="text-nano text-muted-foreground/70 mt-0.5">{hint}</div>}
    </div>
  )
}

// ── 防抖大纲字段（1.5s 防抖 + onBlur 保存，复用 D-2 的防抖保存逻辑） ──
// 用于全书大纲 / 卷纲 / 章纲：从左边栏点击后在右边栏编辑，自动持久化。

export interface DebouncedOutlineFieldProps {
  label: string
  value: string
  placeholder?: string
  onSave: (value: string) => Promise<void>
}

export function DebouncedOutlineField({
  label,
  value,
  placeholder,
  onSave,
}: DebouncedOutlineFieldProps): ReactElement {
  const [draft, setDraft] = useState(value)
  /**
   * 保存状态。
   *
   * 原实现完全没有反馈：失败只 `console.error`，用户以为存上了。
   * 这是四种保存契约里最危险的一处 —— 自动保存 + 静默失败 = 用户没有任何
   * 察觉丢失的机会。现在按 autosave 契约给出可见状态。
   */
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSavingRef = useRef(false)
  // 用 ref 存最新的 value 和 onSave，避免闭包陷阱
  const valueRef = useRef(value)
  const onSaveRef = useRef(onSave)
  valueRef.current = value
  onSaveRef.current = onSave

  // value 变化时同步 draft，但保存期间不覆盖
  useEffect(() => {
    if (!isSavingRef.current) setDraft(value)
  }, [value])

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  // doSave 直接从 ref 读取，不依赖闭包变量，无需 useCallback
  const doSave = async (text: string) => {
    if (text.trim() === valueRef.current.trim()) {
      setSaveState('saved')
      return
    }
    isSavingRef.current = true
    setSaveState('saving')
    setErrorMessage(null)
    try {
      await onSaveRef.current(text)
      setSaveState('saved')
    } catch (err) {
      // 不再只写 console：失败必须让用户看见，否则等于静默丢数据
      setSaveState('error')
      setErrorMessage(err instanceof Error ? err.message : '保存失败')
    } finally {
      isSavingRef.current = false
    }
  }

  const scheduleSave = (text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void doSave(text)
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  const status = describeSaveState('autosave', saveState, errorMessage ?? undefined)

  return (
    <FieldRow label={label}>
      <TextArea
        variant="long"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value)
          setSaveState('dirty')
          scheduleSave(e.target.value)
        }}
        onBlur={() => {
          if (timerRef.current) clearTimeout(timerRef.current)
          void doSave(draft)
        }}
      />
      {/* 已保存时不占视觉空间：稳态无需反复告知 */}
      {saveState !== 'saved' && (
        <div
          className={
            status.tone === 'danger'
              ? 'mt-1 text-nano text-destructive'
              : 'mt-1 text-nano text-muted-foreground'
          }
        >
          {status.label}
          {status.hint && <span className="text-muted-foreground/70">（{status.hint}）</span>}
        </div>
      )}
    </FieldRow>
  )
}

// ── 选项常量 ──

export const STAGE_OPTIONS: { value: StoryStage; label: string }[] = [
  { value: 'setup', label: '铺垫' },
  { value: 'rising', label: '上升' },
  { value: 'climax', label: '高潮' },
  { value: 'falling', label: '回落' },
  { value: 'resolution', label: '结局' },
]

export const PROJECT_STATUS_OPTIONS = [
  { value: 'active', label: '进行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
]

export const TARGET_PLATFORM_OPTIONS: { value: TargetPlatform | '__none__'; label: string; hint: string }[] = [
  { value: '__none__', label: '未设定', hint: '不调整评分权重' },
  { value: 'fanqie', label: '番茄', hint: '重节奏和爽感' },
  { value: 'qidian', label: '起点', hint: '重世界观和伏笔' },
  { value: 'zhihu_yanyan', label: '知乎盐言', hint: '重开篇和反转' },
  { value: 'general', label: '通用', hint: '不调整评分权重' },
]

export const CHAPTER_STATUS_OPTIONS: { value: ChapterStatus; label: string }[] = [
  { value: 'planned', label: '已规划' },
  { value: 'drafting', label: '草稿中' },
  { value: 'review', label: '审核中' },
  { value: 'published', label: '已发布' },
  { value: 'rejected', label: '已驳回' },
]

export const CONFLICT_TYPE_OPTIONS: { value: ConflictType; label: string }[] = [
  { value: 'inner', label: '内心' },
  { value: 'relationship', label: '关系' },
  { value: 'faction', label: '阵营' },
  { value: 'interest', label: '利益' },
  { value: 'moral', label: '道德' },
  { value: 'identity', label: '身份' },
  { value: 'emotional', label: '情感' },
  { value: 'world_rule', label: '世界规则' },
  { value: 'survival', label: '生存' },
]

export const CONFLICT_STAGE_OPTIONS: { value: ConflictStage; label: string }[] = [
  { value: 'latent', label: '潜伏' },
  { value: 'emerging', label: '浮现' },
  { value: 'escalating', label: '升级' },
  { value: 'erupting', label: '爆发' },
  { value: 'reversing', label: '逆转' },
  { value: 'resolved', label: '已解决' },
  { value: 'transformed', label: '转化' },
]

export const CONFLICT_TIER_OPTIONS: { value: ConflictTier; label: string }[] = [
  { value: 'main', label: '主线' },
  { value: 'secondary', label: '支线' },
  { value: 'goal', label: '目标' },
]

export const CLIMAX_TYPE_OPTIONS: { value: ClimaxType; label: string }[] = [
  { value: 'emotional', label: '情感高潮' },
  { value: 'fate', label: '命运高潮' },
  { value: 'character', label: '性格高潮' },
  { value: 'combat', label: '打斗高潮' },
  { value: 'theme', label: '主题高潮' },
  { value: 'composite', label: '复合高潮' },
]

// ── P2-1：冲突功能位（7 值枚举）+ 非线性推进模式（5 值枚举）──
export const CONFLICT_PLOT_FUNCTION_OPTIONS: { value: ConflictPlotFunction; label: string }[] = [
  { value: 'provide_resource', label: '提供资源' },
  { value: 'create_obstacle', label: '制造障碍' },
  { value: 'amplify_conflict', label: '激化冲突' },
  { value: 'open_phase', label: '开启阶段' },
  { value: 'change_judgment', label: '改变判断' },
  { value: 'advance_relationship', label: '推进关系' },
  { value: 'reveal_world_rule', label: '揭示世界规则' },
]

export const CONFLICT_PROGRESSION_MODE_OPTIONS: { value: ConflictProgressionMode; label: string }[] = [
  { value: 'linear', label: '线性升级' },
  { value: 'mutation', label: '突变' },
  { value: 'stagnation', label: '停滞' },
  { value: 'regression', label: '降级' },
  { value: 'reversal', label: '反转' },
]

// ── 三层模型：角色层级（5 值枚举）──
export const CHARACTER_PLOT_ROLE_OPTIONS: { value: NovelCharacterPlotRole; label: string }[] = [
  { value: 'protagonist', label: '主角' },
  { value: 'main_opponent', label: '主对手' },
  { value: 'supporting', label: '配角' },
  { value: 'function', label: '功能性' },
  { value: 'background', label: '背景' },
]

export const CHAPTER_RHYTHM_OPTIONS: { value: ChapterRhythm; label: string }[] = [
  { value: 'setup', label: '铺垫' },
  { value: 'rising', label: '上升' },
  { value: 'climax', label: '高潮' },
  { value: 'falling', label: '下降' },
  { value: 'resolution', label: '收束' },
  { value: 'twist', label: '转折' },
  { value: 'breather', label: '舒缓' },
  { value: 'suspense', label: '悬念' },
]

export const FORESHADOW_STATUS_OPTIONS: { value: ForeshadowStatus; label: string }[] = [
  { value: 'planned', label: '已规划' },
  { value: 'planted', label: '已埋设' },
  { value: 'reinforced', label: '已强化' },
  { value: 'partially_revealed', label: '部分揭示' },
  { value: 'recovering', label: '回收中' },
  { value: 'recovered', label: '已回收' },
  { value: 'abandoned', label: '已废弃' },
]

// ── P2-2：伏笔分类枚举（与后端 NovelForeshadowCategory 对齐）──
export const FORESHADOW_CATEGORY_OPTIONS: { value: NovelForeshadowCategory; label: string }[] = [
  { value: 'item', label: '物品' },
  { value: 'spoken', label: '言语' },
  { value: 'event', label: '事件' },
  { value: 'identity', label: '身份' },
  { value: 'secret', label: '秘密' },
  { value: 'prophecy', label: '预言' },
  { value: 'promise', label: '承诺' },
  { value: 'quote', label: '台词' },
]

export const FACTION_TYPE_OPTIONS: { value: NovelFactionType; label: string }[] = [
  { value: 'organization', label: '组织' },
  { value: 'sect', label: '门派' },
  { value: 'kingdom', label: '王国' },
  { value: 'family', label: '家族' },
  { value: 'guild', label: '公会' },
  { value: 'cult', label: '邪教' },
]

export const FACTION_STRENGTH_OPTIONS: { value: NovelFactionStrength; label: string }[] = [
  { value: 'weak', label: '弱小' },
  { value: 'medium', label: '中等' },
  { value: 'strong', label: '强盛' },
  { value: 'overwhelming', label: '压倒性' },
]

export const FACTION_STATUS_OPTIONS: { value: NovelFactionStatus; label: string }[] = [
  { value: 'active', label: '活跃' },
  { value: 'declined', label: '衰落' },
  { value: 'destroyed', label: '覆灭' },
  { value: 'hidden', label: '隐秘' },
]

export const LOCATION_TYPE_OPTIONS: { value: NovelLocationType; label: string }[] = [
  { value: 'continent', label: '大陆' },
  { value: 'country', label: '国家' },
  { value: 'city', label: '城市' },
  { value: 'building', label: '建筑' },
  { value: 'dungeon', label: '地下城' },
  { value: 'region', label: '区域' },
  { value: 'wilderness', label: '荒野' },
]

export const LOCATION_SIGNIFICANCE_OPTIONS: { value: NovelLocationSignificance; label: string }[] = [
  { value: 'minor', label: '次要' },
  { value: 'moderate', label: '中等' },
  { value: 'major', label: '重要' },
  { value: 'critical', label: '关键' },
]

export const LOCATION_STATUS_OPTIONS: { value: NovelLocationStatus; label: string }[] = [
  { value: 'normal', label: '正常' },
  { value: 'destroyed', label: '毁灭' },
  { value: 'changed', label: '变迁' },
  { value: 'hidden', label: '隐秘' },
]

export const WORLD_ELEMENT_CATEGORY_OPTIONS: { value: NovelWorldElementCategory; label: string }[] = [
  { value: 'power_system', label: '力量体系' },
  { value: 'history', label: '历史' },
  { value: 'culture', label: '文化' },
  { value: 'religion', label: '宗教' },
  { value: 'technology', label: '科技' },
  { value: 'economy', label: '经济' },
  { value: 'geography', label: '地理' },
]

export const ITEM_TYPE_OPTIONS: { value: NovelItemType; label: string }[] = [
  { value: 'weapon', label: '武器' },
  { value: 'armor', label: '防具' },
  { value: 'artifact', label: '法器/神器' },
  { value: 'consumable', label: '消耗品' },
  { value: 'key', label: '关键道具' },
  { value: 'material', label: '材料' },
  { value: 'info', label: '信息载体' },
  { value: 'misc', label: '其他' },
]

export const ITEM_STATUS_OPTIONS: { value: NovelItemStatus; label: string }[] = [
  { value: 'active', label: '持有' },
  { value: 'lost', label: '丢失' },
  { value: 'destroyed', label: '损毁' },
  { value: 'transformed', label: '升级/变化' },
  { value: 'sealed', label: '封印' },
  { value: 'transferred', label: '转手' },
]

// 节点类型中文标签
export const NODE_TYPE_LABELS: Record<NovelNodeType, string> = {
  project: '项目',
  character: '角色',
  chapter: '章节',
  volume: '卷',
  conflict: '冲突',
  clue: '线索',
  foreshadow: '伏笔',
  faction: '势力',
  location: '地点',
  world_element: '世界要素',
  info_layer: '信息差',
  item: '物品',
  group: '分组',
}

// 动态状态字段（用于变更历史记录）
export const DYNAMIC_FIELDS: CharacterHistoryField[] = [
  'currentState',
  'currentGoal',
  'currentPressure',
  'secret',
  'arcStage',
]

export const HISTORY_FIELD_LABELS: Record<CharacterHistoryField, string> = {
  currentState: '当前状态',
  currentGoal: '当前目标',
  currentPressure: '当前压力',
  secret: '秘密',
  arcStage: '弧光阶段',
}

// 简单的相对时间格式化
export function relativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  const year = Math.floor(month / 12)
  return `${year} 年前`
}

export function entityTitle(entity: unknown, type: string): string {
  const e = entity as Record<string, unknown>
  if (type === 'project') return String(e.title ?? '')
  if (type === 'chapter') return String(e.title ?? `第 ${e.chapterNumber} 章`)
  if (type === 'volume') return String(e.title ?? `第 ${e.volumeNumber} 卷`)
  if (type === 'character') return String(e.name ?? '')
  if (type === 'faction' || type === 'location' || type === 'world_element' || type === 'item') {
    return String(e.name ?? '')
  }
  if (type === 'conflict' || type === 'clue' || type === 'foreshadow' || type === 'info_layer') {
    const d = String(e.description ?? e.infoDescription ?? '')
    return d.length > 20 ? `${d.slice(0, 20)}...` : d
  }
  return ''
}

// ── 保存按钮 ──

export function SaveButton({
  onSave,
  disabled,
  saving,
}: {
  onSave: () => void
  disabled: boolean
  saving: boolean
}): ReactElement {
  // explicit 契约：dirty 时必须说清"不点就会丢"，否则用户以为像正文一样自动存。
  // 这是四种保存契约里最容易误解的一处 —— 同屏的正文和大纲都自动保存。
  const dirty = !disabled && !saving
  const status = describeSaveState('explicit', dirty ? 'dirty' : saving ? 'saving' : 'saved')
  return (
    <div className="pt-2 space-y-1">
      <Button onClick={onSave} disabled={disabled || saving} className="w-full">
        <Save className="size-3.5" />
        {saving ? '保存中...' : '保存修改'}
      </Button>
      {dirty && status.hint && (
        <p className="text-nano text-amber-600 dark:text-amber-400">{status.hint}</p>
      )}
    </div>
  )
}
