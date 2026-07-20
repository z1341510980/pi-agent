import { useCallback, useState, type ReactElement } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  updateItem,
  type NovelItem,
  type NovelItemStatus,
  type NovelItemType,
} from '@/api/novel-client'
import {
  FieldRow,
  ITEM_STATUS_OPTIONS,
  ITEM_TYPE_OPTIONS,
  SaveButton,
  SectionHeader,
  TextArea,
  TextInput,
} from './shared'

// ── 物品编辑表单 ──

export function ItemForm({ entity }: { entity: NovelItem }): ReactElement {
  const upsertItem = useNovelDataStore((s) => s.upsertItem)
  const characters = useNovelDataStore((s) => s.characters)
  const [form, setForm] = useState({
    name: entity.name,
    description: entity.description,
    type: entity.type,
    ownerId: entity.ownerId ?? '',
    status: entity.status,
    abilities: entity.abilities,
    origin: entity.origin,
    firstChapter: entity.firstChapter != null ? String(entity.firstChapter) : '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toNumOrNull = (v: string): number | null => (v === '' ? null : Number(v))

  const dirty =
    form.name !== entity.name ||
    form.description !== entity.description ||
    form.type !== entity.type ||
    (entity.ownerId ?? '') !== form.ownerId ||
    form.status !== entity.status ||
    form.abilities !== entity.abilities ||
    form.origin !== entity.origin ||
    toNumOrNull(form.firstChapter) !== entity.firstChapter

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateItem(entity.id, {
        name: form.name,
        description: form.description,
        type: form.type,
        ownerId: form.ownerId || null,
        status: form.status,
        abilities: form.abilities,
        origin: form.origin,
        firstChapter: toNumOrNull(form.firstChapter),
      })
      upsertItem(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertItem])

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
        <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as NovelItemType }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ITEM_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as NovelItemStatus }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ITEM_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="能力/效果">
        <TextArea variant="medium" value={form.abilities} onChange={(e) => setForm((f) => ({ ...f, abilities: e.target.value }))} placeholder="法器/武器/防具的具体效果" />
      </FieldRow>
      <FieldRow label="来源">
        <TextArea variant="short" value={form.origin} onChange={(e) => setForm((f) => ({ ...f, origin: e.target.value }))} placeholder="哪章获得/怎么获得的" />
      </FieldRow>

      <SectionHeader title="归属" />
      <FieldRow label="持有者">
        <Select value={form.ownerId || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, ownerId: v === '__none__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">无主</SelectItem>
            {characters.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
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

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
