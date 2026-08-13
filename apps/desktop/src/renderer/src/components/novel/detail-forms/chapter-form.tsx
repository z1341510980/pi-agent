import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  publishChapter,
  updateVolume,
  type ChapterRhythm,
  type ChapterStatus,
  type NovelChapter,
  type NovelVolume,
} from '@/api/novel-client'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import {
  CHAPTER_RHYTHM_OPTIONS,
  DebouncedOutlineField,
  FieldRow,
  SaveButton,
  SectionHeader,
  TextInput,
} from './shared'
import { CHAPTER_STATUS_TRANSITIONS } from '@repo/shared/novel'

const CHAPTER_STATUS_LABELS: Record<ChapterStatus, string> = {
  planned: '已规划',
  drafting: '草稿中',
  review: '审核中',
  published: '已发布',
  rejected: '已驳回',
}

// ── 章节表单 ──

export function ChapterForm({ entity }: { entity: NovelChapter }): ReactElement {
  const upsertChapter = useNovelDataStore((s) => s.upsertChapter)
  const [form, setForm] = useState({
    title: entity.title,
    status: entity.status,
    rhythm: entity.rhythm ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const statusOptions = CHAPTER_STATUS_TRANSITIONS[entity.status]

  useEffect(() => {
    setForm({
      title: entity.title,
      status: entity.status,
      rhythm: entity.rhythm ?? '',
    })
  }, [entity.id, entity.title, entity.status, entity.rhythm])

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

  const handlePublish = useCallback(async () => {
    if (publishing || entity.status !== 'review') return
    if (!window.confirm('确认发布本章？发布后当前没有撤回或直接修订命令。')) return
    setPublishing(true)
    setError(null)
    try {
      const updated = await publishChapter(entity.id)
      upsertChapter(updated)
      toastSuccess('章节已发布', `第 ${updated.chapterNumber} 章已进入正式时间线`)
    } catch (err) {
      const message = err instanceof Error ? err.message : '发布失败'
      setError(message)
      toastError('发布失败', message)
    } finally {
      setPublishing(false)
    }
  }, [entity.id, entity.status, publishing, upsertChapter])

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
            {statusOptions.map((status) => (
              <SelectItem key={status} value={status}>{CHAPTER_STATUS_LABELS[status]}</SelectItem>
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
      {entity.status === 'review' && (
        <Button
          type="button"
          size="sm"
          className="w-full"
          onClick={() => void handlePublish()}
          disabled={publishing || saving || dirty}
          title={dirty ? '请先保存章节元信息' : '发布已通过当前版本审稿的章节'}
        >
          <Send className="size-3.5" />
          {publishing ? '发布中...' : '发布章节'}
        </Button>
      )}
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
