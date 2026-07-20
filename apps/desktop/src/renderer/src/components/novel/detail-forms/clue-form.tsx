import { useCallback, useState, type ReactElement } from 'react'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import {
  updateClue,
  type NovelClue,
} from '@/api/novel-client'
import {
  FieldRow,
  SaveButton,
  SectionHeader,
  TextArea,
  TextInput,
} from './shared'

// ── 线索编辑表单 ──

export function ClueForm({ entity }: { entity: NovelClue }): ReactElement {
  const upsertClue = useNovelDataStore((s) => s.upsertClue)
  const [form, setForm] = useState({
    description: entity.description,
    pointsTo: entity.pointsTo,
    progress: String(entity.progress),
    currentStep: entity.currentStep,
    nextStep: entity.nextStep,
    isMisleading: entity.isMisleading,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = form.description !== entity.description
    || form.pointsTo !== entity.pointsTo
    || Number(form.progress) !== entity.progress
    || form.currentStep !== entity.currentStep
    || form.nextStep !== entity.nextStep
    || form.isMisleading !== entity.isMisleading

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateClue(entity.id, {
        description: form.description.trim(),
        pointsTo: form.pointsTo.trim(),
        progress: Math.max(0, Math.min(100, Number(form.progress) || 0)),
        currentStep: form.currentStep.trim(),
        nextStep: form.nextStep.trim(),
        isMisleading: form.isMisleading,
      })
      upsertClue(updated)
      toastSuccess('线索已保存')
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败'
      setError(message)
      toastError('保存线索失败', message)
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertClue])

  return (
    <div className="space-y-3">
      <SectionHeader title="线索内容" />
      <FieldRow label="描述">
        <TextArea variant="medium" value={form.description} onChange={(e) => setForm((value) => ({ ...value, description: e.target.value }))} />
      </FieldRow>
      <FieldRow label="指向的真相/对象">
        <TextArea variant="short" value={form.pointsTo} onChange={(e) => setForm((value) => ({ ...value, pointsTo: e.target.value }))} />
      </FieldRow>
      <FieldRow label="推进进度">
        <div className="flex items-center gap-2">
          <TextInput type="number" min={0} max={100} value={form.progress} onChange={(e) => setForm((value) => ({ ...value, progress: e.target.value }))} />
          <span className="text-xs text-muted-foreground">%</span>
        </div>
      </FieldRow>
      <FieldRow label="当前进展">
        <TextArea variant="short" value={form.currentStep} onChange={(e) => setForm((value) => ({ ...value, currentStep: e.target.value }))} />
      </FieldRow>
      <FieldRow label="下一步">
        <TextArea variant="short" value={form.nextStep} onChange={(e) => setForm((value) => ({ ...value, nextStep: e.target.value }))} />
      </FieldRow>
      <label className="flex items-center gap-2 text-xs text-text">
        <input type="checkbox" checked={form.isMisleading} onChange={(e) => setForm((value) => ({ ...value, isMisleading: e.target.checked }))} />
        这是误导线索
      </label>
      {entity.chapterSpans.length > 0 && (
        <p className="text-[11px] text-muted-foreground">关联章节：{entity.chapterSpans.map(([start, end]) => start === end ? `第 ${start} 章` : `第 ${start}-${end} 章`).join('、')}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty || !form.description.trim()} saving={saving} />
    </div>
  )
}
