import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  listPromptTemplates,
  getPromptTemplate,
  savePromptTemplate,
  resetPromptTemplate,
  STYLE_RELATED_TEMPLATES,
  type PromptTemplateInfo,
  type PromptTemplateDetail,
} from '@/api/novel-prompt-client'

const SOURCE_LABELS: Record<PromptTemplateDetail['source'], string> = {
  runtime: '已覆盖',
  'project-file': '项目文件',
  default: '默认',
}

/**
 * 提示词模板编辑面板：让主流程提示词（尤其文风相关段）对用户可见、可改、可回退，
 * 不再是黑盒。保存为当前项目的运行时覆盖；「恢复默认」删除该覆盖。
 */
export function PromptTemplatesPanel(): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const [templates, setTemplates] = useState<PromptTemplateInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<PromptTemplateDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listPromptTemplates(currentProjectId ?? undefined)
      .then((items) => { if (!cancelled) setTemplates(items) })
      .catch((err) => { if (!cancelled) setError(String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [currentProjectId])

  const loadDetail = useCallback(async (name: string) => {
    setSelected(name)
    setSavedFlash(false)
    setError('')
    try {
      const result = await getPromptTemplate(name, currentProjectId ?? undefined)
      setDetail(result)
      setDraft(result.content ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [currentProjectId])

  const dirty = detail != null && draft !== (detail.content ?? '')

  const handleSave = useCallback(async () => {
    if (!selected || !detail) return
    setSaving(true)
    setError('')
    try {
      await savePromptTemplate(selected, {
        content: draft,
        projectId: currentProjectId ?? null,
      })
      const fresh = await getPromptTemplate(selected, currentProjectId ?? undefined)
      setDetail(fresh)
      setDraft(fresh.content ?? '')
      setTemplates((prev) => prev.map((t) => (
        t.name === selected ? { ...t, source: fresh.source } : t
      )))
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [selected, detail, draft, currentProjectId])

  const handleReset = useCallback(async () => {
    if (!selected || !detail?.hasRuntimeOverride) return
    if (!window.confirm(`恢复「${selected}」为内置默认？当前覆盖将被删除。`)) return
    setSaving(true)
    setError('')
    try {
      await resetPromptTemplate(selected, currentProjectId ?? undefined)
      const fresh = await getPromptTemplate(selected, currentProjectId ?? undefined)
      setDetail(fresh)
      setDraft(fresh.content ?? '')
      setTemplates((prev) => prev.map((t) => (
        t.name === selected ? { ...t, source: fresh.source } : t
      )))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [selected, detail, currentProjectId])

  const sortedTemplates = useMemo(() => {
    // 文风相关的排前面，降低寻找成本
    return [...templates].sort((a, b) =>
      Number(STYLE_RELATED_TEMPLATES.has(b.name)) - Number(STYLE_RELATED_TEMPLATES.has(a.name))
      || a.name.localeCompare(b.name),
    )
  }, [templates])

  return (
    <div className="flex flex-col h-full min-h-0 px-3 py-2.5 gap-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">提示词模板</span>
        <span className="text-nano text-muted-foreground">
          文风相关模板可自由修改；带 ⚙ 的属结构层，改动前请理解其职责
        </span>
      </div>

      <div className="flex gap-2 flex-1 min-h-0">
        {/* 左列：模板列表 */}
        <div className="w-48 shrink-0 overflow-y-auto rounded-lg border border-border/60 p-1 space-y-0.5">
          {loading ? (
            <div className="text-nano text-muted-foreground px-1.5 py-1">加载中...</div>
          ) : sortedTemplates.map((template) => (
            <button
              key={template.name}
              type="button"
              onClick={() => loadDetail(template.name)}
              className={cn(
                'w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-left text-xs transition-colors',
                selected === template.name ? 'bg-primary/[0.08] text-primary' : 'hover:bg-muted',
              )}
            >
              <span className="truncate flex-1">{template.name}</span>
              {STYLE_RELATED_TEMPLATES.has(template.name) && (
                <Badge variant="secondary" className="h-4 px-1 text-nano shrink-0">文风</Badge>
              )}
              {template.source !== 'default' && (
                <span className="size-1.5 rounded-full bg-amber-500 shrink-0" title={SOURCE_LABELS[template.source]} />
              )}
            </button>
          ))}
        </div>

        {/* 右侧编辑器 */}
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {!selected ? (
            <div className="flex-1 grid place-items-center text-nano text-muted-foreground">
              从左侧选择一个模板查看与编辑
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium truncate">{selected}</span>
                {detail && (
                  <Badge variant={detail.source === 'runtime' ? 'default' : 'secondary'} className="h-4 px-1 text-nano">
                    {SOURCE_LABELS[detail.source]}
                  </Badge>
                )}
                {dirty && <span className="text-nano text-amber-500">未保存修改</span>}
                {savedFlash && <span className="text-nano text-emerald-500">已保存 ✓</span>}
                <div className="ml-auto flex items-center gap-1.5">
                  {detail?.hasRuntimeOverride && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={handleReset}
                      disabled={saving}
                    >
                      <RotateCcw className="size-3" />
                      恢复默认
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="xs"
                    className="disabled:bg-secondary disabled:text-text-secondary"
                    onClick={handleSave}
                    disabled={saving || !dirty}
                  >
                    <Save className="size-3" />
                    {saving ? '保存中...' : '保存为本项目覆盖'}
                  </Button>
                </div>
              </div>
              {error && <div className="text-nano text-destructive">{error}</div>}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="flex-1 min-h-[320px] w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 resize-none"
              />
              <p className="text-nano text-muted-foreground">
                保存后立即对后续 Agent 调用生效（本项目范围）。{'{{变量}}'} 占位符由系统填充，请保留。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
