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
  const beats = entity.beats && entity.beats.length > 0
    ? [...entity.beats].sort((a, b) => a.chapter - b.chapter)
    : [
        ...(entity.firstChapter != null ? [{ chapter: entity.firstChapter, type: 'plant' as const }] : []),
        ...(entity.recoverByChapter != null ? [{ chapter: entity.recoverByChapter, type: 'payoff' as const }] : []),
      ]
  const beatLabels = {
    plant: '埋设',
    reinforce: '强化',
    reveal: '部分揭示',
    payoff: '回收',
  } as const

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
      <FieldRow label="回收章节">
        <TextInput
          type="number"
          value={form.recoverByChapter}
          onChange={(e) => setForm((f) => ({ ...f, recoverByChapter: e.target.value }))}
        />
      </FieldRow>

      <SectionHeader title="事件链" />
      <FieldRow label="实际节点">
        {beats.length > 0 ? (
          <div className="space-y-1.5">
            {beats.map((beat) => (
              <div key={`${beat.chapter}-${beat.type}`} className="rounded border border-border px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] tabular-nums">第 {beat.chapter} 章</Badge>
                  <span className="text-[11px] font-medium">{beatLabels[beat.type]}</span>
                </div>
                {beat.note && <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{beat.note}</p>}
              </div>
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">尚未埋设</span>
        )}
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
