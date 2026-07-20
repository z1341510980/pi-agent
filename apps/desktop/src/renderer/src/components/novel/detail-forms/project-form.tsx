import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import { WritingStyleProfileEditor } from '../writing-style-profile-editor'
import {
  updateProject,
  listRhythmModels,
  type NovelProject,
  type RhythmModel,
  type StoryStage,
  type TargetPlatform,
} from '@/api/novel-client'
import {
  DebouncedOutlineField,
  FieldRow,
  PROJECT_STATUS_OPTIONS,
  STAGE_OPTIONS,
  TARGET_PLATFORM_OPTIONS,
  SaveButton,
  SectionHeader,
  TextArea,
  TextInput,
} from './shared'

// ── 项目表单 ──

export function ProjectForm({ entity }: { entity: NovelProject }): ReactElement {
  const upsertProject = useNovelDataStore((s) => s.upsertProject)
  const [form, setForm] = useState({
    title: entity.title,
    genre: entity.genre,
    synopsis: entity.synopsis,
    targetWords: String(entity.targetWords),
    currentStage: entity.currentStage,
    status: entity.status,
    rhythmModelId: entity.rhythmModelId ?? '',
    targetPlatform: (entity.targetPlatform ?? '__none__') as TargetPlatform | '__none__',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rhythmModels, setRhythmModels] = useState<RhythmModel[]>([])

  useEffect(() => {
    let cancelled = false
    listRhythmModels()
      .then((models) => { if (!cancelled) setRhythmModels(models) })
      .catch(() => { /* 节奏模型加载失败不阻塞表单 */ })
    return () => { cancelled = true }
  }, [])

  const dirty =
    form.title !== entity.title ||
    form.genre !== entity.genre ||
    form.synopsis !== entity.synopsis ||
    Number(form.targetWords) !== entity.targetWords ||
    form.currentStage !== entity.currentStage ||
    form.status !== entity.status ||
    (form.rhythmModelId || '') !== (entity.rhythmModelId ?? '') ||
    form.targetPlatform !== (entity.targetPlatform ?? '__none__')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateProject(entity.id, {
        title: form.title,
        genre: form.genre,
        synopsis: form.synopsis,
        targetWords: Number(form.targetWords) || 0,
        currentStage: form.currentStage,
        status: form.status,
        rhythmModelId: form.rhythmModelId === '' ? undefined : form.rhythmModelId,
        targetPlatform: form.targetPlatform === '__none__' ? null : form.targetPlatform,
      })
      upsertProject(updated)
      toastSuccess('项目已保存', '修改已生效')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      setError(msg)
      toastError('保存失败', msg)
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertProject])

  return (
    <div className="space-y-2">
      <SectionHeader title="全书大纲" />
      <DebouncedOutlineField
        label="大纲内容"
        value={entity.outline ?? ''}
        placeholder="编写全书大纲..."
        onSave={async (outline) => {
          const updated = await updateProject(entity.id, { outline })
          upsertProject(updated)
        }}
      />

      <SectionHeader title="基础信息" />
      <FieldRow label="标题">
        <TextInput value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
      </FieldRow>
      <FieldRow label="题材">
        <TextInput value={form.genre} onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))} />
      </FieldRow>
      <FieldRow label="目标字数">
        <TextInput
          type="number"
          value={form.targetWords}
          onChange={(e) => setForm((f) => ({ ...f, targetWords: e.target.value }))}
        />
      </FieldRow>

      <SectionHeader title="状态" />
      <FieldRow label="当前阶段">
        <Select value={form.currentStage} onValueChange={(v) => setForm((f) => ({ ...f, currentStage: v as StoryStage }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STAGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as NovelProject['status'] }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="节奏模型">
        <Select value={form.rhythmModelId} onValueChange={(v) => setForm((f) => ({ ...f, rhythmModelId: v === '__default__' ? '' : v }))}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="默认模型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">默认模型</SelectItem>
            {rhythmModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="目标平台">
        <Select value={form.targetPlatform} onValueChange={(v) => setForm((f) => ({ ...f, targetPlatform: v as TargetPlatform | '__none__' }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TARGET_PLATFORM_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}{o.hint ? `（${o.hint}）` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="简介" />
      <FieldRow label="简介">
        <TextArea variant="long" value={form.synopsis} onChange={(e) => setForm((f) => ({ ...f, synopsis: e.target.value }))} />
      </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />

      <SectionHeader title="文风工厂" />
      <WritingStyleProfileEditor projectId={entity.id} />
    </div>
  )
}
