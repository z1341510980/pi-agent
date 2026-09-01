import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
import {
  ChapterOutlineEditor,
  type AppliedChapterOutlineGeneration,
} from './chapter-outline-editor'

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
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    title: entity.title,
    status: entity.status,
    rhythm: entity.rhythm ?? '',
  })
  const [outlineDraft, setOutlineDraft] = useState(entity.outline ?? '')
  const [appliedOutlineGeneration, setAppliedOutlineGeneration] =
    useState<AppliedChapterOutlineGeneration | null>(null)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outlineSaveError, setOutlineSaveError] = useState<string | null>(null)
  const statusOptions = CHAPTER_STATUS_TRANSITIONS[entity.status]

  // 章纲草稿的「已同步基准」：effect 回写只在草稿与基准一致（用户无未保存修改）时执行，
  // 防止后台对账 / 创作流程回写把正在编辑的章纲静默覆盖。
  const syncedOutlineRef = useRef(entity.outline ?? '')
  const prevChapterIdRef = useRef(entity.id)

  useEffect(() => {
    const switchedChapter = prevChapterIdRef.current !== entity.id
    prevChapterIdRef.current = entity.id
    setForm({
      title: entity.title,
      status: entity.status,
      rhythm: entity.rhythm ?? '',
    })
    setOutlineDraft((prev) =>
      switchedChapter || prev === syncedOutlineRef.current ? (entity.outline ?? '') : prev,
    )
    syncedOutlineRef.current = entity.outline ?? ''
    setAppliedOutlineGeneration(null)
    setOutlineSaveError(null)
  }, [entity.id, entity.title, entity.status, entity.rhythm, entity.outline])

  const dirty =
    form.title !== entity.title ||
    form.status !== entity.status ||
    (form.rhythm || '') !== (entity.rhythm ?? '') ||
    outlineDraft !== (entity.outline ?? '')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    setOutlineSaveError(null)
    const outlineChanged = outlineDraft !== (entity.outline ?? '')
    try {
      const updated = await updateChapter(entity.id, {
        title: form.title,
        status: form.status,
        rhythm: form.rhythm === '' ? undefined : (form.rhythm as ChapterRhythm),
        ...(outlineChanged
          ? {
              outline: outlineDraft,
              ...(appliedOutlineGeneration
                ? {
                    expectedOutlineHash: appliedOutlineGeneration.outlineHash,
                    expectedContentRevisionId: appliedOutlineGeneration.contentRevisionId,
                    outlineGenerationId: appliedOutlineGeneration.generationId,
                  }
                : {}),
            }
          : {}),
      })
      setAppliedOutlineGeneration(null)
      upsertChapter(updated)
      // 与新建章/卷的惯例对齐：保存成功后失效项目数据缓存，
      // 避免后台 refetch 用缓存里的旧 outline 对账覆盖，导致大纲树回退旧值
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', entity.projectId] })
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败'
      if (outlineChanged) setOutlineSaveError(message)
      else setError(message)
    } finally {
      setSaving(false)
    }
  }, [appliedOutlineGeneration, entity.id, entity.outline, entity.projectId, form, outlineDraft, queryClient, upsertChapter])

  const handlePublish = useCallback(async () => {
    if (publishing || entity.status !== 'review') return
    if (!window.confirm('确认发布本章？发布后当前没有撤回或直接修订命令。')) return
    setPublishing(true)
    setError(null)
    try {
      const updated = await publishChapter(entity.id)
      upsertChapter(updated)
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', entity.projectId] })
      toastSuccess('章节已发布', `第 ${updated.chapterNumber} 章已进入正式时间线`)
    } catch (err) {
      const message = err instanceof Error ? err.message : '发布失败'
      setError(message)
      toastError('发布失败', message)
    } finally {
      setPublishing(false)
    }
  }, [entity.id, entity.projectId, entity.status, publishing, queryClient, upsertChapter])

  return (
    <div className="space-y-2">
      <ChapterOutlineEditor
        entity={entity}
        value={outlineDraft}
        saveError={outlineSaveError}
        onChange={(outline) => {
          setOutlineDraft(outline)
          setOutlineSaveError(null)
        }}
        onApplyGeneration={(outline, generation) => {
          setOutlineDraft(outline)
          setAppliedOutlineGeneration(generation)
          setOutlineSaveError(null)
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
  const queryClient = useQueryClient()
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
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', entity.projectId] })
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, entity.projectId, form, queryClient, upsertVolume])

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
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', entity.projectId] })
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
