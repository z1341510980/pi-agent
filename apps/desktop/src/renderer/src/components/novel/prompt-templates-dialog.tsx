import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  listPromptTemplates,
  getPromptTemplate,
  savePromptTemplate,
  resetPromptTemplate,
  type PromptTemplateInfo,
  type PromptTemplateDetail,
} from '@/api/novel-prompt-client'

const SOURCE_LABELS: Record<PromptTemplateDetail['source'], string> = {
  runtime: '已覆盖',
  'project-file': '项目文件',
  default: '默认',
}

/** 分类展示顺序；未分类兜底到最后 */
const CATEGORY_ORDER = ['通用底座', '主流程工种', '群聊共创', '规划与编排', '分析与状态', '未分类']

export interface PromptTemplatesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 提示词拆解与编辑面板：按分类分组展示每个提示词部件——
 * 用在哪里（装配位置）、效果、字符数与最近调用统计；右侧编辑保存为本项目覆盖。
 * 数据来自 /prompts 的部件目录（prompt-part-catalog.ts）+ agent 日志聚合。
 */
export function PromptTemplatesDialog({ open, onOpenChange }: PromptTemplatesDialogProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const [templates, setTemplates] = useState<PromptTemplateInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<PromptTemplateDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  const reloadList = useCallback(async () => {
    try {
      const items = await listPromptTemplates(currentProjectId ?? undefined)
      setTemplates(items)
      return items
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return []
    }
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

  useEffect(() => {
    if (!open) return
    setError('')
    setLoading(true)
    void reloadList()
      .then((items) => {
        if (items.length > 0) {
          void loadDetail(items[0].name)
        }
      })
      .finally(() => setLoading(false))
  }, [open, currentProjectId, reloadList, loadDetail])

  const dirty = detail != null && draft !== (detail.content ?? '')
  const selectedInfo = templates.find((t) => t.name === selected)

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
        t.name === selected ? { ...t, source: fresh.source, charCount: fresh.charCount ?? t.charCount } : t
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
        t.name === selected ? { ...t, source: fresh.source, charCount: fresh.charCount ?? t.charCount } : t
      )))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [selected, detail, currentProjectId])

  /** 按分类分组；组内按名称排序 */
  const grouped = useMemo(() => {
    const map = new Map<string, PromptTemplateInfo[]>()
    for (const item of templates) {
      const key = item.category ?? '未分类'
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    return CATEGORY_ORDER
      .filter((category) => map.has(category))
      .map((category) => ({ category, items: map.get(category)!.sort((a, b) => a.name.localeCompare(b.name)) }))
  }, [templates])

  /** 选中部件的最近调用次数合计（跨关联 Agent） */
  const selectedUsage = useMemo(() => {
    const usage = selectedInfo?.usage
    if (!usage) return null
    const total = Object.values(usage).reduce((sum, n) => sum + n, 0)
    return total > 0 ? total : 0
  }, [selectedInfo])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[94vw] max-w-[1120px] sm:max-w-[1120px] h-[86vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>提示词拆解与编辑</DialogTitle>
          <DialogDescription>
            按分类查看每个提示词部件的用途、效果、用量与当前生效内容；修改保存为本项目覆盖，立即对后续调用生效。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-3 flex-1 min-h-0">
          {/* 左列：按分类分组的部件列表 */}
          <div className="w-[268px] shrink-0 overflow-y-auto rounded-lg border border-border/60 p-1 space-y-1">
            {loading ? (
              <div className="text-nano text-muted-foreground px-1.5 py-1">加载中...</div>
            ) : grouped.length === 0 ? (
              <div className="px-1.5 py-1 text-nano text-muted-foreground">
                {error ? '加载失败，见右侧提示' : '没有可用模板；若后端刚更新过，请重启服务'}
              </div>
            ) : grouped.map(({ category, items }) => (
              <div key={category}>
                <div className="flex items-center justify-between px-1.5 pt-1 pb-0.5">
                  <span className="text-nano font-medium text-text-secondary">{category}</span>
                  <span className="text-nano text-hint">{items.length}</span>
                </div>
                {items.map((template) => (
                  <button
                    key={template.name}
                    type="button"
                    onClick={() => loadDetail(template.name)}
                    className={cn(
                      'w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-left text-xs transition-colors',
                      selected === template.name ? 'bg-primary/[0.08] text-primary' : 'hover:bg-muted',
                    )}
                  >
                    <span className="truncate flex-1">{template.title ?? template.name}</span>
                    {typeof template.charCount === 'number' && (
                      <span className="text-nano text-hint tabular-nums shrink-0">{Math.round(template.charCount / 100) / 10}k</span>
                    )}
                    {template.source !== 'default' && (
                      <span className="size-1.5 rounded-full bg-amber-500 shrink-0" title={SOURCE_LABELS[template.source]} />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* 右列：部件说明 + 内容编辑 */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            {error && !selected && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-nano text-destructive">
                {error}
              </div>
            )}
            {!selected ? (
              <div className="flex-1 grid place-items-center text-nano text-muted-foreground">
                从左侧选择一个部件查看拆解与编辑
              </div>
            ) : (
              <>
                {/* 部件拆解头：名称 / 用在哪里 / 效果 / 统计 */}
                <div className="rounded-lg border border-border/60 bg-surface-1/60 px-2.5 py-2 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium">{selectedInfo?.title ?? selected}</span>
                    {selectedInfo?.category && <Badge variant="secondary" className="h-4 px-1 text-nano">{selectedInfo.category}</Badge>}
                    {detail && (
                      <Badge variant={detail.source === 'runtime' ? 'default' : 'secondary'} className="h-4 px-1 text-nano">
                        {SOURCE_LABELS[detail.source]}
                      </Badge>
                    )}
                    {typeof detail?.charCount === 'number' && (
                      <span className="text-nano text-hint tabular-nums">{detail.charCount} 字符</span>
                    )}
                    {selectedUsage != null && (
                      <span className="text-nano text-hint" title="关联 Agent 在最近 500 条调用日志中的出现次数">
                        最近调用 {selectedUsage} 次
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1.5">
                      {detail?.hasRuntimeOverride && (
                        <Button type="button" variant="ghost" size="xs" onClick={handleReset} disabled={saving}>
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
                    </span>
                  </div>
                  {selectedInfo && (
                    <div className="text-nano leading-relaxed text-text-secondary">
                      <span className="font-medium text-text">用在哪里：</span>
                      {selectedInfo.usedBy?.join('；')}
                    </div>
                  )}
                  {selectedInfo?.effect && (
                    <div className="text-nano leading-relaxed text-text-secondary">
                      <span className="font-medium text-text">效果：</span>
                      {selectedInfo.effect}
                    </div>
                  )}
                  <div className="text-nano text-hint">模板名：{selected}</div>
                </div>
                {error && <div className="text-nano text-destructive">{error}</div>}
                {dirty && <div className="text-nano text-amber-500">未保存修改</div>}
                {savedFlash && <div className="text-nano text-emerald-500">已保存 ✓ 下一次成员调用即生效</div>}
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="flex-1 min-h-0 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 resize-none"
                />
                <p className="text-nano text-muted-foreground">
                  {'{{变量}}'} 占位符由系统填充，请保留；删除占位符会导致对应信息缺失。
                </p>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
