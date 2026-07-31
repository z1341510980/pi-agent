import { useCallback, useState, type ReactElement } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  updateFaction,
  type NovelFaction,
  type NovelFactionStatus,
  type NovelFactionStrength,
  type NovelFactionType,
} from '@/api/novel-client'
import {
  FACTION_STATUS_OPTIONS,
  FACTION_STRENGTH_OPTIONS,
  FACTION_TYPE_OPTIONS,
  FieldRow,
  SaveButton,
  SectionHeader,
  TextArea,
  TextInput,
} from './shared'

// ── 势力编辑表单 ──

export function FactionForm({ entity }: { entity: NovelFaction }): ReactElement {
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
                      <Badge key={id} variant="outline" className="text-nano gap-1">
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
                      <Badge key={id} variant="outline" className="text-nano gap-1">
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
