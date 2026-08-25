import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FileSearch,
  FlaskConical,
  LoaderCircle,
  Play,
  RefreshCcw,
  RotateCcw,
  Save,
  ShieldAlert,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModelPicker, type ModelRef } from '@/components/novel/model-picker'
import { toastError, toastInfo, toastSuccess } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  cancelReferenceAnalysisRun,
  compareReferenceProfileVersions,
  estimateReferenceAnalysis,
  getReferenceAnalysisRun,
  getReferenceFindingEvidence,
  getReferenceProfile,
  getReferenceSafetyReport,
  listReferenceAnalysisRuns,
  listReferenceFindings,
  listReferenceProfileVersions,
  listReferenceRunObservations,
  resumeReferenceAnalysisRun,
  retryReferenceAnalysisRun,
  reviewReferenceFinding,
  batchReviewReferenceFindings,
  startReferenceAnalysisRun,
  type ReferenceAnalysisRun,
  type ReferenceFindingItem,
  type ReferenceProfileDetail,
  type ReferenceRunStage
} from '@/api/novel-client'

const STAGES: ReferenceRunStage[] = [
  'validating_source',
  'parsing_text',
  'deterministic_analysis',
  'scene_analysis',
  'chapter_aggregation',
  'book_aggregation',
  'safety_scan',
  'awaiting_review'
]

const STAGE_LABEL: Record<string, string> = {
  validating_source: '校验源',
  parsing_text: '装载文本',
  deterministic_analysis: '确定性测量',
  scene_analysis: '分包抽取',
  chapter_aggregation: '按章聚合',
  book_aggregation: '全书汇总',
  safety_scan: '安全核对',
  awaiting_review: '待审核',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消'
}

const CATEGORY_LABEL: Record<string, string> = {
  spirit: '文风精神',
  technique: '文笔技法',
  power: '笔力控制',
  pacing: '推进节奏'
}

const AGENT_TARGETS = ['Director', 'Writer', 'Reviser', 'Reviewer'] as const

// ═══════════════════════════════════════════════════════════════
// P4：远端分析
// ═══════════════════════════════════════════════════════════════

interface ReferenceRunSectionProps {
  sourceId: string | null
  parsed: boolean
  onProfileReady: (profileId: string) => void
}

export function ReferenceRunSection({
  sourceId,
  parsed,
  onProfileReady
}: ReferenceRunSectionProps): ReactElement {
  const [model, setModel] = useState<ModelRef | null>(null)
  const [estimate, setEstimate] = useState<{
    estimateHash: string
    costMax: number
    withinLimit: boolean
    warnings: string[]
    localChunkCount: number
    localChunkTargetTokens: number
  } | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [starting, setStarting] = useState(false)
  const [run, setRun] = useState<ReferenceAnalysisRun | null>(null)
  const [observations, setObservations] = useState<string>('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const active = run !== null && ['queued', 'running'].includes(run.status)

  // 轮询进行中的 run；断线≠取消，页面重开后继续跟随
  useEffect(() => {
    if (!run?.id || !active) return
    pollRef.current = setInterval(() => {
      getReferenceAnalysisRun(run.id)
        .then((next) => setRun(next))
        .catch(() => {
          /* 轮询失败静默，下一轮重试 */
        })
    }, 2000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [run?.id, active])

  const loadObservations = useCallback((runId: string): void => {
    listReferenceRunObservations(runId, { limit: 20 })
      .then((result) => {
        setObservations(
          result.observations
            .map(
              (item) =>
                `[${item.level}] ${item.metric} = ${String(typeof item.value === 'string' ? item.value : JSON.stringify(item.value)).slice(0, 60)}`
            )
            .join('\n')
        )
      })
      .catch(() => setObservations(''))
  }, [])

  // 重启/重开后恢复既有分析任务：优先待审核（档案入口），其次已完成/失败/已取消。
  // 进行中(queued/running)的任务不恢复——进程重启后执行器已不在，恢复只会显示假进度。
  useEffect(() => {
    setRun(null)
    setObservations('')
    if (!sourceId || !parsed) return
    let cancelled = false
    listReferenceAnalysisRuns(sourceId)
      .then((result) => {
        if (cancelled) return
        const restorable = (result.runs ?? []).filter((item) =>
          ['awaiting_review', 'completed', 'failed', 'cancelled'].includes(item.status)
        )
        const preferred =
          restorable.find((item) => item.status === 'awaiting_review') ??
          restorable.find((item) => item.status === 'completed') ??
          restorable[0]
        if (preferred) {
          setRun(preferred)
          loadObservations(preferred.id)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sourceId, parsed, loadObservations])

  const handleEstimate = (): void => {
    if (!sourceId || !model) return
    setEstimating(true)
    estimateReferenceAnalysis(sourceId, { providerId: model.provider, modelId: model.modelId })
      .then((result) => {
        setEstimate({
          estimateHash: result.estimateHash,
          costMax: result.estimatedCost?.max ?? 0,
          withinLimit: result.withinLimit,
          warnings: result.warnings,
          localChunkCount: result.localChunkPlan.chunks.length,
          localChunkTargetTokens: result.localChunkPlan.targetTokens
        })
      })
      .catch((err) => toastError('估算失败', err instanceof Error ? err.message : '未知错误'))
      .finally(() => setEstimating(false))
  }

  const handleStart = (): void => {
    if (!sourceId || !model || !estimate) return
    setStarting(true)
    startReferenceAnalysisRun(sourceId, {
      providerId: model.provider,
      modelId: model.modelId,
      estimateHash: estimate.estimateHash,
      highCostConfirmed: confirmed
    })
      .then((created) => {
        setRun(created)
        toastSuccess('远端分析已启动', `attempt ${created.attempt}`)
      })
      .catch((err) => toastError('启动失败', err instanceof Error ? err.message : '未知错误'))
      .finally(() => setStarting(false))
  }

  const runAction = (fn: () => Promise<ReferenceAnalysisRun>, okTitle: string): void => {
    if (!run) return
    fn()
      .then((next) => {
        setRun(next)
        toastSuccess(okTitle)
        loadObservations(next.id)
      })
      .catch((err) => toastError('操作失败', err instanceof Error ? err.message : '未知错误'))
  }

  useEffect(() => {
    if (run?.id && (run.status === 'awaiting_review' || run.status === 'completed'))
      loadObservations(run.id)
  }, [run?.status, run?.id, loadObservations])

  if (!sourceId || !parsed) {
    return (
      <div className="p-6 text-sm text-muted-foreground">先完成本地解析后才能启动远端分析。</div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      {/* 启动配置 */}
      <section className="space-y-3 rounded-md border p-3">
        <h4 className="text-xs font-medium text-muted-foreground">启动配置</h4>
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            value={model}
            onChange={(next) => {
              setModel(next)
              setEstimate(null)
            }}
            label="分析模型"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleEstimate}
            disabled={!model || estimating}
          >
            {estimating ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <FlaskConical className="size-3.5" />
            )}
            费用估算
          </Button>
        </div>
        {estimate && (
          <div className="space-y-1 text-xs">
            <div
              className={cn(
                'flex items-center gap-1',
                estimate.withinLimit ? 'text-muted-foreground' : 'text-destructive'
              )}
            >
              {!estimate.withinLimit && <AlertTriangle className="size-3.5" />}
              {estimate.withinLimit
                ? estimate.localChunkCount > 1
                  ? `本地按章节分为 ${estimate.localChunkCount} 包，每包约 ${estimate.localChunkTargetTokens.toLocaleString()} tokens`
                  : `预计最高费用 $${estimate.costMax.toFixed(4)}`
                : '超出模型上下文上限，不能启动'}
            </div>
            {estimate.warnings.slice(0, 2).map((warning) => (
              <p key={warning} className="text-muted-foreground/80">
                {warning}
              </p>
            ))}
            {estimate.costMax > 0 && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我确认本次分析的费用
              </label>
            )}
            <Button
              size="sm"
              onClick={handleStart}
              disabled={
                !estimate.withinLimit || (estimate.costMax > 0 && !confirmed) || starting || active
              }
            >
              {starting ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              启动远端分析
            </Button>
          </div>
        )}
      </section>

      {/* 运行状态 */}
      {run && (
        <section className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-muted-foreground">
              运行状态 · attempt {run.attempt}
              {run.workerRunning && <LoaderCircle className="ml-1 inline size-3 animate-spin" />}
            </h4>
            <div className="flex gap-1">
              {active && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    runAction(() => cancelReferenceAnalysisRun(run.id, '用户取消'), '已取消')
                  }
                >
                  <Ban className="size-3.5" />
                  取消
                </Button>
              )}
              {run.status === 'failed' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    runAction(() => retryReferenceAnalysisRun(run.id, true), '已重试（从断点）')
                  }
                >
                  <RotateCcw className="size-3.5" />
                  重试
                </Button>
              )}
              {run.status === 'cancelled' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    runAction(() => resumeReferenceAnalysisRun(run.id, true), '已恢复')
                  }
                >
                  <RefreshCcw className="size-3.5" />
                  恢复
                </Button>
              )}
            </div>
          </div>

          {/* 阶段进度条 */}
          <div className="flex items-center gap-1">
            {STAGES.map((stage, index) => {
              const currentIndex = run.currentStage ? STAGES.indexOf(run.currentStage) : -1
              const done = currentIndex > index || run.status === 'awaiting_review'
              const current = run.currentStage === stage && active
              return (
                <div key={stage} className="flex flex-1 items-center gap-1">
                  <div
                    title={STAGE_LABEL[stage]}
                    className={cn(
                      'h-1.5 flex-1 rounded-full',
                      done ? 'bg-emerald-500' : current ? 'bg-amber-500 animate-pulse' : 'bg-muted'
                    )}
                  />
                </div>
              )
            })}
          </div>
          <div className="text-xs text-muted-foreground">
            当前：{STAGE_LABEL[run.currentStage ?? ''] ?? run.currentStage}
            {run.checkpoint &&
              typeof run.checkpoint.llmCalls === 'number' &&
              ` · 已完成 LLM 调用 ${run.checkpoint.llmCalls} 次`}
          </div>
          {run.error && (
            <div className="flex items-start gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              {run.error}
            </div>
          )}
          {(run.status === 'awaiting_review' || run.status === 'completed') && run.profileId && (
            <Button size="sm" onClick={() => onProfileReady(run.profileId!)}>
              <FileSearch className="size-3.5" />
              进入档案审核
            </Button>
          )}
        </section>
      )}

      {/* 观察预览 */}
      {observations && (
        <section className="rounded-md border p-3">
          <h4 className="mb-2 text-xs font-medium text-muted-foreground">观察预览（最近 20 条）</h4>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-4 text-muted-foreground">
            {observations}
          </pre>
        </section>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// P5：档案审核
// ═══════════════════════════════════════════════════════════════

interface FindingDraft {
  decision: 'accepted' | 'rejected' | 'edited'
  strength: 'hard' | 'soft' | 'reference'
  promptEnabled: boolean
  agentTargets: string[]
  chapterScope: string
  editedRule: string
  note: string
}

function defaultDraft(finding: ReferenceFindingItem): FindingDraft {
  return {
    decision: 'accepted',
    strength: finding.strength,
    promptEnabled: finding.promptEnabled,
    agentTargets: finding.agentTargets.length > 0 ? [...finding.agentTargets] : ['Writer'],
    chapterScope: finding.chapterScope.join(', '),
    editedRule: '',
    note: ''
  }
}

export function ReferenceReviewSection({ profileId }: { profileId: string | null }): ReactElement {
  const [profile, setProfile] = useState<ReferenceProfileDetail | null>(null)
  const [findingsData, setFindingsData] = useState<Awaited<
    ReturnType<typeof listReferenceFindings>
  > | null>(null)
  const [safety, setSafety] = useState<Awaited<ReturnType<typeof getReferenceSafetyReport>> | null>(
    null
  )
  const [versions, setVersions] = useState<
    Awaited<ReturnType<typeof listReferenceProfileVersions>>
  >([])
  const [drafts, setDrafts] = useState<Record<string, FindingDraft>>({})
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<
    Record<string, Awaited<ReturnType<typeof getReferenceFindingEvidence>>>
  >({})
  const [saving, setSaving] = useState(false)
  const [category, setCategory] = useState<string>('all')

  const reload = useCallback((id: string): void => {
    getReferenceProfile(id)
      .then(setProfile)
      .catch((err) => toastError('加载档案失败', err instanceof Error ? err.message : ''))
    listReferenceFindings(id)
      .then(setFindingsData)
      .catch(() => setFindingsData(null))
    getReferenceSafetyReport(id)
      .then(setSafety)
      .catch(() => setSafety(null))
    listReferenceProfileVersions(id)
      .then(setVersions)
      .catch(() => setVersions([]))
    setDrafts({})
    setEvidence({})
  }, [])

  useEffect(() => {
    if (profileId) reload(profileId)
    else {
      setProfile(null)
      setFindingsData(null)
      setSafety(null)
      setVersions([])
    }
  }, [profileId, reload])

  const findings = useMemo(() => {
    const list = findingsData?.findings ?? []
    return category === 'all' ? list : list.filter((finding) => finding.category === category)
  }, [findingsData, category])

  const toggleEvidence = (findingKey: string): void => {
    if (!profileId) return
    if (expandedKey === findingKey) {
      setExpandedKey(null)
      return
    }
    setExpandedKey(findingKey)
    if (!evidence[findingKey]) {
      getReferenceFindingEvidence(profileId, findingKey)
        .then((result) => setEvidence((prev) => ({ ...prev, [findingKey]: result })))
        .catch((err) => toastError('证据加载失败', err instanceof Error ? err.message : ''))
    }
  }

  const quickReview = (finding: ReferenceFindingItem, decision: 'accepted' | 'rejected'): void => {
    if (!profileId) return
    const draft = drafts[finding.key] ?? defaultDraft(finding)
    reviewReferenceFinding(profileId, finding.key, {
      decision,
      strength: draft.strength,
      promptEnabled: decision === 'accepted' && draft.promptEnabled,
      agentTargets: draft.agentTargets,
      chapterScope: draft.chapterScope
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    })
      .then(() => {
        toastSuccess(decision === 'accepted' ? '已接受' : '已拒绝')
        reload(profileId)
      })
      .catch((err) => toastError('审核失败', err instanceof Error ? err.message : ''))
  }

  const submitBatch = (): void => {
    if (!profileId || !profile) return
    const pending = (findingsData?.findings ?? []).filter((finding) => !finding.review)
    if (pending.length === 0) {
      toastError('没有待审核项')
      return
    }
    const reviews = pending
      .filter((finding) => drafts[finding.key])
      .map((finding) => {
        const draft = drafts[finding.key]!
        return {
          findingKey: finding.key,
          decision: draft.decision,
          editedRule: draft.decision === 'edited' ? draft.editedRule || undefined : undefined,
          strength: draft.strength,
          promptEnabled: draft.decision === 'accepted' && draft.promptEnabled,
          agentTargets: draft.agentTargets,
          chapterScope: draft.chapterScope
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        }
      })
    if (reviews.length === 0) {
      toastError('请先在列表中设置至少一项的强度/Agent/范围')
      return
    }
    setSaving(true)
    batchReviewReferenceFindings(profileId, profile.version, reviews)
      .then((result) => {
        toastSuccess('批量审核完成', `生成 v${result.newVersion}`)
        reload(result.profile.id)
      })
      .catch((err) => toastError('批量审核失败', err instanceof Error ? err.message : ''))
      .finally(() => setSaving(false))
  }

  if (!profileId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">先完成一次远端分析，再进入档案审核。</div>
    )
  }
  if (!profile || !findingsData) {
    return (
      <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-4 animate-spin" />
        加载档案...
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      {/* 四类档案 */}
      <section className="grid grid-cols-2 gap-2">
        {(['spirit', 'technique', 'power', 'pacing'] as const).map((key) => (
          <div key={key} className="rounded-md border p-2.5">
            <div className="mb-1 text-xs font-medium">{CATEGORY_LABEL[key]}</div>
            <p className="line-clamp-2 text-[11px] text-muted-foreground">
              {profile[key].summary || '（无摘要）'}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {profile[key].rules.length} 条规则
            </p>
          </div>
        ))}
      </section>

      {/* 安全报告 */}
      {safety && (
        <section
          className={cn(
            'rounded-md border p-3 text-xs',
            safety.blocking ? 'border-destructive/40 bg-destructive/5' : ''
          )}
        >
          <div className="mb-1 flex items-center gap-1 font-medium">
            <ShieldAlert className="size-3.5" />
            安全报告
            {safety.blocking && (
              <Badge variant="destructive" className="ml-1">
                阻断
              </Badge>
            )}
          </div>
          {safety.blockers.map((blocker) => (
            <p key={blocker} className="text-destructive">
              {blocker}
            </p>
          ))}
          {safety.directQuotes.map((quote) => (
            <p key={quote.prefix} className="text-muted-foreground">
              直接引用（{quote.length} 字）：{quote.prefix}…
            </p>
          ))}
          {!safety.blocking && <p className="text-muted-foreground">无阻断项。</p>}
        </section>
      )}

      {/* findings 工具栏 */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-1">
          {(['all', 'spirit', 'technique', 'power', 'pacing'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setCategory(key)}
              className={cn(
                'rounded-md px-2 py-1 text-[11px]',
                category === key
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {key === 'all'
                ? `全部 ${findingsData.counts.total}`
                : `${CATEGORY_LABEL[key]} ${findingsData.counts.byCategory[key]}`}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-muted-foreground">
            待审核 {findingsData.counts.pending} · 已接受 {findingsData.counts.accepted} · 拒绝{' '}
            {findingsData.counts.rejected} · 编辑 {findingsData.counts.edited}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={submitBatch}
            disabled={saving || findingsData.counts.pending === 0}
          >
            {saving ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            批量审核并生成新版本
          </Button>
        </div>

        {/* findings 列表 */}
        <div className="space-y-2">
          {findings.map((finding) => {
            const draft = drafts[finding.key] ?? defaultDraft(finding)
            const reviewed = finding.review !== null
            const setDraft = (patch: Partial<FindingDraft>): void => {
              setDrafts((prev) => ({ ...prev, [finding.key]: { ...draft, ...patch } }))
            }
            return (
              <div key={finding.key} className="rounded-md border p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {CATEGORY_LABEL[finding.category]}
                      </Badge>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {finding.key}
                      </span>
                      {reviewed && (
                        <Badge
                          className={cn(
                            'text-[10px]',
                            finding.review!.decision === 'rejected'
                              ? 'bg-red-500'
                              : finding.review!.decision === 'edited'
                                ? 'bg-violet-500'
                                : 'bg-emerald-600'
                          )}
                        >
                          {finding.review!.decision === 'rejected'
                            ? '已拒绝'
                            : finding.review!.decision === 'edited'
                              ? '已编辑'
                              : '已接受'}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs">{finding.observation || '（无观察）'}</p>
                    <p className="text-[11px] text-muted-foreground">
                      规则：{finding.review?.editedRule ?? (finding.rule || '—')}
                    </p>
                  </div>
                  <button
                    onClick={() => toggleEvidence(finding.key)}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                    title="查看证据"
                  >
                    {expandedKey === finding.key ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>
                </div>

                {expandedKey === finding.key && (
                  <div className="mt-2 rounded bg-muted/50 p-2 text-[11px]">
                    {evidence[finding.key] ? (
                      evidence[finding.key]!.evidence.length === 0 ? (
                        <span className="text-muted-foreground">无证据引用</span>
                      ) : (
                        evidence[finding.key]!.evidence.map((item) => (
                          <div key={item.quote} className="flex items-center gap-1">
                            <Eye className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">“{item.quote}”</span>
                            {item.available ? (
                              <span className="shrink-0 text-emerald-600">
                                @{item.sectionTitle ?? item.sectionId?.slice(0, 8)} [{item.start}-
                                {item.end}]
                              </span>
                            ) : (
                              <span className="shrink-0 text-amber-600">原文中未定位</span>
                            )}
                          </div>
                        ))
                      )
                    ) : (
                      <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
                    )}
                  </div>
                )}

                {!reviewed && (
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                    <label className="flex items-center gap-1">
                      强度
                      <select
                        className="rounded border bg-transparent px-1 py-0.5"
                        value={draft.strength}
                        onChange={(e) =>
                          setDraft({ strength: e.target.value as FindingDraft['strength'] })
                        }
                      >
                        <option value="hard">hard</option>
                        <option value="soft">soft</option>
                        <option value="reference">reference</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={draft.promptEnabled}
                        onChange={(e) => setDraft({ promptEnabled: e.target.checked })}
                      />
                      进入 Prompt
                    </label>
                    <div className="col-span-2 flex flex-wrap items-center gap-1">
                      Agent：
                      {AGENT_TARGETS.map((target) => (
                        <button
                          key={target}
                          onClick={() =>
                            setDraft({
                              agentTargets: draft.agentTargets.includes(target)
                                ? draft.agentTargets.filter((item) => item !== target)
                                : [...draft.agentTargets, target]
                            })
                          }
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px]',
                            draft.agentTargets.includes(target)
                              ? 'bg-primary/15 text-primary'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {target}
                        </button>
                      ))}
                    </div>
                    <div className="col-span-2 flex items-center gap-1">
                      <Label className="shrink-0">章节范围</Label>
                      <Input
                        className="h-6 text-[11px]"
                        placeholder="空 = 全局；逗号分隔，如 1-5, 8"
                        value={draft.chapterScope}
                        onChange={(e) => setDraft({ chapterScope: e.target.value })}
                      />
                    </div>
                    <div className="col-span-2 flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6"
                        onClick={() => quickReview(finding, 'accepted')}
                      >
                        <Check className="size-3" />
                        接受
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6"
                        onClick={() => quickReview(finding, 'rejected')}
                      >
                        <X className="size-3" />
                        拒绝
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6"
                        disabled={!drafts[finding.key]}
                        onClick={() => {
                          if (!profileId) return
                          reviewReferenceFinding(profileId, finding.key, {
                            decision: 'edited',
                            editedRule: draft.editedRule || finding.rule,
                            strength: draft.strength,
                            promptEnabled: draft.promptEnabled,
                            agentTargets: draft.agentTargets,
                            chapterScope: draft.chapterScope
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean)
                          })
                            .then(() => {
                              toastSuccess('已保存编辑')
                              reload(profileId)
                            })
                            .catch((err) =>
                              toastError('编辑失败', err instanceof Error ? err.message : '')
                            )
                        }}
                      >
                        编辑
                      </Button>
                      {drafts[finding.key] && (
                        <Input
                          className="h-6 flex-1 text-[11px]"
                          placeholder="编辑后的规则（选择「编辑」时提交）"
                          value={draft.editedRule}
                          onChange={(e) => setDraft({ editedRule: e.target.value })}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {findings.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground">该分类暂无 findings</div>
          )}
        </div>
      </section>

      {/* 版本历史 */}
      <section className="rounded-md border p-3">
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">
          版本历史（{versions.length}）
        </h4>
        <div className="space-y-1">
          {versions.map((version) => (
            <div key={version.id} className="flex items-center justify-between text-[11px]">
              <span>
                v{version.version}
                <span className="ml-1.5 text-muted-foreground">{version.changeSummary ?? ''}</span>
              </span>
              <span className="text-muted-foreground">
                {version.findingCounts.promptEnabled}/{version.findingCounts.total} 生效 ·{' '}
                {version.status}
              </span>
            </div>
          ))}
        </div>
        {versions.length >= 2 && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-2 h-6 text-[11px]"
            onClick={() => {
              compareReferenceProfileVersions(
                profile.id,
                versions[versions.length - 2]!.id,
                versions[versions.length - 1]!.id
              )
                .then((result) => {
                  const lines = [
                    ...result.profileChanges.map(
                      (change) =>
                        `${CATEGORY_LABEL[change.category] ?? change.category}: ${change.fromSummary || '—'} → ${change.toSummary || '—'}（规则 ${change.ruleCountDelta >= 0 ? '+' : ''}${change.ruleCountDelta}）`
                    ),
                    ...result.findingChanges.map(
                      (change) => `${change.key}: ${change.from} → ${change.to}`
                    )
                  ]
                  toastInfo('版本比较', lines.slice(0, 6).join('；') || '无差异')
                })
                .catch(() => toastError('比较失败'))
            }}
          >
            比较最近两个版本
          </Button>
        )}
      </section>
    </div>
  )
}
