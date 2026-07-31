import { useCallback, useState, type ReactElement } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  updateLocation,
  type NovelLocation,
  type NovelLocationSignificance,
  type NovelLocationStatus,
  type NovelLocationType,
} from '@/api/novel-client'
import {
  FieldRow,
  LOCATION_SIGNIFICANCE_OPTIONS,
  LOCATION_STATUS_OPTIONS,
  LOCATION_TYPE_OPTIONS,
  SaveButton,
  SectionHeader,
  TextArea,
  TextInput,
} from './shared'

// ── 地点编辑表单 ──

export function LocationForm({ entity }: { entity: NovelLocation }): ReactElement {
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
                  <Badge key={n} variant="outline" className="text-nano gap-1">
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
              <span className="text-micro text-muted-foreground">暂无出场章节</span>
            )}
          </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
