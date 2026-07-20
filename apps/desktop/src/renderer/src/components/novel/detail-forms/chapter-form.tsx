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
  updateChapter,
  updateVolume,
  type ChapterRhythm,
  type ChapterStatus,
  type NovelChapter,
  type NovelVolume,
} from '@/api/novel-client'
import {
  CHAPTER_RHYTHM_OPTIONS,
  CHAPTER_STATUS_OPTIONS,
  DebouncedOutlineField,
  FieldRow,
  SaveButton,
  SectionHeader,
  TextInput,
} from './shared'

// ── 章节表单 ──

export function ChapterForm({ entity }: { entity: NovelChapter }): ReactElement {
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

export function VolumeForm({ entity }: { entity: NovelVolume }): ReactElement {
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
