import { useCallback, useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  updateWorldElement,
  type NovelWorldElement,
  type NovelWorldElementCategory,
} from '@/api/novel-client'
import {
  FieldRow,
  SaveButton,
  SectionHeader,
  TextArea,
  TextInput,
  WORLD_ELEMENT_CATEGORY_OPTIONS,
} from './shared'

// ── 世界观要素编辑表单 ──

export function WorldElementForm({ entity }: { entity: NovelWorldElement }): ReactElement {
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
