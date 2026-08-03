import { useEffect, useState, type ReactElement } from 'react'
import { Eye, LoaderCircle, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getReferenceTextPreview,
  updateReferenceSection,
  type ReferenceSection,
  type ReferenceTextPreview
} from '@/api/novel-client'

interface ReferenceSectionListProps {
  sections: ReferenceSection[]
  onUpdated: (sections: ReferenceSection[]) => void
}

export function ReferenceSectionList({
  sections,
  onUpdated
}: ReferenceSectionListProps): ReactElement {
  return (
    <div className="border-t border-border">
      {sections.map((section) => (
        <ReferenceSectionRow
          key={`${section.id}:${section.version}`}
          section={section}
          onUpdated={onUpdated}
        />
      ))}
    </div>
  )
}

function ReferenceSectionRow({
  section,
  onUpdated
}: {
  section: ReferenceSection
  onUpdated: (sections: ReferenceSection[]) => void
}): ReactElement {
  const [title, setTitle] = useState(section.title ?? '')
  const [start, setStart] = useState(String(section.start))
  const [end, setEnd] = useState(String(section.end))
  const [included, setIncluded] = useState(section.included)
  const [exclusionReason, setExclusionReason] = useState(section.exclusionReason ?? '')
  const [saving, setSaving] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [preview, setPreview] = useState<ReferenceTextPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTitle(section.title ?? '')
    setStart(String(section.start))
    setEnd(String(section.end))
    setIncluded(section.included)
    setExclusionReason(section.exclusionReason ?? '')
    setPreview(null)
  }, [section])

  async function handlePreview(): Promise<void> {
    if (preview) {
      setPreview(null)
      return
    }
    setPreviewLoading(true)
    setError(null)
    try {
      setPreview(
        await getReferenceTextPreview(section.sourceId, {
          sectionId: section.id,
          start: Number(start),
          end: Number(end),
          contextChars: 120
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取文本预览失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const result = await updateReferenceSection(section.id, {
        title: title.trim() || undefined,
        start: Number(start),
        end: Number(end),
        included,
        exclusionReason: included ? undefined : exclusionReason.trim() || '用户手动排除',
        version: section.version
      })
      onUpdated(result.sections)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存分段失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-2 border-b border-border px-4 py-3 lg:grid-cols-[minmax(180px,1fr)_100px_100px_130px_auto] lg:items-end">
      <label className="space-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="font-mono">#{section.order + 1}</span>
          <span>{section.type}</span>
          <span
            className={section.boundaryConfidence < 0.6 ? 'text-amber-600 dark:text-amber-300' : ''}
          >
            {Math.round(section.boundaryConfidence * 100)}%
          </span>
        </span>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="space-y-1 text-[11px] text-muted-foreground">
        <span>起点</span>
        <Input
          type="number"
          min={0}
          value={start}
          onChange={(event) => setStart(event.target.value)}
          className="font-mono text-xs"
        />
      </label>
      <label className="space-y-1 text-[11px] text-muted-foreground">
        <span>终点</span>
        <Input
          type="number"
          min={1}
          value={end}
          onChange={(event) => setEnd(event.target.value)}
          className="font-mono text-xs"
        />
      </label>
      <div className="space-y-1">
        <label className="flex h-9 items-center gap-2 text-xs text-text">
          <input
            type="checkbox"
            checked={included}
            onChange={(event) => setIncluded(event.target.checked)}
            className="size-4 accent-primary"
          />
          纳入分析
        </label>
        {!included && (
          <Input
            value={exclusionReason}
            onChange={(event) => setExclusionReason(event.target.value)}
            placeholder="排除原因"
            className="text-xs"
          />
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handlePreview}
          disabled={previewLoading}
          title={preview ? '收起文本预览' : '预览章节边界上下文'}
        >
          {previewLoading ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Eye className="size-4" />
          )}
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          onClick={handleSave}
          disabled={saving}
          title="保存章节边界与纳入状态"
        >
          {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
        </Button>
      </div>
      {preview && (
        <div className="space-y-1 border-l-2 border-primary/30 bg-muted/40 px-3 py-2 lg:col-span-5">
          <p className="text-[11px] text-muted-foreground">
            标准化偏移 {preview.start}-{preview.end}
            {preview.previousBoundary !== undefined && ` · 上一边界 ${preview.previousBoundary}`}
            {preview.nextBoundary !== undefined && ` · 下一边界 ${preview.nextBoundary}`}
            {preview.excluded && ' · 已排除'}
            {preview.truncated && ' · 已截取最短必要片段'}
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-text">
            {preview.text}
          </pre>
        </div>
      )}
      {error && <p className="text-xs text-destructive lg:col-span-5">{error}</p>}
    </div>
  )
}
