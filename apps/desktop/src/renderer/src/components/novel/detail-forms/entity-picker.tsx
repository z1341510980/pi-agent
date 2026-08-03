import { useMemo, useState, type ReactElement } from 'react'
import { Check, ChevronsUpDown, Plus, Search, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * EntityPicker —— 实体关联选择器。
 *
 * ## 为什么需要
 *
 * 关联字段此前有两种实现，都不可用：
 *
 * 1. **手输文本列表**（`conflict.participants` 用 `StringListEditor`）。
 *    但这个字段存的是**角色 ID**：`matrix-model` 反查时用
 *    `characterNameById.get(characterId)`，后端 `chapter-finalizer` 也按
 *    `parseIdList` 当 ID 处理。用户手输的名字永远匹配不上，于是矩阵里显示原始
 *    字符串、Agent 拿不到真实关联 —— 这不是样式问题，是功能错的。
 * 2. **只读空占位**（`info-layer-form` 的「承载伏笔」）。数据已迁到 edges 表，
 *    表单侧写死空数组，永远显示「暂无」。
 *
 * 这个组件替代两者：搜索 + 多选下拉，选中项以可删除 Badge 展示，
 * 值始终是实体 ID，显示始终是实体名。
 *
 * ## 交互取舍
 *
 * - **不用原生 `<select multiple>`**：它在长列表下不可搜索，且无法展示富信息
 *   （角色的层级、伏笔的状态）。
 * - **搜索框自动聚焦**：关联操作的第一动作几乎总是搜索，少一次点击。
 * - **选中后不关闭浮层**：多选场景下每选一个就关一次是明显的干扰。
 * - **Badge 上的删除按钮**：不必展开下拉就能取消关联，这是最常用的撤销路径。
 */

export interface EntityOption {
  id: string
  /** 主标签 */
  label: string
  /** 次要说明（角色层级 / 伏笔状态等），用于在长列表里区分同名项 */
  hint?: string
}

export interface EntityPickerProps {
  /** 候选实体 */
  options: EntityOption[]
  /** 已选实体 ID */
  value: string[]
  onChange: (next: string[]) => void
  /** 无选中时的按钮文案 */
  placeholder?: string
  /** 搜索框占位文案 */
  searchPlaceholder?: string
  /** 候选为空时的说明（如「本项目还没有角色」） */
  emptyHint?: string
  /** 单选模式：选中后替换而非追加，并自动关闭浮层 */
  single?: boolean
  disabled?: boolean
}

export function EntityPicker({
  options,
  value,
  onChange,
  placeholder = '添加关联…',
  searchPlaceholder = '搜索…',
  emptyHint = '暂无可选项',
  single = false,
  disabled = false,
}: EntityPickerProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  const optionById = useMemo(
    () => new Map(options.map((o) => [o.id, o])),
    [options],
  )

  // 已选项按 value 顺序展示（用户添加顺序有意义，不重排）
  const selected = useMemo(
    () => value.map((id) => optionById.get(id) ?? { id, label: id, hint: '已失效' }),
    [value, optionById],
  )

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return options
    return options.filter(
      (o) => o.label.toLowerCase().includes(kw) || o.hint?.toLowerCase().includes(kw),
    )
  }, [options, keyword])

  const toggle = (id: string): void => {
    if (single) {
      onChange([id])
      setOpen(false)
      return
    }
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  return (
    <div className="space-y-1.5">
      {/* 已选：可直接删除，不必展开下拉 */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((item) => (
            <Badge
              key={item.id}
              variant="secondary"
              className="group/tag gap-1 pr-1 pl-2 font-normal"
            >
              <span className="truncate max-w-[140px]">{item.label}</span>
              {/* 失效项（引用的实体已删除）需要显式标出，否则用户不知道为何矩阵里对不上 */}
              {item.hint === '已失效' && (
                <span className="text-nano text-destructive">失效</span>
              )}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(value.filter((x) => x !== item.id))}
                  className="rounded-sm p-0.5 text-muted-foreground opacity-60 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/tag:opacity-100"
                  aria-label={`移除 ${item.label}`}
                >
                  <X className="size-2.5" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            className={cn(
              'h-8 w-full justify-between font-normal',
              selected.length === 0 && 'text-muted-foreground',
            )}
          >
            <span className="flex items-center gap-1.5 truncate">
              {selected.length === 0 ? (
                <>
                  <Plus className="size-3.5 shrink-0" />
                  {placeholder}
                </>
              ) : (
                <>
                  <Plus className="size-3.5 shrink-0" />
                  继续添加
                  <span className="text-nano text-muted-foreground tabular-nums">
                    已选 {selected.length}
                  </span>
                </>
              )}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          {/* 搜索：关联操作的第一动作几乎总是搜索，直接聚焦省一次点击 */}
          <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-6 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
            />
            {keyword && (
              <button
                type="button"
                onClick={() => setKeyword('')}
                className="rounded p-0.5 text-muted-foreground hover:text-text"
                aria-label="清除搜索"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <div className="max-h-56 overflow-y-auto p-1" role="listbox" aria-multiselectable={!single}>
            {options.length === 0 ? (
              <p className="px-2 py-6 text-center text-micro text-muted-foreground">{emptyHint}</p>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-micro text-muted-foreground">
                没有匹配「{keyword}」的项
              </p>
            ) : (
              filtered.map((option) => {
                const checked = value.includes(option.id)
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggle(option.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                      'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                      checked && 'bg-accent/40',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors',
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border',
                      )}
                    >
                      {checked && <Check className="size-2.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint && (
                      <span className="shrink-0 text-nano text-muted-foreground">{option.hint}</span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
