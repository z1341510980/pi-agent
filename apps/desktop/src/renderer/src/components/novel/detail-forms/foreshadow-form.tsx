import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { CalendarClock, Info, Link2, ListTree, Target } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  updateForeshadow,
  type ForeshadowStatus,
  type NovelForeshadow,
  type NovelForeshadowCategory,
} from '@/api/novel-client'
import {
  CHARACTER_PLOT_ROLE_OPTIONS,
  FieldRow,
  FORESHADOW_CATEGORY_OPTIONS,
  FORESHADOW_STATUS_OPTIONS,
  FormSection,
  SaveButton,
  TextArea,
  TextInput,
} from './shared'
import { EdgeRelationField } from './edge-relation-field'

// ── 伏笔编辑表单 ──

export function ForeshadowForm({ entity }: { entity: NovelForeshadow }): ReactElement {
  const upsertForeshadow = useNovelDataStore((s) => s.upsertForeshadow)
  const characters = useNovelDataStore((s) => s.characters)
  const clues = useNovelDataStore((s) => s.clues)
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
  // 事件链只展示已发生的节点。
  // ⚠️ 不从 recoverByChapter 合成 payoff：它是"计划回收章"（意图），不是已回收的事实。
  const beats = entity.beats && entity.beats.length > 0
    ? [...entity.beats].sort((a, b) => a.chapter - b.chapter)
    : [
        ...(entity.firstChapter != null ? [{ chapter: entity.firstChapter, type: 'plant' as const }] : []),
      ]
  const beatLabels = {
    plant: '埋设',
    reinforce: '强化',
    reveal: '部分揭示',
    payoff: '回收',
  } as const

  /**
   * 实际回收章：只认 beats 里真实存在的 payoff 节点。
   *
   * 不能用 `recoverByChapter` 兜底 —— 那是计划回收章（意图），
   * 用它当"已回收"会让一条还欠着的伏笔显示成已完成。
   */
  const actualPayoffChapter = beats.find((b) => b.type === 'payoff')?.chapter ?? null

  // 关联候选：此前「关联」整个分区被删掉并留注释说需通过 edges 实现，现在补上
  const characterOptions = useMemo(
    () =>
      characters.map((c) => ({
        id: c.id,
        label: c.name,
        hint: CHARACTER_PLOT_ROLE_OPTIONS.find((o) => o.value === c.plotRole)?.label,
      })),
    [characters],
  )
  const clueOptions = useMemo(
    () =>
      clues.map((c) => ({
        id: c.id,
        label: c.description.length > 30 ? `${c.description.slice(0, 30)}…` : c.description,
        hint: c.pointsTo ? `指向 ${c.pointsTo.slice(0, 12)}` : undefined,
      })),
    [clues],
  )

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
    <div className="space-y-2.5">
      <FormSection title="基本信息" icon={<Info className="size-3.5" />} collapsible={false}>
        <FieldRow label="描述">
          <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </FieldRow>
        <div className="grid grid-cols-2 gap-2.5">
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
        </div>
      </FormSection>

      {/* 事实与意图分成两个分区：这是本表单最容易混淆的一处 ——
          「埋设/最后节点」记录已经发生了什么，「计划回收章」声明打算什么时候还。
          三个裸数字输入框并排时用户分不清哪个是事实、哪个是计划。 */}
      <FormSection
        title="已发生节点"
        hint="事实"
        icon={<ListTree className="size-3.5" />}
        collapsible={false}
      >
        <div className="grid grid-cols-2 gap-2.5">
          <FieldRow label="埋设章节">
            <TextInput
              type="number"
              value={form.firstChapter}
              onChange={(e) => setForm((f) => ({ ...f, firstChapter: e.target.value }))}
            />
          </FieldRow>
          <FieldRow label="最后节点">
            <TextInput
              type="number"
              value={form.lastChapter}
              onChange={(e) => setForm((f) => ({ ...f, lastChapter: e.target.value }))}
            />
          </FieldRow>
        </div>
        {/* 事件链改为时间线样式：原本是一叠边框卡片，看不出节点间的先后关系 */}
        {beats.length > 0 ? (
          <ol className="space-y-0">
            {beats.map((beat, idx) => (
              <li key={`${beat.chapter}-${beat.type}`} className="relative flex gap-2.5 pb-2 last:pb-0">
                {/* 连线：最后一个节点不画，否则线会悬空 */}
                {idx < beats.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute left-[3px] top-3 bottom-0 w-px bg-border"
                  />
                )}
                <span
                  aria-hidden
                  className={
                    beat.type === 'payoff'
                      ? 'mt-1.5 size-[7px] shrink-0 rounded-full bg-success'
                      : beat.type === 'plant'
                        ? 'mt-1.5 size-[7px] shrink-0 rounded-full border-[1.5px] border-amber-500 bg-surface-1'
                        : 'mt-1.5 size-[7px] shrink-0 rounded-full bg-amber-500/60'
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-text">{beatLabels[beat.type]}</span>
                    <Badge variant="outline" className="h-4 px-1 text-nano tabular-nums">
                      第 {beat.chapter} 章
                    </Badge>
                  </div>
                  {beat.note && (
                    <p className="mt-0.5 text-nano leading-relaxed text-muted-foreground">{beat.note}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-micro text-muted-foreground">尚未埋设</p>
        )}
      </FormSection>

      <FormSection
        title="回收计划"
        hint="意图 · 矩阵中为虚线 + 空心终点"
        icon={<CalendarClock className="size-3.5" />}
        collapsible={false}
      >
        <FieldRow label="计划回收章">
          <TextInput
            type="number"
            value={form.recoverByChapter}
            onChange={(e) => setForm((f) => ({ ...f, recoverByChapter: e.target.value }))}
            placeholder="未设定"
          />
        </FieldRow>
        {/* 状态解读放在这里而不是「状态」下拉旁：那个下拉是可编辑字段，
            这里是从 beats 推导的事实，两者性质不同 */}
        <div
          className={
            actualPayoffChapter != null
              ? 'rounded-md bg-success/8 px-2.5 py-1.5 text-nano leading-relaxed text-success'
              : form.recoverByChapter
                ? 'rounded-md bg-amber-500/8 px-2.5 py-1.5 text-nano leading-relaxed text-amber-600 dark:text-amber-400'
                : 'rounded-md bg-surface-2/60 px-2.5 py-1.5 text-nano leading-relaxed text-muted-foreground'
          }
        >
          {actualPayoffChapter != null
            ? `已在第 ${actualPayoffChapter} 章回收（事实）`
            : form.recoverByChapter
              ? `尚未回收，计划第 ${form.recoverByChapter} 章前兑现`
              : '尚未回收，也未设定计划'}
        </div>
      </FormSection>

      {/* 「关联」分区曾被整体移除（数据迁到 edges 后表单侧没跟上，
          留注释说"需要时应通过 edges 查询实现"）。现在通过 EdgeRelationField 真正实现。 */}
      <FormSection title="关联" hint="即时生效" icon={<Link2 className="size-3.5" />}>
        <FieldRow label="关联角色" hint="勾选即生效，无需保存">
          <EdgeRelationField
            entityId={entity.id}
            entityType="foreshadow"
            targetType="character"
            edgeType="related"
            options={characterOptions}
            placeholder="关联与此伏笔相关的角色"
            searchPlaceholder="搜索角色…"
            emptyHint="本项目还没有角色"
          />
        </FieldRow>
        <FieldRow label="关联线索" hint="线索是伏笔的可见证据">
          <EdgeRelationField
            entityId={entity.id}
            entityType="foreshadow"
            targetType="clue"
            edgeType="related"
            side="target"
            options={clueOptions}
            placeholder="关联指向此伏笔的线索"
            searchPlaceholder="搜索线索…"
            emptyHint="本项目还没有线索"
          />
        </FieldRow>
      </FormSection>

      <FormSection title="埋设与回收手法" icon={<Target className="size-3.5" />} defaultCollapsed>
        <FieldRow label="埋设手法">
          <p className="text-micro text-muted-foreground">
            {entity.plantMethod === 'explicit' ? '显性（直接写出）'
              : entity.plantMethod === 'implicit' ? '隐性（暗示）'
              : '未指定'}
          </p>
        </FieldRow>
        <FieldRow label="回收手法">
          <p className="text-micro text-muted-foreground">
            {entity.recoverMethod === 'explicit' ? '显性（明确揭示）'
              : entity.recoverMethod === 'implicit' ? '隐性（留白）'
              : '未指定'}
          </p>
        </FieldRow>
      </FormSection>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
