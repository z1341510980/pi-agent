import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  AlertTriangle,
  Check,
  FileText,
  LoaderCircle,
  Play,
  RefreshCcw,
  RotateCcw,
  Send,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModelPicker, type ModelRef } from '@/components/novel/model-picker'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  createReferenceTemplateDraft,
  decideReferenceValidationRun,
  getReferenceApplicationPreview,
  getReferenceTemplate,
  getReferenceValidationRun,
  listReferenceTemplates,
  regenerateReferenceValidationRun,
  startReferenceValidationRun,
  submitReferenceValidationFeedback,
  type ReferenceApplicationPreview,
  type ReferenceTemplate,
  type ReferenceTemplateVersion,
  type ReferenceValidationRun
} from '@/api/novel-client'

const CATEGORY_LABEL: Record<string, string> = {
  spirit: '文风精神',
  technique: '文笔技法',
  power: '笔力控制',
  pacing: '推进节奏'
}

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const

interface ReferenceTemplatePanelProps {
  profileId: string | null
  projectId: string
}

export function ReferenceTemplatePanel({
  profileId,
  projectId
}: ReferenceTemplatePanelProps): ReactElement {
  const [preview, setPreview] = useState<ReferenceApplicationPreview | null>(null)
  const [templates, setTemplates] = useState<ReferenceTemplate[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<ReferenceTemplate | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<ReferenceTemplateVersion | null>(null)
  const [validation, setValidation] = useState<ReferenceValidationRun | null>(null)
  const [suggestions, setSuggestions] = useState<Array<{
    findingKey: string
    currentRule: string
    suggestedRule: string
    reason: string
  }> | null>(null)
  const [revisedVersionId, setRevisedVersionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('参考分析模板')
  const [model, setModel] = useState<ModelRef | null>(null)
  const [scenario, setScenario] = useState(
    '原创场景：守塔人在暴雨后的清晨检查灯芯，学徒递来一只生锈的扳手。'
  )
  const [feedback, setFeedback] = useState('')
  const pollTimerRef = useRef<number | null>(null)

  const stopPolling = useCallback((): void => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

  const refreshTemplates = useCallback(async (): Promise<void> => {
    try {
      const list = await listReferenceTemplates({ projectId })
      setTemplates(list)
    } catch (err) {
      toastError('模板列表加载失败', err instanceof Error ? err.message : '未知错误')
    }
  }, [projectId])

  useEffect(() => {
    void refreshTemplates()
  }, [refreshTemplates])

  const selectTemplate = useCallback(async (templateId: string): Promise<void> => {
    try {
      const detail = await getReferenceTemplate(templateId)
      setSelectedTemplate(detail.template)
      setSelectedVersion(detail.currentVersion)
    } catch (err) {
      toastError('模板详情加载失败', err instanceof Error ? err.message : '未知错误')
    }
  }, [])

  const handlePreview = async (): Promise<void> => {
    if (!profileId) return
    setLoading(true)
    try {
      setPreview(await getReferenceApplicationPreview(profileId, { ownerProjectId: projectId }))
    } catch (err) {
      toastError('应用预览失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateDraft = async (): Promise<void> => {
    if (!profileId || !preview || preview.blocking) return
    setLoading(true)
    try {
      const created = await createReferenceTemplateDraft(profileId, {
        name,
        description: '由 P6 应用预览生成',
        previewHash: preview.previewHash,
        ownerProjectId: projectId
      })
      setSelectedTemplate(created.template)
      setSelectedVersion(created.version)
      toastSuccess('模板草稿已创建', `v${created.version.version}`)
      await refreshTemplates()
    } catch (err) {
      toastError('创建模板失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  const pollRun = useCallback(
    (runId: string): void => {
      stopPolling()
      pollTimerRef.current = window.setInterval(() => {
        void getReferenceValidationRun(runId)
          .then((next) => {
            setValidation(next)
            if ((TERMINAL_STATUSES as readonly string[]).includes(next.status)) stopPolling()
          })
          .catch(() => undefined)
      }, 2000)
    },
    [stopPolling]
  )

  const handleValidation = async (): Promise<void> => {
    if (!selectedVersion || !model) return
    setLoading(true)
    setSuggestions(null)
    setRevisedVersionId(null)
    try {
      const run = await startReferenceValidationRun(selectedVersion.id, {
        scenarioSource: 'system_original',
        scenarioType: 'original',
        scenarioFacts: scenario,
        providerId: model.provider,
        modelId: model.modelId,
        highCostConfirmed: true
      })
      setValidation(run)
      pollRun(run.id)
      toastSuccess('同场景验证已启动')
    } catch (err) {
      toastError('验证启动失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  const handleFeedback = async (): Promise<void> => {
    if (!validation || validation.status !== 'completed' || !feedback.trim()) return
    setLoading(true)
    try {
      const result = await submitReferenceValidationFeedback(validation.id, {
        feedback: feedback.trim()
      })
      setSuggestions(result.ruleSuggestions)
      setRevisedVersionId(result.newVersionId)
      if (result.newVersionId) {
        toastSuccess('整改已生成新草稿版本', '修改的是规则而非正文，请重新验证')
        await selectTemplate(selectedVersion!.templateId)
      } else {
        toastError('没有可整改的规则')
      }
    } catch (err) {
      toastError('整改提交失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  const handleRegenerate = async (): Promise<void> => {
    if (!validation || validation.status !== 'completed') return
    setLoading(true)
    setSuggestions(null)
    try {
      const run = await regenerateReferenceValidationRun(validation.id, {
        templateVersionId: revisedVersionId ?? undefined,
        reuseFixedScenario: true,
        highCostConfirmed: true
      })
      setValidation(run)
      pollRun(run.id)
      toastSuccess('已用同一场景重新生成')
    } catch (err) {
      toastError('重新生成失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  const handleDecision = async (decision: 'accepted' | 'rejected'): Promise<void> => {
    if (!validation || validation.status !== 'completed') return
    setLoading(true)
    try {
      const decided = await decideReferenceValidationRun(validation.id, {
        decision,
        note: decision === 'accepted' ? '同场景验证通过' : '验证结果不满意，继续整改'
      })
      setValidation(decided)
      toastSuccess(decision === 'accepted' ? '已接受：版本可发布' : '已拒绝，可继续整改')
    } catch (err) {
      toastError('提交决定失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-4">
      <aside className="w-56 shrink-0 space-y-2 overflow-y-auto rounded-md border p-2">
        <div className="flex items-center justify-between px-1">
          <h4 className="text-xs font-medium text-muted-foreground">私人模板</h4>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void refreshTemplates()}
            title="刷新"
          >
            <RefreshCcw className="size-3.5" />
          </Button>
        </div>
        {templates.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">暂无模板</p>
        ) : (
          templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => void selectTemplate(template.id)}
              className={cn(
                'block w-full rounded px-2 py-2 text-left hover:bg-muted',
                selectedTemplate?.id === template.id && 'bg-primary/10'
              )}
            >
              <div className="truncate text-xs font-medium">{template.name}</div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                {template.status} · {template.versionCount} 个版本
              </div>
            </button>
          ))
        )}
      </aside>

      <main className="min-w-0 flex-1 space-y-4 overflow-y-auto rounded-md border p-4">
        {!profileId ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            请先完成 P5 档案审核。
          </div>
        ) : (
          <>
            <section className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">P6 应用预览</h3>
                  <p className="text-xs text-muted-foreground">
                    预览只产生候选规则，不会直接覆盖项目文风档案。
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handlePreview()}
                  disabled={loading}
                >
                  <FileText className="size-3.5" />
                  生成预览
                </Button>
              </div>
              {preview && (
                <>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {(Object.keys(CATEGORY_LABEL) as Array<keyof typeof CATEGORY_LABEL>).map(
                      (category) => (
                        <span key={category}>
                          {CATEGORY_LABEL[category]} {preview.compiledRules[category].length} 条
                        </span>
                      )
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    {preview.agentPromptDiffs.map((item) => (
                      <div
                        key={item.agent}
                        className={cn(
                          'rounded border p-2',
                          !item.withinBudget && 'border-amber-500/50'
                        )}
                      >
                        <div className="font-medium">{item.agent}</div>
                        <div className="text-muted-foreground">
                          {item.addedCharacters}/{item.budget} 字符
                        </div>
                      </div>
                    ))}
                  </div>
                  {(preview.projectRuleConflicts.length > 0 ||
                    preview.emergentStyleConflicts.length > 0) && (
                    <div className="space-y-1 rounded bg-muted/40 p-2 text-xs">
                      {preview.projectRuleConflicts.map((item) => (
                        <p
                          key={`${item.templateRuleKey}-${item.projectRule}`}
                          className="flex gap-1 text-muted-foreground"
                        >
                          <AlertTriangle className="size-3.5 shrink-0" />
                          项目规则冲突：{item.projectRule.slice(0, 30)}（{item.reason}）
                        </p>
                      ))}
                      {preview.emergentStyleConflicts.map((item) => (
                        <p key={`${item.expertName}`} className="flex gap-1 text-muted-foreground">
                          <AlertTriangle className="size-3.5 shrink-0" />
                          {item.reason}
                        </p>
                      ))}
                    </div>
                  )}
                  {(preview.warnings.length > 0 || preview.safetyBlockers.length > 0) && (
                    <div className="space-y-1 rounded bg-amber-500/10 p-2 text-xs">
                      {preview.safetyBlockers.map((item) => (
                        <p key={item} className="flex gap-1 text-destructive">
                          <ShieldAlert className="size-3.5 shrink-0" />
                          {item}
                        </p>
                      ))}
                      {preview.warnings.map((item) => (
                        <p key={item} className="flex gap-1 text-amber-700">
                          <AlertTriangle className="size-3.5 shrink-0" />
                          {item}
                        </p>
                      ))}
                    </div>
                  )}
                  {!preview.blocking && (
                    <div className="flex gap-2">
                      <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="h-8 max-w-xs text-xs"
                      />
                      <Button size="sm" onClick={() => void handleCreateDraft()} disabled={loading}>
                        <Check className="size-3.5" />
                        创建模板草稿
                      </Button>
                    </div>
                  )}
                </>
              )}
            </section>

            {selectedVersion && (
              <section className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">P7 同场景验证</h3>
                    <p className="text-xs text-muted-foreground">
                      固定场景事实 hash，基准/模板两路使用同一模型与参数。
                    </p>
                  </div>
                  <Badge>
                    {selectedVersion.status} · v{selectedVersion.version}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ModelPicker value={model} onChange={setModel} label="验证模型" />
                  <Button
                    size="sm"
                    onClick={() => void handleValidation()}
                    disabled={!model || loading}
                  >
                    <Play className="size-3.5" />
                    生成基准/模板
                  </Button>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">原创验证场景</Label>
                  <textarea
                    className="min-h-20 w-full rounded-md border bg-transparent p-2 text-xs"
                    value={scenario}
                    onChange={(e) => setScenario(e.target.value)}
                  />
                </div>
                {validation && <ValidationResult run={validation} />}
                {validation?.status === 'completed' && (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">整改反馈（修改规则而非正文）</Label>
                      <textarea
                        className="min-h-16 w-full rounded-md border bg-transparent p-2 text-xs"
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        placeholder="例如：钩子太硬，改为更柔和的收束"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleFeedback()}
                        disabled={!feedback.trim() || loading}
                      >
                        <Send className="size-3.5" />
                        提交整改
                      </Button>
                      {revisedVersionId && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleRegenerate()}
                          disabled={loading}
                        >
                          <RotateCcw className="size-3.5" />
                          用新版本重新生成
                        </Button>
                      )}
                      <span className="flex-1" />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleDecision('rejected')}
                        disabled={loading}
                      >
                        <ThumbsDown className="size-3.5" />
                        拒绝
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void handleDecision('accepted')}
                        disabled={loading}
                      >
                        <ThumbsUp className="size-3.5" />
                        接受
                      </Button>
                    </div>
                  </>
                )}
                {suggestions && suggestions.length > 0 && (
                  <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs">
                    <div className="font-medium">整改规则建议（已生成新草稿版本）</div>
                    {suggestions.map((item) => (
                      <div key={item.findingKey} className="rounded border bg-surface-1 p-2">
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {item.findingKey}
                        </div>
                        <div className="mt-1 line-through opacity-70">{item.currentRule}</div>
                        <div className="mt-0.5">{item.suggestedRule}</div>
                        <div className="mt-1 text-muted-foreground">{item.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function ValidationResult({ run }: { run: ReferenceValidationRun }): ReactElement {
  const safety = run.safetyReport
  const blockers = Array.isArray(safety.blockers) ? (safety.blockers as string[]) : []
  const hits = Array.isArray(run.ruleHits?.hits) ? (run.ruleHits.hits as string[]) : []
  const misses = Array.isArray(run.ruleHits?.misses) ? (run.ruleHits.misses as string[]) : []
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span>验证状态：{run.status}</span>
        {run.fixedFactsHash && (
          <span className="font-mono text-[10px] text-muted-foreground">
            facts {run.fixedFactsHash.slice(0, 12)}…
          </span>
        )}
        {run.decision && <Badge>{run.decision === 'accepted' ? '已接受' : '已拒绝'}</Badge>}
        {run.status === 'running' && (
          <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
        )}
      </div>
      {run.error && <p className="text-destructive">{run.error}</p>}
      {hits.length > 0 && <div className="text-muted-foreground">规则命中：{hits.join('、')}</div>}
      {misses.length > 0 && (
        <div className="text-muted-foreground">规则未命中：{misses.join('、')}</div>
      )}
      {run.baselineOutput && (
        <div>
          <div className="font-medium">基准输出</div>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{run.baselineOutput}</p>
        </div>
      )}
      {run.templateOutput && (
        <div>
          <div className="font-medium">模板输出</div>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{run.templateOutput}</p>
        </div>
      )}
      {blockers.length > 0 && (
        <div className="rounded bg-destructive/10 p-2 text-destructive">
          {blockers.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      )}
      {run.status === 'completed' && blockers.length === 0 && (
        <div className="flex items-center gap-1 text-emerald-600">
          <Check className="size-3.5" />
          通过安全检查，可提交最终决定
        </div>
      )}
    </div>
  )
}
