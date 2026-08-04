import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { AlertTriangle, Check, ChevronDown, Eye, EyeOff, LoaderCircle, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getReferenceTextPreview,
  updateReferenceSection,
  type ReferenceSection,
  type ReferenceTextPreview
} from '@/api/novel-client'

interface ReferenceSectionListProps {
  sections: ReferenceSection[]
  attentionSectionIds?: string[]
  onUpdated: (sections: ReferenceSection[]) => void
  onDirtyChange?: (dirty: boolean) => void
}

type SectionFilter = 'all' | 'attention'

const SECTION_TYPE_LABEL: Record<ReferenceSection['type'], string> = {
  chapter: '章节',
  scene: '场景',
  chunk: '文本块',
  directory: '目录',
  preface: '前言',
  afterword: '后记',
  appendix: '附录',
  excluded: '排除区'
}

export function ReferenceSectionList({
  sections,
  attentionSectionIds = [],
  onUpdated,
  onDirtyChange
}: ReferenceSectionListProps): ReactElement {
  const [filter, setFilter] = useState<SectionFilter>(
    attentionSectionIds.length > 0 ? 'attention' : 'all'
  )
  const [dirtySectionIds, setDirtySectionIds] = useState<Set<string>>(() => new Set())
  const attentionIds = useMemo(() => new Set(attentionSectionIds), [attentionSectionIds])
  const visibleSections =
    filter === 'attention'
      ? sections.filter(
          (section) =>
            attentionIds.has(section.id) ||
            section.boundaryConfidence < 0.6 ||
            section.warnings.length > 0
        )
      : sections

  const handleRowDirty = useCallback((sectionId: string, dirty: boolean): void => {
    setDirtySectionIds((current) => {
      const hasSection = current.has(sectionId)
      if (hasSection === dirty) return current
      const next = new Set(current)
      if (dirty) next.add(sectionId)
      else next.delete(sectionId)
      return next
    })
  }, [])

  useEffect(() => {
    onDirtyChange?.(dirtySectionIds.size > 0)
  }, [dirtySectionIds, onDirtyChange])

  useEffect(
    () => () => {
      onDirtyChange?.(false)
    },
    [onDirtyChange]
  )

  function requestFilter(nextFilter: SectionFilter): void {
    if (nextFilter === filter) return
    if (
      dirtySectionIds.size > 0 &&
      !window.confirm('切换筛选会放弃当前未保存的章节修改，确认继续吗？')
    )
      return
    setFilter(nextFilter)
  }

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-popover/95 px-5 py-3 backdrop-blur-sm">
        <Tabs value={filter} onValueChange={(value) => requestFilter(value as SectionFilter)}>
          <TabsList className="h-10">
            <TabsTrigger value="all" className="px-3 text-xs">
              全部章节
              <span className="tabular-nums text-muted-foreground">{sections.length}</span>
            </TabsTrigger>
            <TabsTrigger
              value="attention"
              disabled={attentionSectionIds.length === 0}
              className="px-3 text-xs"
            >
              需确认
              <span className="tabular-nums text-amber-700 dark:text-amber-300">
                {attentionSectionIds.length}
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-right text-[11px] text-muted-foreground">
          已纳入{' '}
          <span className="tabular-nums">{sections.filter((item) => item.included).length}</span> /{' '}
          {sections.length}
        </p>
      </div>

      {visibleSections.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-5 text-center">
          <Check className="size-6 text-success" />
          <p className="text-sm font-medium text-text">没有需要额外确认的章节</p>
          <p className="text-xs text-muted-foreground">当前章节边界均达到识别置信度要求。</p>
        </div>
      ) : (
        <div className="border-t border-border">
          {visibleSections.map((section) => (
            <ReferenceSectionRow
              key={section.id}
              section={section}
              needsAttention={
                attentionIds.has(section.id) ||
                section.boundaryConfidence < 0.6 ||
                section.warnings.length > 0
              }
              onUpdated={onUpdated}
              onDirtyChange={handleRowDirty}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ReferenceSectionRow({
  section,
  needsAttention,
  onUpdated,
  onDirtyChange
}: {
  section: ReferenceSection
  needsAttention: boolean
  onUpdated: (sections: ReferenceSection[]) => void
  onDirtyChange: (sectionId: string, dirty: boolean) => void
}): ReactElement {
  const [expanded, setExpanded] = useState(needsAttention)
  const [title, setTitle] = useState(section.title ?? '')
  const [start, setStart] = useState(String(section.start))
  const [end, setEnd] = useState(String(section.end))
  const [included, setIncluded] = useState(section.included)
  const [exclusionReason, setExclusionReason] = useState(section.exclusionReason ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [preview, setPreview] = useState<ReferenceTextPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startNumber = Number(start)
  const endNumber = Number(end)
  const offsetError =
    !Number.isInteger(startNumber) || startNumber < 0
      ? '起点必须是大于等于 0 的整数'
      : !Number.isInteger(endNumber) || endNumber <= startNumber
        ? '终点必须是大于起点的整数'
        : null
  const dirty =
    title !== (section.title ?? '') ||
    start !== String(section.start) ||
    end !== String(section.end) ||
    included !== section.included ||
    exclusionReason !== (section.exclusionReason ?? '')
  const confidence = Math.round(section.boundaryConfidence * 100)

  useEffect(() => {
    if (dirty) return
    setTitle(section.title ?? '')
    setStart(String(section.start))
    setEnd(String(section.end))
    setIncluded(section.included)
    setExclusionReason(section.exclusionReason ?? '')
    setPreview(null)
    setError(null)
  }, [
    dirty,
    section.end,
    section.exclusionReason,
    section.included,
    section.start,
    section.title,
    section.version
  ])

  useEffect(() => {
    if (needsAttention) setExpanded(true)
  }, [needsAttention])

  useEffect(() => {
    onDirtyChange(section.id, dirty)
  }, [dirty, onDirtyChange, section.id])

  useEffect(
    () => () => {
      onDirtyChange(section.id, false)
    },
    [onDirtyChange, section.id]
  )

  function markEdited(): void {
    setSaved(false)
    setError(null)
  }

  async function handlePreview(): Promise<void> {
    if (preview) {
      setPreview(null)
      return
    }
    if (offsetError) {
      setError(offsetError)
      return
    }
    setPreviewLoading(true)
    setError(null)
    try {
      setPreview(
        await getReferenceTextPreview(section.sourceId, {
          sectionId: section.id,
          start: startNumber,
          end: endNumber,
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
    if (offsetError) {
      setError(offsetError)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await updateReferenceSection(section.id, {
        title: title.trim() || undefined,
        start: startNumber,
        end: endNumber,
        included,
        exclusionReason: included ? undefined : exclusionReason.trim() || '用户手动排除',
        version: section.version
      })
      setSaved(true)
      onUpdated(result.sections)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存分段失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <article className={`${needsAttention ? 'bg-amber-500/[0.035]' : ''} border-b border-border`}>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex min-h-14 w-full items-center gap-3 px-5 py-3 text-left transition-[color,background-color,transform] hover:bg-muted/50 active:scale-[0.995]"
      >
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
        <span className="w-9 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          #{section.order + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text">
            {section.title || `未命名${SECTION_TYPE_LABEL[section.type]}`}
          </span>
          <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground">
            {SECTION_TYPE_LABEL[section.type]} · {section.characterCount.toLocaleString()} 字符 ·{' '}
            {section.estimatedTokens.toLocaleString()} tokens
          </span>
        </span>
        {dirty && (
          <span className="rounded bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
            未保存
          </span>
        )}
        {needsAttention && (
          <span className="rounded bg-amber-500/15 px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            需确认
          </span>
        )}
        <span
          className={`w-20 shrink-0 text-right text-xs font-medium tabular-nums ${needsAttention ? 'text-amber-700 dark:text-amber-300' : 'text-text'}`}
        >
          置信度 {confidence}%
        </span>
        <span
          className={`w-16 shrink-0 text-right text-xs ${included ? 'text-success' : 'text-muted-foreground'}`}
        >
          {included ? '已纳入' : '已排除'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/60 bg-surface-1/35 px-5 py-4 pl-12">
          {section.warnings.length > 0 && (
            <div className="mb-4 flex items-start gap-2 border-l-2 border-amber-500 pl-3 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-1">
                {section.warnings.map((warning) => (
                  <p key={warning} className="text-pretty">
                    {warning}
                  </p>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(220px,1fr)_140px_140px_minmax(180px,0.8fr)]">
            <label className="space-y-1.5 text-[11px] text-muted-foreground">
              <span>章节标题</span>
              <Input
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value)
                  markEdited()
                }}
                placeholder="章节标题"
              />
            </label>
            <label className="space-y-1.5 text-[11px] text-muted-foreground">
              <span>起点（标准化偏移）</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={start}
                onChange={(event) => {
                  setStart(event.target.value)
                  markEdited()
                }}
                className="font-mono text-xs tabular-nums"
                aria-invalid={Boolean(offsetError)}
              />
            </label>
            <label className="space-y-1.5 text-[11px] text-muted-foreground">
              <span>终点（标准化偏移）</span>
              <Input
                type="number"
                min={1}
                step={1}
                value={end}
                onChange={(event) => {
                  setEnd(event.target.value)
                  markEdited()
                }}
                className="font-mono text-xs tabular-nums"
                aria-invalid={Boolean(offsetError)}
              />
            </label>
            <div className="space-y-1.5">
              <label className="flex min-h-10 items-center gap-2 text-xs text-text">
                <input
                  type="checkbox"
                  checked={included}
                  onChange={(event) => {
                    setIncluded(event.target.checked)
                    markEdited()
                  }}
                  className="size-4 accent-primary"
                />
                纳入本地分析
              </label>
              {!included && (
                <Input
                  value={exclusionReason}
                  onChange={(event) => {
                    setExclusionReason(event.target.value)
                    markEdited()
                  }}
                  placeholder="排除原因"
                  className="text-xs"
                />
              )}
            </div>
          </div>

          {dirty && offsetError && <p className="mt-2 text-xs text-destructive">{offsetError}</p>}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-h-5 text-xs">
              {saved ? (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <Check className="size-3.5" /> 已保存
                </span>
              ) : dirty ? (
                <span className="text-primary">修改尚未保存</span>
              ) : (
                <span className="text-muted-foreground">边界偏移以标准化文本为准</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                className="h-10"
                variant="outline"
                onClick={handlePreview}
                disabled={previewLoading || Boolean(offsetError)}
              >
                {previewLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : preview ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
                {preview ? '收起预览' : '预览边界'}
              </Button>
              <Button
                className="h-10"
                onClick={handleSave}
                disabled={saving || !dirty || Boolean(offsetError)}
              >
                {saving ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                保存修改
              </Button>
            </div>
          </div>

          {preview && (
            <div className="mt-4 space-y-2 rounded-md bg-muted/50 px-4 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <p className="text-[11px] tabular-nums text-muted-foreground">
                标准化偏移 {preview.start}-{preview.end}
                {preview.previousBoundary !== undefined &&
                  ` · 上一边界 ${preview.previousBoundary}`}
                {preview.nextBoundary !== undefined && ` · 下一边界 ${preview.nextBoundary}`}
                {preview.excluded && ' · 已排除'}
                {preview.truncated && ' · 已截取最短必要片段'}
              </p>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-text">
                {preview.text}
              </pre>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </article>
  )
}
