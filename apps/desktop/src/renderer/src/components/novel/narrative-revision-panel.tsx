import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { GitBranch, History, PencilLine, RefreshCcw, Send, Check, X, RotateCcw } from 'lucide-react'
import {
  listStorylines,
  getStoryline,
  createStorylineRevision,
  submitStorylineRevision,
  approveStorylineRevision,
  rejectStorylineRevision,
  rollbackStorylineRevision,
  listScenes,
  getScene,
  createSceneRevision,
  submitSceneRevision,
  approveSceneRevision,
  rejectSceneRevision,
  rollbackSceneRevision,
  rebuildNarrativeMatrix,
  type StorylineDetail,
  type StorylineRevisionItem,
  type SceneReviewItem,
} from '@/api/novel-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

const STORYLINE_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', submitted: '待审核', approved: '已批准', rejected: '已拒绝', superseded: '已取代',
}

const STORYLINE_STATUS_COLOR: Record<string, string> = {
  draft: 'bg-slate-500', submitted: 'bg-amber-500', approved: 'bg-emerald-600', rejected: 'bg-red-500', superseded: 'bg-zinc-400',
}

interface NarrativeRevisionPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
}

export function NarrativeRevisionPanel({ open, onOpenChange, projectId }: NarrativeRevisionPanelProps): ReactElement {
  const [rebuilding, setRebuilding] = useState(false)

  const handleRebuild = async (): Promise<void> => {
    if (!projectId) return
    setRebuilding(true)
    try {
      const rebuild = await rebuildNarrativeMatrix(projectId, {})
      toastSuccess('矩阵重投影已触发', `sourceRevision=${rebuild.sourceRevision ?? '未生成'}${rebuild.stale ? '（检测到 stale）' : ''}`)
    } catch (err) {
      toastError('矩阵重投影失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            故事线与场景修订
          </DialogTitle>
          <DialogDescription>
            对规范事实（故事线 / 场景）进行编辑、提交审核、批准、拒绝、回滚，并重建只读剧情矩阵。
          </DialogDescription>
        </DialogHeader>

        <div className="mb-2 flex items-center justify-end">
          <Button variant="outline" size="sm" onClick={handleRebuild} disabled={rebuilding || !projectId}>
            <RefreshCcw className={cn('h-4 w-4 mr-2', rebuilding && 'animate-spin')} />
            重建剧情矩阵
          </Button>
        </div>

        <Tabs defaultValue="storylines" className="flex-1 flex flex-col min-h-0">
          <TabsList>
            <TabsTrigger value="storylines">故事线</TabsTrigger>
            <TabsTrigger value="scenes">场景</TabsTrigger>
          </TabsList>
          <TabsContent value="storylines" className="flex-1 min-h-0 mt-2">
            {projectId && <StorylineTab projectId={projectId} />}
          </TabsContent>
          <TabsContent value="scenes" className="flex-1 min-h-0 mt-2">
            {projectId && <SceneTab projectId={projectId} />}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ── Storyline ──

interface StorylineDraftForm {
  summary: string
  goal: string
  stakes: string
  actor: string
}

function StorylineTab({ projectId }: { projectId: string }): ReactElement {
  const [list, setList] = useState<StorylineDetail[]>([])
  const [selected, setSelected] = useState<StorylineDetail | null>(null)
  const [revisions, setRevisions] = useState<StorylineRevisionItem[]>([])
  const [form, setForm] = useState<StorylineDraftForm>({ summary: '', goal: '', stakes: '', actor: '' })
  const [editing, setEditing] = useState(false)

  const loadList = useCallback(async (): Promise<void> => {
    try {
      setList(await listStorylines(projectId))
    } catch (err) {
      toastError('加载故事线失败', err instanceof Error ? err.message : '未知错误')
    }
  }, [projectId])

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    try {
      const detail = await getStoryline(id)
      setSelected({ ...detail })
      setRevisions(detail.revisions)
      setForm({ summary: detail.summary, goal: detail.goal, stakes: detail.stakes, actor: detail.actor })
      setEditing(false)
    } catch (err) {
      toastError('加载故事线详情失败', err instanceof Error ? err.message : '未知错误')
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  const saveDraft = async (): Promise<void> => {
    if (!selected) return
    try {
      await createStorylineRevision(selected.id, { ...form, expectedRevision: selected.version })
      toastSuccess('草稿已创建')
      await loadDetail(selected.id)
    } catch (err) {
      toastError('创建草稿失败', err instanceof Error ? err.message : '未知错误')
    }
  }

  return (
    <div className="flex gap-3 h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto border rounded-md">
        {list.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">暂无故事线</div>
        ) : list.map((item) => (
          <button
            key={item.id}
            onClick={() => void loadDetail(item.id)}
            className={cn('block w-full text-left px-3 py-2 text-sm hover:bg-accent', selected?.id === item.id && 'bg-accent')}
          >
            <div className="font-medium truncate">{item.name}</div>
            <div className="text-[10px] text-muted-foreground">v{item.version} · {STORYLINE_STATUS_LABEL[item.status] ?? item.status}</div>
          </button>
        ))}
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto border rounded-md p-4">
        {!selected ? (
          <div className="text-sm text-muted-foreground py-8 text-center">选择一条故事线查看或编辑</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{selected.name}</h3>
              <Badge className={STORYLINE_STATUS_COLOR[selected.status] ?? 'bg-slate-500'}>
                {STORYLINE_STATUS_LABEL[selected.status] ?? selected.status}
              </Badge>
            </div>

            {editing ? (
              <div className="space-y-3">
                <Field label="摘要" value={form.summary} onChange={(v) => setForm((f) => ({ ...f, summary: v }))} />
                <Field label="目标" value={form.goal} onChange={(v) => setForm((f) => ({ ...f, goal: v }))} />
                <Field label="风险/赌注" value={form.stakes} onChange={(v) => setForm((f) => ({ ...f, stakes: v }))} />
                <Field label="主体" value={form.actor} onChange={(v) => setForm((f) => ({ ...f, actor: v }))} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void saveDraft()}><PencilLine className="h-4 w-4 mr-2" />保存草稿</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <InfoLine label="摘要" value={selected.summary} />
                <InfoLine label="目标" value={selected.goal} />
                <InfoLine label="风险/赌注" value={selected.stakes} />
                <InfoLine label="主体" value={selected.actor} />
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}><PencilLine className="h-4 w-4 mr-2" />编辑</Button>
              </div>
            )}

            {revisions.filter((r) => r.status === 'draft' || r.status === 'submitted').length > 0 && (
              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-medium text-muted-foreground">待审核修订</h4>
                {revisions.filter((r) => r.status === 'draft' || r.status === 'submitted').map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">v{r.revision}：{r.summary || '(无摘要)'}</div>
                      <Badge className={cn('mt-1', STORYLINE_STATUS_COLOR[r.status])}>{STORYLINE_STATUS_LABEL[r.status]}</Badge>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {r.status === 'draft' && (
                        <Button size="sm" variant="outline" onClick={() => void (async () => { try { await submitStorylineRevision(r.id); toastSuccess('已提交'); await loadDetail(selected.id) } catch (e) { toastError('提交失败', e instanceof Error ? e.message : '') } })()}><Send className="h-3.5 w-3.5" /></Button>
                      )}
                      {r.status === 'submitted' && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => void (async () => { try { await approveStorylineRevision(r.id); toastSuccess('已批准'); await loadDetail(selected.id) } catch (e) { toastError('批准失败', e instanceof Error ? e.message : '') } })()}><Check className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="outline" onClick={() => void (async () => { try { await rejectStorylineRevision(r.id); toastSuccess('已拒绝'); await loadDetail(selected.id) } catch (e) { toastError('拒绝失败', e instanceof Error ? e.message : '') } })()}><X className="h-3.5 w-3.5" /></Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {revisions.length > 0 && (
              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1"><History className="h-3.5 w-3.5" />版本历史</h4>
                {revisions.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="min-w-0 text-xs">
                      <span className="font-medium">v{r.revision}</span>
                      <Badge className={cn('ml-2', STORYLINE_STATUS_COLOR[r.status])}>{STORYLINE_STATUS_LABEL[r.status]}</Badge>
                      <div className="text-muted-foreground truncate mt-0.5">{r.summary || '(无摘要)'}</div>
                    </div>
                    <Button size="sm" variant="ghost" disabled={r.status === 'draft' || r.status === 'submitted'} onClick={() => void (async () => { try { await rollbackStorylineRevision(selected.id, r.id); toastSuccess('已创建回滚草稿'); await loadDetail(selected.id) } catch (e) { toastError('回滚失败', e instanceof Error ? e.message : '') } })()}><RotateCcw className="h-3.5 w-3.5 mr-1" />回滚</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Scene ──

function SceneTab({ projectId }: { projectId: string }): ReactElement {
  const [list, setList] = useState<SceneReviewItem[]>([])
  const [selected, setSelected] = useState<SceneReviewItem | null>(null)
  const [revisions, setRevisions] = useState<SceneReviewItem[]>([])
  const [form, setForm] = useState<{ summary: string; pov: string; positioning: string; rhythm: string; narrativeTaskTypes: string }>({ summary: '', pov: 'single', positioning: '', rhythm: '', narrativeTaskTypes: '' })
  const [editing, setEditing] = useState(false)
  const [sceneId, setSceneId] = useState<string | null>(null)

  const loadList = useCallback(async (): Promise<void> => {
    try { setList(await listScenes(projectId)) } catch (err) { toastError('加载场景失败', err instanceof Error ? err.message : '未知错误') }
  }, [projectId])

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    try {
      const detail = await getScene(id)
      setSceneId(detail.sceneId)
      const cur = detail.currentRevision
      setSelected(cur)
      setRevisions(detail.revisions)
      setForm({ summary: cur?.summary ?? '', pov: cur?.pov ?? 'single', positioning: cur?.positioning ?? '', rhythm: cur?.rhythm ?? '', narrativeTaskTypes: (cur?.narrativeTaskTypes ?? []).join(', ') })
      setEditing(false)
    } catch (err) { toastError('加载场景详情失败', err instanceof Error ? err.message : '未知错误') }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  const saveDraft = async (): Promise<void> => {
    if (!selected || !sceneId) return
    try {
      await createSceneRevision(sceneId, {
        expectedRevision: selected.id, summary: form.summary, pov: form.pov, positioning: form.positioning, rhythm: form.rhythm,
        narrativeTaskTypes: form.narrativeTaskTypes.split(',').map((s) => s.trim()).filter(Boolean),
      })
      toastSuccess('草稿已创建')
      await loadDetail(sceneId)
    } catch (err) { toastError('创建草稿失败', err instanceof Error ? err.message : '未知错误') }
  }

  return (
    <div className="flex gap-3 h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto border rounded-md">
        {list.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">暂无场景</div>
        ) : list.map((item) => (
          <button
            key={item.id}
            onClick={() => void loadDetail(item.sceneId)}
            className={cn('block w-full text-left px-3 py-2 text-sm hover:bg-accent', selected?.sceneId === item.sceneId && 'bg-accent')}
          >
            <div className="font-medium truncate">{item.title || `场景 ${item.order}`}</div>
            <div className="text-[10px] text-muted-foreground">第 {item.chapterId.slice(0, 8)} · {item.reviewStatus ?? '无审核'}</div>
          </button>
        ))}
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto border rounded-md p-4">
        {!selected ? (
          <div className="text-sm text-muted-foreground py-8 text-center">选择一个场景查看或编辑</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{selected.title || `场景 ${selected.order}`}</h3>
              <Badge>{selected.reviewStatus ?? '已批准（自动）'}</Badge>
            </div>

            {editing ? (
              <div className="space-y-3">
                <Field label="摘要" value={form.summary} onChange={(v) => setForm((f) => ({ ...f, summary: v }))} />
                <div className="space-y-1">
                  <Label className="text-xs">视角</Label>
                  <select className="w-full rounded-md border bg-transparent px-3 py-2 text-sm" value={form.pov} onChange={(e) => setForm((f) => ({ ...f, pov: e.target.value }))}>
                    <option value="single">single</option>
                    <option value="omniscient">omniscient</option>
                    <option value="none">none</option>
                  </select>
                </div>
                <Field label="定位" value={form.positioning} onChange={(v) => setForm((f) => ({ ...f, positioning: v }))} />
                <Field label="节奏" value={form.rhythm} onChange={(v) => setForm((f) => ({ ...f, rhythm: v }))} />
                <Field label="叙事任务类型（逗号分隔）" value={form.narrativeTaskTypes} onChange={(v) => setForm((f) => ({ ...f, narrativeTaskTypes: v }))} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void saveDraft()}><PencilLine className="h-4 w-4 mr-2" />保存草稿</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <InfoLine label="摘要" value={selected.summary} />
                <InfoLine label="视角" value={selected.pov} />
                <InfoLine label="定位" value={selected.positioning ?? ''} />
                <InfoLine label="节奏" value={selected.rhythm ?? ''} />
                <InfoLine label="叙事任务" value={selected.narrativeTaskTypes.join(', ')} />
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}><PencilLine className="h-4 w-4 mr-2" />编辑</Button>
              </div>
            )}

            {revisions.filter((r) => r.reviewStatus === 'draft' || r.reviewStatus === 'submitted').length > 0 && (
              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-medium text-muted-foreground">待审核修订</h4>
                {revisions.filter((r) => r.reviewStatus === 'draft' || r.reviewStatus === 'submitted').map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="min-w-0 text-xs">
                      <div className="font-medium truncate">{r.summary || '(无摘要)'}</div>
                      <Badge className="mt-1">{r.reviewStatus}</Badge>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {r.reviewStatus === 'draft' && <Button size="sm" variant="outline" onClick={() => void (async () => { try { await submitSceneRevision(r.id); toastSuccess('已提交'); await loadDetail(sceneId!) } catch (e) { toastError('提交失败', e instanceof Error ? e.message : '') } })()}><Send className="h-3.5 w-3.5" /></Button>}
                      {r.reviewStatus === 'submitted' && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => void (async () => { try { await approveSceneRevision(r.id); toastSuccess('已批准'); await loadDetail(sceneId!) } catch (e) { toastError('批准失败', e instanceof Error ? e.message : '') } })()}><Check className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="outline" onClick={() => void (async () => { try { await rejectSceneRevision(r.id); toastSuccess('已拒绝'); await loadDetail(sceneId!) } catch (e) { toastError('拒绝失败', e instanceof Error ? e.message : '') } })()}><X className="h-3.5 w-3.5" /></Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {revisions.length > 0 && (
              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1"><History className="h-3.5 w-3.5" />版本历史</h4>
                {revisions.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="min-w-0 text-xs">
                      <span className="font-medium">{r.summary || '(无摘要)'}</span>
                      <Badge className="ml-2">{r.reviewStatus ?? '自动'}</Badge>
                      <div className="text-muted-foreground truncate mt-0.5">{r.pov}{r.positioning ? ` · ${r.positioning}` : ''}</div>
                    </div>
                    <Button size="sm" variant="ghost" disabled={r.reviewStatus === 'draft' || r.reviewStatus === 'submitted'} onClick={() => void (async () => { try { await rollbackSceneRevision(sceneId!, r.id); toastSuccess('已创建回滚草稿'); await loadDetail(sceneId!) } catch (e) { toastError('回滚失败', e instanceof Error ? e.message : '') } })()}><RotateCcw className="h-3.5 w-3.5 mr-1" />回滚</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 小工具 ──

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): ReactElement {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function InfoLine({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div>
      <span className="text-xs text-muted-foreground">{label}：</span>
      <span className="text-sm">{value || '—'}</span>
    </div>
  )
}