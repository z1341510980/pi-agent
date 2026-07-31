import { useCallback, useState, type ReactElement } from 'react'
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
  FieldRow,
  FORESHADOW_CATEGORY_OPTIONS,
  FORESHADOW_STATUS_OPTIONS,
  SaveButton,
  SectionHeader,
  TextArea,
  TextInput,
} from './shared'

// ── 伏笔编辑表单 ──

export function ForeshadowForm({ entity }: { entity: NovelForeshadow }): ReactElement {
  const upsertForeshadow = useNovelDataStore((s) => s.upsertForeshadow)
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

      <SectionHeader title="章节" hint="「埋设 / 最后节点」是已发生的事实；「计划回收章」是意图" />
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

      {/* 计划回收章单独分区：它与上面两个字段性质不同 ——
          上面记录"已经发生了什么"，这里声明"打算什么时候还"。
          三个裸数字输入框并排时用户分不清哪个是事实、哪个是计划，
          矩阵里那根跨度线也因此含义模糊（已回收 vs 欠着）。 */}
      <SectionHeader title="回收计划" hint="意图，非事实。矩阵中显示为虚线 + 空心终点" />
      <FieldRow label="计划回收章">
        <TextInput
          type="number"
          value={form.recoverByChapter}
          onChange={(e) => setForm((f) => ({ ...f, recoverByChapter: e.target.value }))}
        />
      </FieldRow>
      <FieldRow label="当前状态">
        {actualPayoffChapter != null ? (
          <span className="text-micro text-success">
            已在第 {actualPayoffChapter} 章回收（事实）
          </span>
        ) : form.recoverByChapter ? (
          <span className="text-micro text-amber-600 dark:text-amber-400">
            尚未回收，计划第 {form.recoverByChapter} 章前兑现
          </span>
        ) : (
          <span className="text-micro text-muted-foreground">尚未回收，也未设定计划</span>
        )}
      </FieldRow>

      <SectionHeader title="事件链" />
      <FieldRow label="实际节点">
        {beats.length > 0 ? (
          <div className="space-y-1.5">
            {beats.map((beat) => (
              <div key={`${beat.chapter}-${beat.type}`} className="rounded border border-border px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-nano tabular-nums">第 {beat.chapter} 章</Badge>
                  <span className="text-micro font-medium">{beatLabels[beat.type]}</span>
                </div>
                {beat.note && <p className="mt-1 text-nano leading-relaxed text-muted-foreground">{beat.note}</p>}
              </div>
            ))}
          </div>
        ) : (
          <span className="text-micro text-muted-foreground">尚未埋设</span>
        )}
      </FieldRow>

      {/* 「关联」分区（关联角色 / 关联线索 / ⚡ 承载信息差）已整体移除：
          这三项数据已迁移至 edges 表，伏笔实体上不再有 linkedCharacters /
          linkedClues / linkedInfoLayerIds 字段，此前用空数组占位导致三行恒显示「暂无」。
          需要时应通过 edges 查询（按 foreshadowId 反查关联边）实现，而不是留空占位。
          分区内已无其它字段，故 SectionHeader 一并删除。 */}

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
