import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, X, Info, History, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore, type NovelNodeType } from '@/stores/novel-ui-store'
import { toastSuccess, toastError } from '@/hooks/use-toast'
import {
  updateProject,
  updateCharacter,
  updateChapter,
  updateConflict,
  updateForeshadow,
  updateFaction,
  updateLocation,
  updateWorldElement,
  updateVolume,
  updateInfoLayer,
  listCharacterHistory,
  createCharacterHistory,
  listRhythmModels,
  type RhythmModel,
  type NovelProject,
  type NovelCharacter,
  type NovelCharacterPlotRole,
  type NovelChapter,
  type NovelConflict,
  type NovelForeshadow,
  type NovelCharacterHistory,
  type CharacterHistoryField,
  type StoryStage,
  type TargetPlatform,
  type ChapterStatus,
  type ConflictType,
  type ConflictStage,
  type ConflictTier,
  type ConflictPlotFunction,
  type ConflictProgressionMode,
  type ClimaxType,
  type ChapterRhythm,
  type ForeshadowStatus,
  type NovelForeshadowCategory,
  type NovelFaction,
  type NovelLocation,
  type NovelWorldElement,
  type NovelFactionType,
  type NovelFactionStrength,
  type NovelFactionStatus,
  type NovelLocationType,
  type NovelLocationSignificance,
  type NovelLocationStatus,
  type NovelWorldElementCategory,
  type NovelVolume,
  type NovelInformationLayer,
} from '@/api/novel-client'

// ── 字段组件 ──

function FieldRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function TextInput(props: React.ComponentProps<typeof Input>): ReactElement {
  return <Input {...props} />
}

type TextAreaVariant = 'short' | 'medium' | 'long'

const TEXTAREA_VARIANT_CLASS: Record<TextAreaVariant, string> = {
  short: 'min-h-[60px]',
  medium: 'min-h-[100px]',
  long: 'min-h-[200px]',
}

function TextArea({
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

function tryParseJsonObject(s: string): Record<string, unknown> | null {
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function JsonObjectEditor({
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
          className="h-6 text-[11px] text-muted-foreground"
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
        <p className="text-[11px] text-muted-foreground py-2 text-center">
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
        className="h-6 text-[11px] text-muted-foreground"
        onClick={addEntry}
      >
        <Plus className="size-3" /> 添加字段
      </Button>
    </div>
  )
}

function JsonObjectEntry({
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

function StringListEditor({
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
          <span className="text-[10px] text-muted-foreground pt-1.5 w-4 shrink-0 tabular-nums text-right">
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
        className="h-6 text-[11px] text-muted-foreground"
        onClick={addItem}
      >
        <Plus className="size-3" /> 添加项
      </Button>
    </div>
  )
}

// ── 工具：容错解析 JSON: string[]（旧数据/非法 JSON 返回空数组）──

function safeParseParticipants(raw: string): string[] {
  try {
    const p = JSON.parse(raw)
    if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }
  return []
}

// ── 三层模型：角色参与的冲突反向索引只读 Badge 列表 ──

function ParticipatingConflictsBadges({ raw }: { raw: string }): ReactElement {
  const ids = safeParseParticipants(raw)
  if (ids.length === 0) {
    return <span className="text-[11px] text-muted-foreground">暂无参与冲突</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">
          {id.slice(0, 8)}
        </Badge>
      ))}
    </div>
  )
}

// ── 分组标题（iOS Settings 风格） ──

function SectionHeader({ title, hint }: { title: string; hint?: string }): ReactElement {
  return (
    <div className="pt-4 pb-1.5 first:pt-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {hint && <div className="text-[10px] text-muted-foreground/70 mt-0.5">{hint}</div>}
    </div>
  )
}

// ── 防抖大纲字段（1.5s 防抖 + onBlur 保存，复用 D-2 的防抖保存逻辑） ──
// 用于全书大纲 / 卷纲 / 章纲：从左边栏点击后在右边栏编辑，自动持久化。

interface DebouncedOutlineFieldProps {
  label: string
  value: string
  placeholder?: string
  onSave: (value: string) => Promise<void>
}

function DebouncedOutlineField({
  label,
  value,
  placeholder,
  onSave,
}: DebouncedOutlineFieldProps): ReactElement {
  const [draft, setDraft] = useState(value)
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
    if (text.trim() === valueRef.current.trim()) return
    isSavingRef.current = true
    try {
      await onSaveRef.current(text)
    } catch (err) {
      console.error('[DebouncedOutlineField] 保存失败:', err)
    } finally {
      isSavingRef.current = false
    }
  }

  const scheduleSave = (text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void doSave(text)
    }, 1500)
  }

  return (
    <FieldRow label={label}>
      <TextArea
        variant="long"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value)
          scheduleSave(e.target.value)
        }}
        onBlur={() => {
          if (timerRef.current) clearTimeout(timerRef.current)
          void doSave(draft)
        }}
      />
    </FieldRow>
  )
}

// ── 选项常量 ──

const STAGE_OPTIONS: { value: StoryStage; label: string }[] = [
  { value: 'setup', label: '铺垫' },
  { value: 'rising', label: '上升' },
  { value: 'climax', label: '高潮' },
  { value: 'falling', label: '回落' },
  { value: 'resolution', label: '结局' },
]

const PROJECT_STATUS_OPTIONS = [
  { value: 'active', label: '进行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
]

const TARGET_PLATFORM_OPTIONS: { value: TargetPlatform | '__none__'; label: string; hint: string }[] = [
  { value: '__none__', label: '未设定', hint: '不调整评分权重' },
  { value: 'fanqie', label: '番茄', hint: '重节奏和爽感' },
  { value: 'qidian', label: '起点', hint: '重世界观和伏笔' },
  { value: 'zhihu_yanyan', label: '知乎盐言', hint: '重开篇和反转' },
  { value: 'general', label: '通用', hint: '不调整评分权重' },
]

const CHAPTER_STATUS_OPTIONS: { value: ChapterStatus; label: string }[] = [
  { value: 'planned', label: '已规划' },
  { value: 'drafting', label: '草稿中' },
  { value: 'review', label: '审核中' },
  { value: 'published', label: '已发布' },
  { value: 'rejected', label: '已驳回' },
]

const CONFLICT_TYPE_OPTIONS: { value: ConflictType; label: string }[] = [
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

const CONFLICT_STAGE_OPTIONS: { value: ConflictStage; label: string }[] = [
  { value: 'latent', label: '潜伏' },
  { value: 'emerging', label: '浮现' },
  { value: 'escalating', label: '升级' },
  { value: 'erupting', label: '爆发' },
  { value: 'reversing', label: '逆转' },
  { value: 'resolved', label: '已解决' },
  { value: 'transformed', label: '转化' },
]

const CONFLICT_TIER_OPTIONS: { value: ConflictTier; label: string }[] = [
  { value: 'main', label: '主线' },
  { value: 'secondary', label: '支线' },
  { value: 'goal', label: '目标' },
]

const CLIMAX_TYPE_OPTIONS: { value: ClimaxType; label: string }[] = [
  { value: 'emotional', label: '情感高潮' },
  { value: 'fate', label: '命运高潮' },
  { value: 'character', label: '性格高潮' },
  { value: 'combat', label: '打斗高潮' },
  { value: 'theme', label: '主题高潮' },
  { value: 'composite', label: '复合高潮' },
]

// ── P2-1：冲突功能位（7 值枚举）+ 非线性推进模式（5 值枚举）──
const CONFLICT_PLOT_FUNCTION_OPTIONS: { value: ConflictPlotFunction; label: string }[] = [
  { value: 'provide_resource', label: '提供资源' },
  { value: 'create_obstacle', label: '制造障碍' },
  { value: 'amplify_conflict', label: '激化冲突' },
  { value: 'open_phase', label: '开启阶段' },
  { value: 'change_judgment', label: '改变判断' },
  { value: 'advance_relationship', label: '推进关系' },
  { value: 'reveal_world_rule', label: '揭示世界规则' },
]

const CONFLICT_PROGRESSION_MODE_OPTIONS: { value: ConflictProgressionMode; label: string }[] = [
  { value: 'linear', label: '线性升级' },
  { value: 'mutation', label: '突变' },
  { value: 'stagnation', label: '停滞' },
  { value: 'regression', label: '降级' },
  { value: 'reversal', label: '反转' },
]

// ── 三层模型：角色层级（5 值枚举）──
const CHARACTER_PLOT_ROLE_OPTIONS: { value: NovelCharacterPlotRole; label: string }[] = [
  { value: 'protagonist', label: '主角' },
  { value: 'main_opponent', label: '主对手' },
  { value: 'supporting', label: '配角' },
  { value: 'function', label: '功能性' },
  { value: 'background', label: '背景' },
]

const CHAPTER_RHYTHM_OPTIONS: { value: ChapterRhythm; label: string }[] = [
  { value: 'setup', label: '铺垫' },
  { value: 'rising', label: '上升' },
  { value: 'climax', label: '高潮' },
  { value: 'falling', label: '下降' },
  { value: 'resolution', label: '收束' },
  { value: 'twist', label: '转折' },
  { value: 'breather', label: '舒缓' },
  { value: 'suspense', label: '悬念' },
]

const FORESHADOW_STATUS_OPTIONS: { value: ForeshadowStatus; label: string }[] = [
  { value: 'planned', label: '已规划' },
  { value: 'planted', label: '已埋设' },
  { value: 'reinforced', label: '已强化' },
  { value: 'partially_revealed', label: '部分揭示' },
  { value: 'recovering', label: '回收中' },
  { value: 'recovered', label: '已回收' },
  { value: 'abandoned', label: '已废弃' },
]

// ── P2-2：伏笔分类枚举（与后端 NovelForeshadowCategory 对齐）──
const FORESHADOW_CATEGORY_OPTIONS: { value: NovelForeshadowCategory; label: string }[] = [
  { value: 'item', label: '物品' },
  { value: 'spoken', label: '言语' },
  { value: 'event', label: '事件' },
  { value: 'identity', label: '身份' },
  { value: 'secret', label: '秘密' },
  { value: 'prophecy', label: '预言' },
  { value: 'promise', label: '承诺' },
  { value: 'quote', label: '台词' },
]

const FACTION_TYPE_OPTIONS: { value: NovelFactionType; label: string }[] = [
  { value: 'organization', label: '组织' },
  { value: 'sect', label: '门派' },
  { value: 'kingdom', label: '王国' },
  { value: 'family', label: '家族' },
  { value: 'guild', label: '公会' },
  { value: 'cult', label: '邪教' },
]

const FACTION_STRENGTH_OPTIONS: { value: NovelFactionStrength; label: string }[] = [
  { value: 'weak', label: '弱小' },
  { value: 'medium', label: '中等' },
  { value: 'strong', label: '强盛' },
  { value: 'overwhelming', label: '压倒性' },
]

const FACTION_STATUS_OPTIONS: { value: NovelFactionStatus; label: string }[] = [
  { value: 'active', label: '活跃' },
  { value: 'declined', label: '衰落' },
  { value: 'destroyed', label: '覆灭' },
  { value: 'hidden', label: '隐秘' },
]

const LOCATION_TYPE_OPTIONS: { value: NovelLocationType; label: string }[] = [
  { value: 'continent', label: '大陆' },
  { value: 'country', label: '国家' },
  { value: 'city', label: '城市' },
  { value: 'building', label: '建筑' },
  { value: 'dungeon', label: '地下城' },
  { value: 'region', label: '区域' },
  { value: 'wilderness', label: '荒野' },
]

const LOCATION_SIGNIFICANCE_OPTIONS: { value: NovelLocationSignificance; label: string }[] = [
  { value: 'minor', label: '次要' },
  { value: 'moderate', label: '中等' },
  { value: 'major', label: '重要' },
  { value: 'critical', label: '关键' },
]

const LOCATION_STATUS_OPTIONS: { value: NovelLocationStatus; label: string }[] = [
  { value: 'normal', label: '正常' },
  { value: 'destroyed', label: '毁灭' },
  { value: 'changed', label: '变迁' },
  { value: 'hidden', label: '隐秘' },
]

const WORLD_ELEMENT_CATEGORY_OPTIONS: { value: NovelWorldElementCategory; label: string }[] = [
  { value: 'power_system', label: '力量体系' },
  { value: 'history', label: '历史' },
  { value: 'culture', label: '文化' },
  { value: 'religion', label: '宗教' },
  { value: 'technology', label: '科技' },
  { value: 'economy', label: '经济' },
  { value: 'geography', label: '地理' },
]

// 节点类型中文标签
const NODE_TYPE_LABELS: Record<NovelNodeType, string> = {
  project: '项目',
  character: '角色',
  chapter: '章节',
  volume: '卷',
  conflict: '冲突',
  foreshadow: '伏笔',
  faction: '势力',
  location: '地点',
  world_element: '世界要素',
  info_layer: '信息差',
  group: '分组',
}

// 动态状态字段（用于变更历史记录）
const DYNAMIC_FIELDS: CharacterHistoryField[] = [
  'currentState',
  'currentGoal',
  'currentPressure',
  'secret',
  'arcStage',
]

const HISTORY_FIELD_LABELS: Record<CharacterHistoryField, string> = {
  currentState: '当前状态',
  currentGoal: '当前目标',
  currentPressure: '当前压力',
  secret: '秘密',
  arcStage: '弧光阶段',
}

// 简单的相对时间格式化
function relativeTime(timestamp: number): string {
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

// ── 主组件 ──

export function NovelDetailPanel(): ReactElement {
  const selectedNodeId = useNovelUiStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelUiStore((s) => s.selectedNodeType)
  const clearSelection = useNovelUiStore((s) => s.clearSelection)
  const projects = useNovelDataStore((s) => s.projects)
  const characters = useNovelDataStore((s) => s.characters)
  const chapters = useNovelDataStore((s) => s.chapters)
  const volumes = useNovelDataStore((s) => s.volumes)
  const conflicts = useNovelDataStore((s) => s.conflicts)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)
  const factions = useNovelDataStore((s) => s.factions)
  const locations = useNovelDataStore((s) => s.locations)
  const worldElements = useNovelDataStore((s) => s.worldElements)
  const infoLayers = useNovelDataStore((s) => s.infoLayers)

  const entity = useMemo(() => {
    if (!selectedNodeId || !selectedNodeType) return null
    switch (selectedNodeType) {
      case 'project':
        return projects.find((p) => p.id === selectedNodeId) ?? null
      case 'character':
        return characters.find((c) => c.id === selectedNodeId) ?? null
      case 'chapter':
        return chapters.find((c) => c.id === selectedNodeId) ?? null
      case 'volume':
        return volumes.find((v) => v.id === selectedNodeId) ?? null
      case 'conflict':
        return conflicts.find((c) => c.id === selectedNodeId) ?? null
      case 'foreshadow':
        return foreshadows.find((f) => f.id === selectedNodeId) ?? null
      case 'faction':
        return factions.find((f) => f.id === selectedNodeId) ?? null
      case 'location':
        return locations.find((l) => l.id === selectedNodeId) ?? null
      case 'world_element':
        return worldElements.find((w) => w.id === selectedNodeId) ?? null
      case 'info_layer':
        return infoLayers.find((l) => l.id === selectedNodeId) ?? null
      default:
        return null
    }
  }, [selectedNodeId, selectedNodeType, projects, characters, chapters, volumes, conflicts, foreshadows, factions, locations, worldElements, infoLayers])

  if (!entity || !selectedNodeType) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-surface-1 border-l border-border p-6 text-center">
        <Info className="size-6 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">
          在画布上选择一个节点以查看详情
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface-1 border-l border-border">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="secondary" className="shrink-0">
            {NODE_TYPE_LABELS[selectedNodeType] ?? selectedNodeType}
          </Badge>
          <span className="text-sm font-medium text-text truncate">
            {entityTitle(entity, selectedNodeType)}
          </span>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={clearSelection} aria-label="关闭">
          <X className="size-3.5" />
        </Button>
      </div>

      {/* 表单 */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {selectedNodeType === 'project' && (
          <ProjectForm key={entity.id} entity={entity as NovelProject} />
        )}
        {selectedNodeType === 'character' && (
          <CharacterForm key={entity.id} entity={entity as NovelCharacter} />
        )}
        {selectedNodeType === 'chapter' && (
          <ChapterForm key={entity.id} entity={entity as NovelChapter} />
        )}
        {selectedNodeType === 'volume' && (
          <VolumeForm key={entity.id} entity={entity as NovelVolume} />
        )}
        {selectedNodeType === 'conflict' && (
          <ConflictForm key={entity.id} entity={entity as NovelConflict} />
        )}
        {selectedNodeType === 'foreshadow' && (
          <ForeshadowForm key={entity.id} entity={entity as NovelForeshadow} />
        )}
        {selectedNodeType === 'faction' && (
          <FactionForm key={entity.id} entity={entity as NovelFaction} />
        )}
        {selectedNodeType === 'location' && (
          <LocationForm key={entity.id} entity={entity as NovelLocation} />
        )}
        {selectedNodeType === 'world_element' && (
          <WorldElementForm key={entity.id} entity={entity as NovelWorldElement} />
        )}
        {selectedNodeType === 'info_layer' && (
          <InfoLayerForm key={entity.id} entity={entity as NovelInformationLayer} />
        )}
      </div>
    </div>
  )
}

function entityTitle(entity: unknown, type: string): string {
  const e = entity as Record<string, unknown>
  if (type === 'project') return String(e.title ?? '')
  if (type === 'chapter') return String(e.title ?? `第 ${e.chapterNumber} 章`)
  if (type === 'volume') return String(e.title ?? `第 ${e.volumeNumber} 卷`)
  if (type === 'character') return String(e.name ?? '')
  if (type === 'faction' || type === 'location' || type === 'world_element') {
    return String(e.name ?? '')
  }
  if (type === 'conflict' || type === 'foreshadow' || type === 'info_layer') {
    const d = String(e.description ?? e.infoDescription ?? '')
    return d.length > 20 ? `${d.slice(0, 20)}...` : d
  }
  return ''
}

// ── 保存按钮 ──

function SaveButton({
  onSave,
  disabled,
  saving,
}: {
  onSave: () => void
  disabled: boolean
  saving: boolean
}): ReactElement {
  return (
    <div className="pt-2">
      <Button onClick={onSave} disabled={disabled || saving} className="w-full">
        <Save className="size-3.5" />
        {saving ? '保存中...' : '保存修改'}
      </Button>
    </div>
  )
}

// ── 项目表单 ──

function ProjectForm({ entity }: { entity: NovelProject }): ReactElement {
  const upsertProject = useNovelDataStore((s) => s.upsertProject)
  const [form, setForm] = useState({
    title: entity.title,
    genre: entity.genre,
    synopsis: entity.synopsis,
    targetWords: String(entity.targetWords),
    currentStage: entity.currentStage,
    status: entity.status,
    rhythmModelId: entity.rhythmModelId ?? '',
    targetPlatform: entity.targetPlatform ?? '__none__',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rhythmModels, setRhythmModels] = useState<RhythmModel[]>([])

  useEffect(() => {
    let cancelled = false
    listRhythmModels()
      .then((models) => { if (!cancelled) setRhythmModels(models) })
      .catch(() => { /* 节奏模型加载失败不阻塞表单 */ })
    return () => { cancelled = true }
  }, [])

  const dirty =
    form.title !== entity.title ||
    form.genre !== entity.genre ||
    form.synopsis !== entity.synopsis ||
    Number(form.targetWords) !== entity.targetWords ||
    form.currentStage !== entity.currentStage ||
    form.status !== entity.status ||
    (form.rhythmModelId || '') !== (entity.rhythmModelId ?? '') ||
    form.targetPlatform !== (entity.targetPlatform ?? '__none__')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateProject(entity.id, {
        title: form.title,
        genre: form.genre,
        synopsis: form.synopsis,
        targetWords: Number(form.targetWords) || 0,
        currentStage: form.currentStage,
        status: form.status,
        rhythmModelId: form.rhythmModelId === '' ? undefined : form.rhythmModelId,
        targetPlatform: form.targetPlatform === '__none__' ? null : form.targetPlatform,
      })
      upsertProject(updated)
      toastSuccess('项目已保存', '修改已生效')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      setError(msg)
      toastError('保存失败', msg)
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertProject])

  return (
    <div className="space-y-2">
      <SectionHeader title="全书大纲" />
      <DebouncedOutlineField
        label="大纲内容"
        value={entity.outline ?? ''}
        placeholder="编写全书大纲..."
        onSave={async (outline) => {
          const updated = await updateProject(entity.id, { outline })
          upsertProject(updated)
        }}
      />

      <SectionHeader title="基础信息" />
      <FieldRow label="标题">
        <TextInput value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
      </FieldRow>
      <FieldRow label="题材">
        <TextInput value={form.genre} onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))} />
      </FieldRow>
      <FieldRow label="目标字数">
        <TextInput
          type="number"
          value={form.targetWords}
          onChange={(e) => setForm((f) => ({ ...f, targetWords: e.target.value }))}
        />
      </FieldRow>

      <SectionHeader title="状态" />
      <FieldRow label="当前阶段">
        <Select value={form.currentStage} onValueChange={(v) => setForm((f) => ({ ...f, currentStage: v as StoryStage }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STAGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as NovelProject['status'] }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="节奏模型">
        <Select value={form.rhythmModelId} onValueChange={(v) => setForm((f) => ({ ...f, rhythmModelId: v === '__default__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="默认模型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">默认模型</SelectItem>
            {rhythmModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="目标平台">
        <Select value={form.targetPlatform} onValueChange={(v) => setForm((f) => ({ ...f, targetPlatform: v as TargetPlatform | '__none__' }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TARGET_PLATFORM_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}{o.hint ? `（${o.hint}）` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="简介" />
      <FieldRow label="简介">
        <TextArea variant="long" value={form.synopsis} onChange={(e) => setForm((f) => ({ ...f, synopsis: e.target.value }))} />
      </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 角色表单 ──

function CharacterForm({ entity }: { entity: NovelCharacter }): ReactElement {
  const upsertCharacter = useNovelDataStore((s) => s.upsertCharacter)
  const [form, setForm] = useState({
    name: entity.name,
    identity: entity.identity,
    personality: entity.personality,
    appearance: entity.appearance,
    currentState: entity.currentState,
    currentGoal: entity.currentGoal,
    currentPressure: entity.currentPressure,
    secret: entity.secret,
    arcStage: entity.arcStage,
    speechStyle: entity.speechStyle,
    description: entity.description,
    // ── 三层模型：长期欲望 / 角色层级 / 删掉影响 ──
    longTermDesire: entity.longTermDesire,
    plotRole: entity.plotRole,
    removalImpact: entity.removalImpact,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = (Object.keys(form) as (keyof typeof form)[]).some(
    (k) => form[k] !== entity[k],
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateCharacter(entity.id, form)
      upsertCharacter(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertCharacter])

  return (
    <div className="space-y-2">
      <SectionHeader title="基础信息" />
      <FieldRow label="姓名">
        <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </FieldRow>
      <FieldRow label="身份">
        <TextArea variant="short" value={form.identity} onChange={(e) => setForm((f) => ({ ...f, identity: e.target.value }))} />
      </FieldRow>
      <FieldRow label="外貌">
        <TextArea variant="medium" value={form.appearance} onChange={(e) => setForm((f) => ({ ...f, appearance: e.target.value }))} />
      </FieldRow>

      {/* 三层模型：长期欲望 / 角色层级 / 删掉影响 */}
      <SectionHeader title="角色定位" hint="跨章节稳定的发动机与功能位约束" />
      <FieldRow label="长期欲望">
        <TextArea variant="short" value={form.longTermDesire} onChange={(e) => setForm((f) => ({ ...f, longTermDesire: e.target.value }))} placeholder="区别于当前目标，跨章节稳定" />
      </FieldRow>
      <FieldRow label="角色层级">
        <Select value={form.plotRole} onValueChange={(v) => setForm((f) => ({ ...f, plotRole: v as NovelCharacterPlotRole }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHARACTER_PLOT_ROLE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="删掉影响">
        <TextArea variant="short" value={form.removalImpact} onChange={(e) => setForm((f) => ({ ...f, removalImpact: e.target.value }))} placeholder="删掉这个角色哪段剧情会受影响" />
      </FieldRow>

      <SectionHeader title="简述" />
      <FieldRow label="简述">
        <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>

      <SectionHeader title="性格特征" hint="支持核心、优点、缺点、座右铭等结构化字段" />
      <JsonObjectEditor value={form.personality} onChange={(v) => setForm((f) => ({ ...f, personality: v }))} />

      <SectionHeader title="说话风格" hint="支持基调、特点、典型句式等结构化字段" />
      <JsonObjectEditor value={form.speechStyle} onChange={(v) => setForm((f) => ({ ...f, speechStyle: v }))} />

      <SectionHeader title="当前状态" hint="修改动态状态会记录到变更历史" />
      <FieldRow label="当前状态">
        <TextArea variant="short" value={form.currentState} onChange={(e) => setForm((f) => ({ ...f, currentState: e.target.value }))} />
      </FieldRow>
      <FieldRow label="当前目标">
        <TextArea variant="short" value={form.currentGoal} onChange={(e) => setForm((f) => ({ ...f, currentGoal: e.target.value }))} />
      </FieldRow>
      <FieldRow label="当前压力">
        <TextArea variant="short" value={form.currentPressure} onChange={(e) => setForm((f) => ({ ...f, currentPressure: e.target.value }))} />
      </FieldRow>
      <FieldRow label="秘密">
        <TextArea variant="medium" value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} />
      </FieldRow>
      <FieldRow label="弧光阶段">
        <Select
          value={form.arcStage || '__none__'}
          onValueChange={(v) => setForm((f) => ({ ...f, arcStage: v === '__none__' ? '' : v }))}
        >
          <SelectTrigger className="h-9">
            <SelectValue placeholder="未设置" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">未设置</SelectItem>
            {STAGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {/* 三层模型④：影响层反向索引（只读，由冲突 CRUD 自动同步） */}
      <SectionHeader title="参与冲突" hint="反向索引：由冲突编辑时的 participants 自动同步" />
      <ParticipatingConflictsBadges raw={entity.participatingConflicts} />

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />

      {/* 状态变更历史时间线 */}
      <CharacterHistorySection characterId={entity.id} />
    </div>
  )
}

// ── 角色状态变更历史 ──

function CharacterHistorySection({ characterId }: { characterId: string }): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const addCharacterHistory = useNovelDataStore((s) => s.addCharacterHistory)
  const queryClient = useQueryClient()
  const [manualOpen, setManualOpen] = useState(false)

  const queryKey = useMemo(
    () => ['novel-character-history', currentProjectId, characterId] as const,
    [currentProjectId, characterId],
  )

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!currentProjectId) return []
      return listCharacterHistory(currentProjectId, characterId)
    },
    enabled: !!currentProjectId,
  })

  const history = data ?? []

  const handleManualCreated = useCallback(
    (entry: NovelCharacterHistory) => {
      addCharacterHistory(entry)
      void queryClient.invalidateQueries({ queryKey })
    },
    [addCharacterHistory, queryClient, queryKey],
  )

  return (
    <div className="pt-3 mt-3 border-t border-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <History className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-text">状态变更历史</span>
          <Badge variant="secondary" className="h-4 px-1 text-[10px] tabular-nums">
            {history.length}
          </Badge>
        </div>
        <Button size="xs" variant="ghost" onClick={() => setManualOpen(true)}>
          <Plus className="size-3" />
          手动记录变更
        </Button>
      </div>

      {isLoading ? (
        <p className="text-[11px] text-muted-foreground px-1 py-2">加载中...</p>
      ) : error ? (
        <p className="text-[11px] text-destructive px-1 py-2">
          {error instanceof Error ? error.message : '加载历史失败'}
        </p>
      ) : history.length === 0 ? (
        <p className="text-[11px] text-muted-foreground px-1 py-2">暂无变更记录</p>
      ) : (
        <CharacterHistoryTimeline history={history} />
      )}

      <ManualHistoryDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        characterId={characterId}
        onCreated={handleManualCreated}
      />
    </div>
  )
}

function CharacterHistoryTimeline({
  history,
}: {
  history: NovelCharacterHistory[]
}): ReactElement {
  // 按时间倒序
  const sorted = useMemo(
    () => [...history].sort((a, b) => b.createdAt - a.createdAt),
    [history],
  )
  return (
    <ol className="relative space-y-2.5 pl-3">
      {/* 时间线竖线 */}
      <span
        className="absolute left-[3px] top-1 bottom-1 w-px bg-border"
        aria-hidden="true"
      />
      {sorted.map((entry) => {
        const fieldLabel = HISTORY_FIELD_LABELS[entry.fieldName] ?? entry.fieldName
        const chapterLabel =
          entry.chapterNumber != null
            ? `第 ${entry.chapterNumber} 章`
            : '手动'
        return (
          <li key={entry.id} className="relative">
            {/* 节点圆点 */}
            <span
              className="absolute -left-3 top-1 size-1.5 rounded-full bg-primary ring-2 ring-background"
              aria-hidden="true"
            />
            <div className="rounded-md bg-muted/40 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-text">
                  {chapterLabel} · {fieldLabel}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {relativeTime(entry.createdAt)}
                </span>
              </div>
              <div className="mt-1 space-y-0.5 text-[10px]">
                {entry.oldValue != null && (
                  <div className="text-muted-foreground">
                    旧值: <span className="text-text">{entry.oldValue || '（空）'}</span>
                  </div>
                )}
                {entry.newValue != null && (
                  <div className="text-muted-foreground">
                    新值: <span className="text-text">{entry.newValue || '（空）'}</span>
                  </div>
                )}
                {entry.reason && (
                  <div className="text-muted-foreground">
                    原因: <span className="text-text">{entry.reason}</span>
                  </div>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ── 手动记录变更对话框 ──

interface ManualHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  characterId: string
  onCreated: (entry: NovelCharacterHistory) => void
}

function ManualHistoryDialog({
  open,
  onOpenChange,
  characterId,
  onCreated,
}: ManualHistoryDialogProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const [fieldName, setFieldName] = useState<CharacterHistoryField>('currentState')
  const [oldValue, setOldValue] = useState('')
  const [newValue, setNewValue] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 关闭时重置表单
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setFieldName('currentState')
        setOldValue('')
        setNewValue('')
        setReason('')
        setError(null)
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const handleSave = useCallback(async () => {
    if (!currentProjectId) {
      setError('未选择项目')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const entry = await createCharacterHistory(currentProjectId, characterId, {
        fieldName,
        oldValue: oldValue || null,
        newValue: newValue || null,
        reason: reason || null,
      })
      onCreated(entry)
      handleOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [currentProjectId, characterId, fieldName, oldValue, newValue, reason, onCreated, handleOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>手动记录变更</DialogTitle>
          <DialogDescription className="text-pretty">记录角色动态状态的一次变更</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">字段</Label>
            <Select
              value={fieldName}
              onValueChange={(v) => setFieldName(v as CharacterHistoryField)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DYNAMIC_FIELDS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {HISTORY_FIELD_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hist-old" className="text-xs text-muted-foreground">旧值</Label>
            <Input
              id="hist-old"
              value={oldValue}
              onChange={(e) => setOldValue(e.target.value)}
              placeholder="原值（可留空）"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hist-new" className="text-xs text-muted-foreground">新值</Label>
            <Input
              id="hist-new"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="变更后的值"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hist-reason" className="text-xs text-muted-foreground">原因</Label>
            <Input
              id="hist-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="变更原因（可选）"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || !currentProjectId}>
            {saving ? '保存中...' : '保存记录'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── 章节表单 ──

function ChapterForm({ entity }: { entity: NovelChapter }): ReactElement {
  const upsertChapter = useNovelDataStore((s) => s.upsertChapter)
  const [form, setForm] = useState({
    title: entity.title,
    status: entity.status,
    rhythm: entity.rhythm ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    form.title !== entity.title ||
    form.status !== entity.status ||
    (form.rhythm || '') !== (entity.rhythm ?? '')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateChapter(entity.id, {
        title: form.title,
        status: form.status,
        rhythm: form.rhythm === '' ? undefined : (form.rhythm as ChapterRhythm),
      })
      upsertChapter(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertChapter])

  return (
    <div className="space-y-2">
      <SectionHeader title="章纲" />
      <DebouncedOutlineField
        label="章纲内容"
        value={entity.outline ?? ''}
        placeholder="编写章纲（生成的统一起点）..."
        onSave={async (outline) => {
          const updated = await updateChapter(entity.id, { outline })
          upsertChapter(updated)
        }}
      />

      <SectionHeader title="元信息" />
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>第 {entity.chapterNumber} 章 · 卷 {entity.volume}</span>
        <span>{entity.wordCount} 字</span>
      </div>

      <SectionHeader title="标题与状态" />
      <FieldRow label="标题">
        <TextInput value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
      </FieldRow>
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as ChapterStatus }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHAPTER_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="节奏">
        <Select value={form.rhythm} onValueChange={(v) => setForm((f) => ({ ...f, rhythm: v === '__none__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="未指定" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">未指定</SelectItem>
            {CHAPTER_RHYTHM_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {entity.narrativeTask && (
        <>
          <SectionHeader title="叙事任务" />
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap rounded bg-muted/50 p-2">
            {entity.narrativeTask}
          </pre>
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 卷编辑表单 ──

function VolumeForm({ entity }: { entity: NovelVolume }): ReactElement {
  const upsertVolume = useNovelDataStore((s) => s.upsertVolume)
  const [form, setForm] = useState({
    title: entity.title,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = form.title !== entity.title

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateVolume(entity.id, { title: form.title })
      upsertVolume(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertVolume])

  return (
    <div className="space-y-2">
      <SectionHeader title="卷纲" />
      <DebouncedOutlineField
        label="卷纲内容"
        value={entity.outline ?? ''}
        placeholder="编写卷纲..."
        onSave={async (outline) => {
          const updated = await updateVolume(entity.id, { outline })
          upsertVolume(updated)
        }}
      />

      <SectionHeader title="基础信息" />
      <FieldRow label="标题">
        <TextInput value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
      </FieldRow>
      <div className="text-xs text-muted-foreground">
        第 {entity.volumeNumber} 卷
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 冲突编辑表单 ──

function ConflictForm({ entity }: { entity: NovelConflict }): ReactElement {
  const upsertConflict = useNovelDataStore((s) => s.upsertConflict)
  const [form, setForm] = useState({
    description: entity.description,
    type: entity.type,
    intensity: String(entity.intensity),
    stage: entity.stage,
    tier: entity.tier,
    climaxChapter: entity.climaxChapter != null ? String(entity.climaxChapter) : '',
    climaxType: entity.climaxType ?? '',
    stakes: entity.stakes ?? '',
    twistPotential: entity.twistPotential != null ? String(entity.twistPotential) : '',
    // ── P2-1：功能位 + 推进模式 + 参与者（可编辑）──
    plotFunction: entity.plotFunction ?? '',
    progressionMode: entity.progressionMode ?? '',
    participantsList: safeParseParticipants(entity.participants),
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    form.description !== entity.description ||
    form.type !== entity.type ||
    form.stage !== entity.stage ||
    form.tier !== entity.tier ||
    Number(form.intensity) !== entity.intensity ||
    (form.climaxChapter || '') !== (entity.climaxChapter != null ? String(entity.climaxChapter) : '') ||
    (form.climaxType || '') !== (entity.climaxType ?? '') ||
    form.stakes !== (entity.stakes ?? '') ||
    (form.twistPotential || '') !== (entity.twistPotential != null ? String(entity.twistPotential) : '') ||
    (form.plotFunction || '') !== (entity.plotFunction ?? '') ||
    (form.progressionMode || '') !== (entity.progressionMode ?? '') ||
    form.participantsList.join('\n') !== safeParseParticipants(entity.participants).join('\n')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const climaxChapterNum = form.climaxChapter.trim() === '' ? null : Number(form.climaxChapter)
      const twistPotentialNum = form.twistPotential.trim() === '' ? undefined : Number(form.twistPotential)
      const updated = await updateConflict(entity.id, {
        description: form.description,
        type: form.type,
        intensity: Number(form.intensity) || 0,
        stage: form.stage,
        tier: form.tier,
        climaxChapter: climaxChapterNum,
        climaxType: form.climaxType === '' ? null : (form.climaxType as ClimaxType),
        stakes: form.stakes === '' ? null : form.stakes,
        twistPotential: twistPotentialNum,
        // ── P2-1：提交新增三字段 ──
        plotFunction: form.plotFunction === '' ? undefined : (form.plotFunction as ConflictPlotFunction),
        progressionMode: form.progressionMode === '' ? undefined : (form.progressionMode as ConflictProgressionMode),
        participants: form.participantsList.filter((s) => s.trim()),
      })
      upsertConflict(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertConflict])

  return (
    <div className="space-y-2">
      <SectionHeader title="基本信息" />
      <FieldRow label="描述">
        <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>
      <FieldRow label="类型">
        <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as ConflictType }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONFLICT_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="层级">
        <Select value={form.tier} onValueChange={(v) => setForm((f) => ({ ...f, tier: v as ConflictTier }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONFLICT_TIER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      {/* P2-1：功能位（7 值枚举）+ 推进模式（5 值枚举） */}
      <FieldRow label="功能位">
        <Select value={form.plotFunction || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, plotFunction: v === '__none__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="未指定" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">未指定</SelectItem>
            {CONFLICT_PLOT_FUNCTION_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="推进模式">
        <Select value={form.progressionMode || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, progressionMode: v === '__none__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="未指定" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">未指定</SelectItem>
            {CONFLICT_PROGRESSION_MODE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="状态" />
      <FieldRow label="阶段">
        <Select value={form.stage} onValueChange={(v) => setForm((f) => ({ ...f, stage: v as ConflictStage }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONFLICT_STAGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="强度">
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-rose-500"
              style={{ width: `${(Number(form.intensity) / 10) * 100}%` }}
            />
          </div>
          <TextInput
            type="number"
            min={0}
            max={10}
            value={form.intensity}
            onChange={(e) => setForm((f) => ({ ...f, intensity: e.target.value }))}
            className="w-16"
          />
          <span className="text-xs text-muted-foreground">/10</span>
        </div>
      </FieldRow>

      <SectionHeader title="高潮与突转" />
      <FieldRow label="爆发章节">
        <TextInput
          type="number"
          min={1}
          value={form.climaxChapter}
          onChange={(e) => setForm((f) => ({ ...f, climaxChapter: e.target.value }))}
          placeholder="留空表示未指定"
        />
      </FieldRow>
      <FieldRow label="高潮类型">
        <Select value={form.climaxType} onValueChange={(v) => setForm((f) => ({ ...f, climaxType: v === '__none__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="未指定" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">未指定</SelectItem>
            {CLIMAX_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="赌注/代价">
        <TextArea variant="short" value={form.stakes} onChange={(e) => setForm((f) => ({ ...f, stakes: e.target.value }))} placeholder="冲突失败或成功后的代价" />
      </FieldRow>
      <FieldRow label="突转潜力">
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-amber-500"
              style={{ width: `${(Number(form.twistPotential || 0) / 10) * 100}%` }}
            />
          </div>
          <TextInput
            type="number"
            min={0}
            max={10}
            value={form.twistPotential}
            onChange={(e) => setForm((f) => ({ ...f, twistPotential: e.target.value }))}
            className="w-16"
          />
          <span className="text-xs text-muted-foreground">/10</span>
        </div>
      </FieldRow>

      <SectionHeader title="参与方" />
      <FieldRow label="参与者">
        <StringListEditor
          items={form.participantsList}
          onChange={(items) => setForm((f) => ({ ...f, participantsList: items }))}
        />
      </FieldRow>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 伏笔编辑表单 ──

function ForeshadowForm({ entity }: { entity: NovelForeshadow }): ReactElement {
  const upsertForeshadow = useNovelDataStore((s) => s.upsertForeshadow)
  const infoLayers = useNovelDataStore((s) => s.infoLayers)
  const [form, setForm] = useState({
    description: entity.description,
    category: entity.category,
    status: entity.status,
    firstChapter: entity.firstChapter != null ? String(entity.firstChapter) : '',
    lastChapter: entity.lastChapter != null ? String(entity.lastChapter) : '',
    recoverByChapter: entity.recoverByChapter != null ? String(entity.recoverByChapter) : '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  let linkedCharacters: string[] = []
  try {
    const p = JSON.parse(entity.linkedCharacters)
    if (Array.isArray(p)) linkedCharacters = p.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }

  let linkedClues: string[] = []
  try {
    const c = JSON.parse(entity.linkedClues)
    if (Array.isArray(c)) linkedClues = c.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }

  // ── P3-2：解析 linkedInfoLayers，展示伏笔承载的信息差 ──
  let linkedInfoLayerIds: string[] = []
  try {
    const l = JSON.parse(entity.linkedInfoLayers)
    if (Array.isArray(l)) linkedInfoLayerIds = l.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }
  // 将信息差 ID 解析为描述，用于展示
  const linkedInfoLayerItems = linkedInfoLayerIds.map((id) => {
    const layer = infoLayers.find((l) => l.id === id)
    return {
      id,
      description: layer?.infoDescription ?? id,
      readerKnows: layer?.readerKnows ?? false,
    }
  })

  const toNumOrNull = (v: string): number | null => (v === '' ? null : Number(v))

  const dirty =
    form.description !== entity.description ||
    form.category !== entity.category ||
    form.status !== entity.status ||
    toNumOrNull(form.firstChapter) !== entity.firstChapter ||
    toNumOrNull(form.lastChapter) !== entity.lastChapter ||
    toNumOrNull(form.recoverByChapter) !== entity.recoverByChapter

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateForeshadow(entity.id, {
        description: form.description,
        category: form.category,
        status: form.status,
        firstChapter: toNumOrNull(form.firstChapter),
        lastChapter: toNumOrNull(form.lastChapter),
        recoverByChapter: toNumOrNull(form.recoverByChapter),
      })
      upsertForeshadow(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertForeshadow])

  return (
    <div className="space-y-2">
      <SectionHeader title="基本信息" />
      <FieldRow label="描述">
        <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>
      <FieldRow label="分类">
        <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as NovelForeshadowCategory }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORESHADOW_CATEGORY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="状态" />
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as ForeshadowStatus }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORESHADOW_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="章节" />
      <FieldRow label="首次出现">
        <TextInput
          type="number"
          value={form.firstChapter}
          onChange={(e) => setForm((f) => ({ ...f, firstChapter: e.target.value }))}
        />
      </FieldRow>
      <FieldRow label="最后强化">
        <TextInput
          type="number"
          value={form.lastChapter}
          onChange={(e) => setForm((f) => ({ ...f, lastChapter: e.target.value }))}
        />
      </FieldRow>
      <FieldRow label="回收期限">
        <TextInput
          type="number"
          value={form.recoverByChapter}
          onChange={(e) => setForm((f) => ({ ...f, recoverByChapter: e.target.value }))}
        />
      </FieldRow>

      <SectionHeader title="关联" />
      <FieldRow label="关联角色">
        {linkedCharacters.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {linkedCharacters.map((id) => (
              <Badge key={id} variant="outline" className="text-[10px]">{id}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">暂无</span>
        )}
      </FieldRow>
      <FieldRow label="关联线索">
        {linkedClues.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {linkedClues.map((id) => (
              <Badge key={id} variant="outline" className="text-[10px]">{id}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">暂无</span>
        )}
      </FieldRow>
      <FieldRow label="⚡ 承载信息差">
        {linkedInfoLayerItems.length > 0 ? (
          <div className="space-y-1">
            {linkedInfoLayerItems.map((item) => {
              const desc = item.description.length > 16 ? `${item.description.slice(0, 16)}...` : item.description
              return (
                <div key={item.id} className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">{desc}</Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {item.readerKnows ? '读者已知' : '读者未知'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">暂无</span>
        )}
      </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 信息差编辑表单（P3-2） ──

function InfoLayerForm({ entity }: { entity: NovelInformationLayer }): ReactElement {
  const upsertInfoLayer = useNovelDataStore((s) => s.upsertInfoLayer)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)
  const [form, setForm] = useState({
    infoDescription: entity.infoDescription,
    authorKnows: entity.authorKnows ? 'true' : 'false',
    readerKnows: entity.readerKnows ? 'true' : 'false',
    revealStage: entity.revealStage ?? '',
    revealChapter: entity.revealChapter != null ? String(entity.revealChapter) : '',
    isRevealed: entity.isRevealed ? 'true' : 'false',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 解析 linkedForeshadows JSON，映射为带描述的展示项
  let linkedForeshadowIds: string[] = []
  try {
    const arr = JSON.parse(entity.linkedForeshadows)
    if (Array.isArray(arr)) linkedForeshadowIds = arr.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }
  const linkedForeshadowItems = linkedForeshadowIds.map((id) => {
    const f = foreshadows.find((x) => x.id === id)
    return {
      id,
      description: f?.description ?? id,
      status: f?.status ?? '',
    }
  })

  const toStrOrNull = (v: string): string | null => (v === '' ? null : v)
  const toNumOrNull = (v: string): number | null => (v === '' ? null : Number(v))

  const dirty =
    form.infoDescription !== entity.infoDescription ||
    (form.authorKnows === 'true') !== entity.authorKnows ||
    (form.readerKnows === 'true') !== entity.readerKnows ||
    (form.revealStage || '') !== (entity.revealStage ?? '') ||
    toNumOrNull(form.revealChapter) !== entity.revealChapter ||
    (form.isRevealed === 'true') !== entity.isRevealed

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateInfoLayer(entity.id, {
        infoDescription: form.infoDescription,
        authorKnows: form.authorKnows === 'true',
        readerKnows: form.readerKnows === 'true',
        revealStage: toStrOrNull(form.revealStage),
        revealChapter: toNumOrNull(form.revealChapter),
        isRevealed: form.isRevealed === 'true',
      })
      upsertInfoLayer(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertInfoLayer])

  return (
    <div className="space-y-2">
      <SectionHeader title="基本信息" />
      <FieldRow label="信息描述">
        <TextArea variant="medium" value={form.infoDescription} onChange={(e) => setForm((f) => ({ ...f, infoDescription: e.target.value }))} placeholder="例如：林墨的真实身世是前朝皇族后裔" />
      </FieldRow>

      <SectionHeader title="认知状态" hint="作者与读者对这条信息的掌握程度" />
      <FieldRow label="作者是否知晓">
        <Select value={form.authorKnows} onValueChange={(v) => setForm((f) => ({ ...f, authorKnows: v }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">是</SelectItem>
            <SelectItem value="false">否</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="读者是否知晓">
        <Select value={form.readerKnows} onValueChange={(v) => setForm((f) => ({ ...f, readerKnows: v }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">是</SelectItem>
            <SelectItem value="false">否</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="揭示" hint="信息差何时、以何种方式向读者揭示" />
      <FieldRow label="揭示阶段">
        <TextInput
          value={form.revealStage}
          onChange={(e) => setForm((f) => ({ ...f, revealStage: e.target.value }))}
          placeholder="如：setup / rising / climax，留空表示未指定"
        />
      </FieldRow>
      <FieldRow label="揭示章节">
        <TextInput
          type="number"
          min={1}
          value={form.revealChapter}
          onChange={(e) => setForm((f) => ({ ...f, revealChapter: e.target.value }))}
          placeholder="留空表示未指定"
        />
      </FieldRow>
      <FieldRow label="是否已揭示">
        <Select value={form.isRevealed} onValueChange={(v) => setForm((f) => ({ ...f, isRevealed: v }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">是</SelectItem>
            <SelectItem value="false">否</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="关联伏笔" hint="此信息差承载的伏笔列表（双向关联，由伏笔侧或矩阵视图管理）" />
      <FieldRow label="⚡ 承载伏笔">
        {linkedForeshadowItems.length > 0 ? (
          <div className="space-y-1">
            {linkedForeshadowItems.map((item) => {
              const desc = item.description.length > 16 ? `${item.description.slice(0, 16)}...` : item.description
              return (
                <div key={item.id} className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">{desc}</Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {item.status || '未设定'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">暂无</span>
        )}
      </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 势力编辑表单 ──

function FactionForm({ entity }: { entity: NovelFaction }): ReactElement {
  const upsertFaction = useNovelDataStore((s) => s.upsertFaction)
  const characters = useNovelDataStore((s) => s.characters)
  const factions = useNovelDataStore((s) => s.factions)
  const [form, setForm] = useState({
    name: entity.name,
    description: entity.description,
    type: entity.type,
    leaderId: entity.leaderId ?? '',
    ideology: entity.ideology,
    strength: entity.strength,
    status: entity.status,
    resourcesList: [...entity.resources],
    alliesList: [...entity.allies],
    enemiesList: [...entity.enemies],
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateResource = (idx: number, val: string) =>
    setForm((f) => ({ ...f, resourcesList: f.resourcesList.map((s, i) => (i === idx ? val : s)) }))
  const removeResource = (idx: number) =>
    setForm((f) => ({ ...f, resourcesList: f.resourcesList.filter((_, i) => i !== idx) }))
  const addResource = () =>
    setForm((f) => ({ ...f, resourcesList: [...f.resourcesList, ''] }))

  const addAlly = (id: string) => setForm((f) => ({ ...f, alliesList: [...f.alliesList, id] }))
  const removeAlly = (id: string) => setForm((f) => ({ ...f, alliesList: f.alliesList.filter((x) => x !== id) }))
  const addEnemy = (id: string) => setForm((f) => ({ ...f, enemiesList: [...f.enemiesList, id] }))
  const removeEnemy = (id: string) => setForm((f) => ({ ...f, enemiesList: f.enemiesList.filter((x) => x !== id) }))

  const dirty =
    form.name !== entity.name ||
    form.description !== entity.description ||
    form.type !== entity.type ||
    (entity.leaderId ?? '') !== form.leaderId ||
    form.ideology !== entity.ideology ||
    form.strength !== entity.strength ||
    form.status !== entity.status ||
    form.resourcesList.join('||') !== entity.resources.join('||') ||
    form.alliesList.join(',') !== entity.allies.join(',') ||
    form.enemiesList.join(',') !== entity.enemies.join(',')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateFaction(entity.id, {
        name: form.name,
        description: form.description,
        type: form.type,
        leaderId: form.leaderId || null,
        ideology: form.ideology,
        strength: form.strength,
        status: form.status,
        resources: form.resourcesList.filter((s) => s.trim()),
        allies: form.alliesList,
        enemies: form.enemiesList,
      })
      upsertFaction(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertFaction])

  return (
    <div className="space-y-2">
      <SectionHeader title="基础" />
      <FieldRow label="名称">
        <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </FieldRow>
      <FieldRow label="简述">
        <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>

      <SectionHeader title="属性" />
      <FieldRow label="类型">
        <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as NovelFactionType }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FACTION_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="实力">
        <Select value={form.strength} onValueChange={(v) => setForm((f) => ({ ...f, strength: v as NovelFactionStrength }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FACTION_STRENGTH_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as NovelFactionStatus }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FACTION_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="领导与理念" />
      <FieldRow label="首领角色">
        <Select value={form.leaderId || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, leaderId: v === '__none__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">无</SelectItem>
            {characters.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="理念 / 信仰">
        <TextArea variant="short" value={form.ideology} onChange={(e) => setForm((f) => ({ ...f, ideology: e.target.value }))} />
      </FieldRow>

      <SectionHeader title="资源与关系" />
      <FieldRow label="资源">
            <div className="space-y-2">
              {form.resourcesList.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="资源名称"
                    value={item}
                    onChange={(e) => updateResource(idx, e.target.value)}
                  />
                  <Button size="icon-sm" variant="ghost" onClick={() => removeResource(idx)} aria-label="删除">
                    <Trash2 className="size-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={addResource}>
                <Plus className="size-3.5 mr-1" /> 添加资源
              </Button>
            </div>
          </FieldRow>
          <FieldRow label="盟友势力">
            <div className="space-y-2">
              {form.alliesList.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {form.alliesList.map((id) => {
                    const fa = factions.find((x) => x.id === id)
                    return (
                      <Badge key={id} variant="outline" className="text-[10px] gap-1">
                        {fa?.name ?? id.slice(0, 8)}
                        <button
                          type="button"
                          onClick={() => removeAlly(id)}
                          className="hover:text-destructive"
                          aria-label="移除"
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    )
                  })}
                </div>
              )}
              <Select
                value=""
                onValueChange={(id) => {
                  if (id && id !== '__none__' && !form.alliesList.includes(id)) addAlly(id)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="添加盟友势力" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">无</SelectItem>
                  {factions
                    .filter((f) => f.id !== entity.id && !form.alliesList.includes(f.id))
                    .map((f) => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </FieldRow>
          <FieldRow label="敌对势力">
            <div className="space-y-2">
              {form.enemiesList.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {form.enemiesList.map((id) => {
                    const fe = factions.find((x) => x.id === id)
                    return (
                      <Badge key={id} variant="outline" className="text-[10px] gap-1">
                        {fe?.name ?? id.slice(0, 8)}
                        <button
                          type="button"
                          onClick={() => removeEnemy(id)}
                          className="hover:text-destructive"
                          aria-label="移除"
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    )
                  })}
                </div>
              )}
              <Select
                value=""
                onValueChange={(id) => {
                  if (id && id !== '__none__' && !form.enemiesList.includes(id)) addEnemy(id)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="添加敌对势力" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">无</SelectItem>
                  {factions
                    .filter((f) => f.id !== entity.id && !form.enemiesList.includes(f.id))
                    .map((f) => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 地点编辑表单 ──

function LocationForm({ entity }: { entity: NovelLocation }): ReactElement {
  const upsertLocation = useNovelDataStore((s) => s.upsertLocation)
  const locations = useNovelDataStore((s) => s.locations)
  const factions = useNovelDataStore((s) => s.factions)
  const [form, setForm] = useState({
    name: entity.name,
    description: entity.description,
    type: entity.type,
    parentId: entity.parentId ?? '',
    factionId: entity.factionId ?? '',
    significance: entity.significance,
    firstChapter: entity.firstChapter != null ? String(entity.firstChapter) : '',
    status: entity.status,
    appearChapters: [...(entity.appearChapters ?? [])],
  })
  const [appearChapterInput, setAppearChapterInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addAppearChapter = () => {
    const n = Number(appearChapterInput)
    if (!appearChapterInput || Number.isNaN(n)) return
    setForm((f) => {
      if (f.appearChapters.includes(n)) return f
      return { ...f, appearChapters: [...f.appearChapters, n].sort((a, b) => a - b) }
    })
    setAppearChapterInput('')
  }

  const removeAppearChapter = (n: number) => {
    setForm((f) => ({ ...f, appearChapters: f.appearChapters.filter((x) => x !== n) }))
  }

  const toNumOrNull = (v: string): number | null => (v === '' ? null : Number(v))

  const dirty =
    form.name !== entity.name ||
    form.description !== entity.description ||
    form.type !== entity.type ||
    (entity.parentId ?? '') !== form.parentId ||
    (entity.factionId ?? '') !== form.factionId ||
    form.significance !== entity.significance ||
    toNumOrNull(form.firstChapter) !== entity.firstChapter ||
    form.status !== entity.status ||
    form.appearChapters.join(',') !== (entity.appearChapters ?? []).join(',')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateLocation(entity.id, {
        name: form.name,
        description: form.description,
        type: form.type,
        parentId: form.parentId || null,
        factionId: form.factionId || null,
        significance: form.significance,
        firstChapter: toNumOrNull(form.firstChapter),
        status: form.status,
        appearChapters: form.appearChapters,
      })
      upsertLocation(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertLocation])

  return (
    <div className="space-y-3">
      <SectionHeader title="基础" />
      <FieldRow label="名称">
        <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </FieldRow>
      <FieldRow label="简述">
        <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>

      <SectionHeader title="属性" />
      <FieldRow label="类型">
            <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as NovelLocationType }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATION_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="重要程度">
            <Select value={form.significance} onValueChange={(v) => setForm((f) => ({ ...f, significance: v as NovelLocationSignificance }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATION_SIGNIFICANCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="状态">
            <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as NovelLocationStatus }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATION_STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

      <SectionHeader title="关联" />
      <FieldRow label="父级地点">
            <Select value={form.parentId || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, parentId: v === '__none__' ? '' : v }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">无</SelectItem>
                {locations.filter((l) => l.id !== entity.id).map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="归属势力">
            <Select value={form.factionId || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, factionId: v === '__none__' ? '' : v }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">无</SelectItem>
                {factions.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

      <SectionHeader title="章节出场" />
      <FieldRow label="首次出现章节">
            <TextInput
              type="number"
              value={form.firstChapter}
              onChange={(e) => setForm((f) => ({ ...f, firstChapter: e.target.value }))}
              placeholder="章节号（可留空）"
            />
          </FieldRow>
          <FieldRow label="出场章节">
            <div className="flex gap-2">
              <TextInput
                type="number"
                value={appearChapterInput}
                onChange={(e) => setAppearChapterInput(e.target.value)}
                placeholder="章节号"
              />
              <Button size="sm" variant="outline" onClick={addAppearChapter}>
                <Plus className="size-3" />
                添加
              </Button>
            </div>
            {form.appearChapters.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {form.appearChapters.map((n) => (
                  <Badge key={n} variant="outline" className="text-[10px] gap-1">
                    第 {n} 章
                    <button
                      type="button"
                      onClick={() => removeAppearChapter(n)}
                      className="ml-0.5 hover:text-destructive"
                      aria-label={`移除第 ${n} 章`}
                    >
                      <X className="size-2.5" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-[11px] text-muted-foreground">暂无出场章节</span>
            )}
          </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 世界观要素编辑表单 ──

function WorldElementForm({ entity }: { entity: NovelWorldElement }): ReactElement {
  const upsertWorldElement = useNovelDataStore((s) => s.upsertWorldElement)
  const worldElements = useNovelDataStore((s) => s.worldElements)
  const [form, setForm] = useState({
    category: entity.category,
    name: entity.name,
    description: entity.description,
    parentId: entity.parentId ?? '',
    attributesList: Object.entries(entity.attributes ?? {}).map(([k, v]) => ({ key: k, value: String(v) })),
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateAttr = (idx: number, patch: Partial<{ key: string; value: string }>) =>
    setForm((f) => ({ ...f, attributesList: f.attributesList.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }))
  const removeAttr = (idx: number) =>
    setForm((f) => ({ ...f, attributesList: f.attributesList.filter((_, i) => i !== idx) }))
  const addAttr = () =>
    setForm((f) => ({ ...f, attributesList: [...f.attributesList, { key: '', value: '' }] }))

  const origAttributesSig = Object.entries(entity.attributes ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('||')
  const currentAttributesSig = form.attributesList
    .map(({ key, value }) => `${key}=${value}`)
    .join('||')

  const dirty =
    form.category !== entity.category ||
    form.name !== entity.name ||
    form.description !== entity.description ||
    (entity.parentId ?? '') !== form.parentId ||
    currentAttributesSig !== origAttributesSig

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const obj: Record<string, unknown> = {}
      form.attributesList.forEach(({ key, value }) => {
        if (key.trim()) obj[key.trim()] = value
      })
      const updated = await updateWorldElement(entity.id, {
        category: form.category,
        name: form.name,
        description: form.description,
        parentId: form.parentId || null,
        attributes: obj,
      })
      upsertWorldElement(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertWorldElement])

  return (
    <div className="space-y-3">
      <SectionHeader title="基础" />
      <FieldRow label="分类">
        <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as NovelWorldElementCategory }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORLD_ELEMENT_CATEGORY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="名称">
        <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </FieldRow>

      <SectionHeader title="描述" />
      <FieldRow label="描述">
        <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>

      <SectionHeader title="父级" />
      <FieldRow label="父级要素">
        <Select value={form.parentId || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, parentId: v === '__none__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">无</SelectItem>
            {worldElements.filter((w) => w.id !== entity.id).map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="属性" />
      <FieldRow label="附加属性">
        <div className="space-y-2">
          {form.attributesList.map((item, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                className="flex-1 font-mono text-xs"
                placeholder="属性名"
                value={item.key}
                onChange={(e) => updateAttr(idx, { key: e.target.value })}
              />
              <Input
                className="flex-1 text-xs"
                placeholder="属性值"
                value={item.value}
                onChange={(e) => updateAttr(idx, { value: e.target.value })}
              />
              <Button size="icon-sm" variant="ghost" onClick={() => removeAttr(idx)} aria-label="删除">
                <Trash2 className="size-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={addAttr}>
            <Plus className="size-3.5 mr-1" /> 添加属性
          </Button>
        </div>
      </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
