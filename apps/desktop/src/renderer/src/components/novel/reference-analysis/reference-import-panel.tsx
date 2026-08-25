import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactElement
} from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  Calculator,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  FileText,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Upload
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  estimateReferenceAnalysis,
  listReferenceProviders,
  parseReferenceSource,
  preflightReferenceFile,
  preflightReferencePaste,
  updateReferenceImportOptions,
  type ReferencePreflightResult,
  type ReferenceSourceDetail,
  type ReferenceTextEncoding,
  type ReferenceTokenBudgetEstimate
} from '@/api/novel-client'

type ImportAction = 'preflight' | 'estimate' | 'parse'

interface ReferenceImportPanelProps {
  projectId: string
  initialSource?: ReferenceSourceDetail | null
  onParsed: (source: ReferenceSourceDetail) => void
  onSourceCreated: (source: ReferenceSourceDetail) => void
  onDirtyChange?: (dirty: boolean) => void
}

interface FieldErrors {
  displayName?: string
  source?: string
  rights?: string
}

interface ActionError {
  action: ImportAction
  message: string
}

const IMPORT_STEPS = ['选择文本', '预检确认', '本地分析'] as const

export function ReferenceImportPanel({
  projectId,
  initialSource,
  onParsed,
  onSourceCreated,
  onDirtyChange
}: ReferenceImportPanelProps): ReactElement {
  const [mode, setMode] = useState<'file' | 'paste'>('file')
  const [displayName, setDisplayName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [draft, setDraft] = useState<ReferencePreflightResult | null>(null)
  const [encoding, setEncoding] = useState<ReferenceTextEncoding>('utf-8')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [rightsStatement, setRightsStatement] = useState('')
  const [retentionPolicy, setRetentionPolicy] = useState<
    'keep_local' | 'manual_delete' | 'delete_after_activation'
  >('manual_delete')
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [estimate, setEstimate] = useState<ReferenceTokenBudgetEstimate | null>(null)
  const [activeAction, setActiveAction] = useState<ImportAction | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [actionError, setActionError] = useState<ActionError | null>(null)

  const providersQuery = useQuery({
    queryKey: ['reference-analysis', 'providers'],
    queryFn: listReferenceProviders,
    enabled: Boolean(draft)
  })
  const provider = useMemo(
    () => providersQuery.data?.find((item) => item.id === providerId),
    [providersQuery.data, providerId]
  )
  const currentStep = activeAction === 'parse' ? 3 : draft ? 2 : 1
  const inputDirty =
    !draft && (Boolean(displayName.trim()) || Boolean(file) || Boolean(pasteText.trim()))
  const optionsDirty = Boolean(
    draft &&
    (encoding !== draft.encoding ||
      rightsConfirmed !== draft.rights.confirmed ||
      rightsStatement.trim() !== (draft.rights.statement ?? '') ||
      retentionPolicy !== draft.retentionPolicy)
  )

  useEffect(() => {
    const firstProvider = providersQuery.data?.[0]
    if (!providerId && firstProvider) {
      setProviderId(firstProvider.id)
      setModelId(firstProvider.models[0]?.id ?? '')
    }
  }, [providerId, providersQuery.data])

  useEffect(() => {
    if (draft) setEncoding(draft.detectedEncoding)
  }, [draft])

  useEffect(() => {
    if (
      !initialSource ||
      initialSource.parseStatus === 'parsed' ||
      initialSource.parseStatus === 'confirmed'
    )
      return
    setMode(initialSource.inputKind)
    setDisplayName(initialSource.displayName)
    setEncoding(initialSource.encoding)
    setRightsConfirmed(initialSource.rights.confirmed)
    setRightsStatement(initialSource.rights.statement ?? '')
    setRetentionPolicy(initialSource.retentionPolicy)
    setDraft({
      ...initialSource,
      sourceDraftId: initialSource.id,
      detectedEncoding: initialSource.encoding,
      estimatedChapterCount: initialSource.chapterCount,
      contentHash: initialSource.normalizedHash,
      warnings: [],
      supported: true
    })
  }, [initialSource])

  useEffect(() => {
    onDirtyChange?.(inputDirty || optionsDirty)
  }, [inputDirty, onDirtyChange, optionsDirty])

  useEffect(
    () => () => {
      onDirtyChange?.(false)
    },
    [onDirtyChange]
  )

  function setInputMode(nextMode: 'file' | 'paste'): void {
    if (nextMode === mode) return
    setMode(nextMode)
    setFieldErrors({})
    setActionError(null)
  }

  function assignFile(next: File | null): void {
    if (next && !/\.(txt|md|markdown)$/i.test(next.name)) {
      setFile(null)
      setFieldErrors((current) => ({ ...current, source: '仅支持 TXT、MD 或 Markdown 文件' }))
      return
    }
    setFile(next)
    setFieldErrors((current) => ({ ...current, source: undefined }))
    setActionError(null)
    if (next && !displayName) setDisplayName(next.name.replace(/\.(txt|md|markdown)$/i, ''))
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    assignFile(event.target.files?.[0] ?? null)
  }

  function handleFileDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault()
    assignFile(event.dataTransfer.files?.[0] ?? null)
  }

  function validateSource(): boolean {
    const nextErrors: FieldErrors = {}
    if (!displayName.trim()) nextErrors.displayName = '请输入参考源名称'
    if (mode === 'file' && !file) nextErrors.source = '请选择 TXT 或 Markdown 文件'
    if (mode === 'paste' && !pasteText.trim()) nextErrors.source = '请粘贴需要分析的文本'
    setFieldErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  async function handlePreflight(): Promise<void> {
    setActionError(null)
    setEstimate(null)
    if (!validateSource()) return
    setActiveAction('preflight')
    try {
      const result =
        mode === 'file'
          ? await preflightReferenceFile(projectId, {
              displayName: displayName.trim(),
              fileName: file!.name,
              bytes: new Uint8Array(await file!.arrayBuffer())
            })
          : await preflightReferencePaste(projectId, {
              displayName: displayName.trim(),
              text: pasteText
            })
      setDraft(result)
      onSourceCreated(result)
    } catch (cause) {
      setActionError({
        action: 'preflight',
        message: cause instanceof Error ? cause.message : '编码预检失败'
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function handleEstimate(): Promise<void> {
    if (!draft || !providerId || !modelId) return
    setActiveAction('estimate')
    setActionError(null)
    try {
      setEstimate(await estimateReferenceAnalysis(draft.id, { providerId, modelId }))
    } catch (cause) {
      setActionError({
        action: 'estimate',
        message: cause instanceof Error ? cause.message : '预算估算失败'
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function handleConfirmAndParse(): Promise<void> {
    if (!draft || !draft.supported) return
    if (!rightsConfirmed) {
      setFieldErrors((current) => ({ ...current, rights: '请先确认有权分析该文本' }))
      return
    }
    setActiveAction('parse')
    setActionError(null)
    setFieldErrors((current) => ({ ...current, rights: undefined }))
    try {
      const options = await updateReferenceImportOptions(draft.id, {
        encoding,
        retentionPolicy,
        rightsConfirmed,
        rightsStatement: rightsStatement.trim() || undefined,
        cloudAnalysisConfirmed: false,
        version: draft.version
      })
      const result = await parseReferenceSource(draft.id, options.source.version)
      setDraft({
        ...draft,
        ...result.source,
        sourceDraftId: result.source.id,
        detectedEncoding: result.source.encoding,
        estimatedChapterCount: result.source.chapterCount,
        contentHash: result.source.normalizedHash
      })
      onParsed(result.source)
    } catch (cause) {
      setActionError({
        action: 'parse',
        message: cause instanceof Error ? cause.message : '本地解析失败'
      })
    } finally {
      setActiveAction(null)
    }
  }

  function retryFailedAction(): void {
    if (actionError?.action === 'preflight') void handlePreflight()
    if (actionError?.action === 'estimate') void handleEstimate()
    if (actionError?.action === 'parse') void handleConfirmAndParse()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ImportProgress currentStep={currentStep} />

        {!draft ? (
          <section className="px-6 py-5">
            <div className="mb-4">
              <h3 className="text-balance text-sm font-semibold text-text">选择参考文本</h3>
              <p className="mt-1 text-pretty text-xs text-muted-foreground">
                支持 TXT、Markdown 和粘贴文本。预检只在本机执行编码与大小检查。
              </p>
            </div>
            <Tabs value={mode} onValueChange={(value) => setInputMode(value as 'file' | 'paste')}>
              <TabsList className="mb-4 h-10">
                <TabsTrigger value="file" className="px-4 text-xs">
                  <Upload className="size-3.5" /> 文件
                </TabsTrigger>
                <TabsTrigger value="paste" className="px-4 text-xs">
                  <ClipboardPaste className="size-3.5" /> 粘贴文本
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="grid gap-5 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
              <label className="space-y-1.5 text-xs text-muted-foreground">
                <span>参考源名称</span>
                <Input
                  value={displayName}
                  onChange={(event) => {
                    setDisplayName(event.target.value)
                    setFieldErrors((current) => ({ ...current, displayName: undefined }))
                    setActionError(null)
                  }}
                  placeholder="例如：叙事节奏参考"
                  aria-invalid={Boolean(fieldErrors.displayName)}
                />
                {fieldErrors.displayName && (
                  <span className="block text-[11px] text-destructive">
                    {fieldErrors.displayName}
                  </span>
                )}
              </label>

              {mode === 'file' ? (
                <label
                  htmlFor="reference-analysis-file"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleFileDrop}
                  className={`flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg bg-surface-1 px-5 py-6 text-center shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[background-color,box-shadow,transform] active:scale-[0.99] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)] ${fieldErrors.source ? 'ring-1 ring-destructive' : 'hover:bg-muted/60 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.09),0_2px_4px_rgba(0,0,0,0.05)]'}`}
                >
                  <input
                    id="reference-analysis-file"
                    type="file"
                    accept=".txt,.md,.markdown,text/plain,text/markdown"
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                  <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    {file ? <FileText className="size-5" /> : <Upload className="size-5" />}
                  </span>
                  <span className="mt-3 max-w-full truncate text-sm font-medium text-text">
                    {file?.name ?? '拖放文件到这里，或点击选择'}
                  </span>
                  <span className="mt-1 text-pretty text-[11px] text-muted-foreground">
                    {file
                      ? `${(file.size / 1024).toFixed(1)} KB · 点击可重新选择`
                      : 'TXT / MD / Markdown；支持 UTF-8、GBK 和 GB18030'}
                  </span>
                  {fieldErrors.source && (
                    <span className="mt-2 text-[11px] text-destructive">{fieldErrors.source}</span>
                  )}
                </label>
              ) : (
                <label className="space-y-1.5 text-xs text-muted-foreground">
                  <span className="flex items-center justify-between gap-3">
                    <span>文本内容</span>
                    <span className="tabular-nums">{pasteText.length.toLocaleString()} 字符</span>
                  </span>
                  <textarea
                    value={pasteText}
                    onChange={(event) => {
                      setPasteText(event.target.value)
                      setFieldErrors((current) => ({ ...current, source: undefined }))
                      setActionError(null)
                    }}
                    placeholder="粘贴完整文本"
                    aria-invalid={Boolean(fieldErrors.source)}
                    className="min-h-48 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-6 text-text outline-none transition-[border-color,box-shadow] focus:border-ring focus:ring-3 focus:ring-ring/20 aria-invalid:border-destructive"
                  />
                  {fieldErrors.source && (
                    <span className="block text-[11px] text-destructive">{fieldErrors.source}</span>
                  )}
                </label>
              )}
            </div>
          </section>
        ) : (
          <>
            <PreflightSummary draft={draft} />

            <section className="grid gap-5 border-b border-border px-6 py-5 lg:grid-cols-2">
              <div>
                <h3 className="text-balance text-sm font-semibold text-text">解析设置</h3>
                <p className="mt-1 text-pretty text-xs text-muted-foreground">
                  检测结果不可靠时可手动指定编码；粘贴文本固定使用 UTF-8。
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1.5 text-xs text-muted-foreground">
                    <span>文本编码</span>
                    <select
                      value={encoding}
                      onChange={(event) => {
                        setEncoding(event.target.value as ReferenceTextEncoding)
                        setEstimate(null)
                      }}
                      disabled={draft.inputKind === 'paste' || activeAction !== null}
                      className="h-10 w-full rounded-md border border-input bg-surface-1 px-2 text-xs text-text"
                    >
                      <option value="utf-8">UTF-8</option>
                      <option value="utf-8-bom">UTF-8 BOM</option>
                      <option value="gbk">GBK</option>
                      <option value="gb18030">GB18030</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-xs text-muted-foreground">
                    <span>原文保留</span>
                    <select
                      value={retentionPolicy}
                      onChange={(event) =>
                        setRetentionPolicy(event.target.value as typeof retentionPolicy)
                      }
                      disabled={activeAction !== null}
                      className="h-10 w-full rounded-md border border-input bg-surface-1 px-2 text-xs text-text"
                    >
                      <option value="manual_delete">手动删除</option>
                      <option value="keep_local">保留在本机</option>
                      <option value="delete_after_activation">激活后删除</option>
                    </select>
                  </label>
                </div>
              </div>

              <div>
                <h3 className="text-balance text-sm font-semibold text-text">权利确认</h3>
                <p className="mt-1 text-pretty text-xs text-muted-foreground">
                  原文保持在独立参考源存储中，不写入当前小说的人物、剧情或账本。
                </p>
                <label className="mt-4 block space-y-1.5 text-xs text-muted-foreground">
                  <span>权利说明</span>
                  <Input
                    value={rightsStatement}
                    onChange={(event) => setRightsStatement(event.target.value)}
                    placeholder="授权、自有文本或其他合法来源"
                    disabled={activeAction !== null}
                  />
                </label>
                <label className="mt-3 flex min-h-10 items-start gap-2 text-xs leading-5 text-text">
                  <input
                    type="checkbox"
                    checked={rightsConfirmed}
                    onChange={(event) => {
                      setRightsConfirmed(event.target.checked)
                      setFieldErrors((current) => ({ ...current, rights: undefined }))
                    }}
                    disabled={activeAction !== null}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>我确认有权分析此文本，并了解原文仅保存在本机参考源存储中。</span>
                </label>
                {fieldErrors.rights && (
                  <p className="mt-1 text-[11px] text-destructive">{fieldErrors.rights}</p>
                )}
              </div>
            </section>

            <details className="group border-b border-border">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-6 py-3 marker:hidden">
                <div>
                  <p className="text-xs font-semibold text-text">模型上下文与费用预估（仅展示）</p>
                  <p className="mt-1 text-pretty text-[11px] text-muted-foreground">
                    用于检查后续分析的硬限制和费用警告；当前操作不会调用模型。
                  </p>
                </div>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-border bg-surface-1/40 px-6 py-4">
                {providersQuery.isError ? (
                  <div className="flex items-center justify-between gap-4 text-xs text-destructive">
                    <span>Provider 和模型配置读取失败</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void providersQuery.refetch()}
                    >
                      <RotateCcw className="size-3.5" /> 重试
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-48 flex-1 space-y-1.5 text-xs text-muted-foreground">
                      <span>Provider</span>
                      <select
                        value={providerId}
                        onChange={(event) => {
                          setProviderId(event.target.value)
                          setModelId('')
                          setEstimate(null)
                        }}
                        disabled={activeAction !== null || providersQuery.isLoading}
                        className="h-10 w-full rounded-md border border-input bg-surface-1 px-2 text-xs text-text"
                      >
                        {providersQuery.data?.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="min-w-56 flex-1 space-y-1.5 text-xs text-muted-foreground">
                      <span>模型</span>
                      <select
                        value={modelId}
                        onChange={(event) => {
                          setModelId(event.target.value)
                          setEstimate(null)
                        }}
                        disabled={activeAction !== null || providersQuery.isLoading}
                        className="h-10 w-full rounded-md border border-input bg-surface-1 px-2 text-xs text-text"
                      >
                        <option value="">选择模型</option>
                        {provider?.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name} · {(model.contextWindow ?? 32768).toLocaleString()} ctx
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      variant="outline"
                      className="h-10"
                      onClick={handleEstimate}
                      disabled={activeAction !== null || !providerId || !modelId}
                    >
                      {activeAction === 'estimate' ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Calculator className="size-4" />
                      )}
                      估算限制与费用
                    </Button>
                  </div>
                )}
                {estimate && <EstimateResult estimate={estimate} />}
              </div>
            </details>
          </>
        )}
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-4 border-t border-destructive/20 bg-destructive/5 px-5 py-2.5"
        >
          <div className="flex min-w-0 items-center gap-2 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="truncate" title={actionError.message}>
              {actionError.message}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={retryFailedAction}>
            <RotateCcw className="size-3.5" /> 重试
          </Button>
        </div>
      )}

      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-surface-1 px-5 py-3">
        <div className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
          {draft ? (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          )}
          <span className="text-pretty">
            {draft
              ? rightsConfirmed
                ? '将只执行本地清洗、章节识别和统计，不调用模型。'
                : '确认文本分析权利后即可生成本地报告。'
              : '预检不会调用模型，也不会把原文写入当前项目事实。'}
          </span>
        </div>
        {draft ? (
          <Button
            className="h-10 shrink-0"
            onClick={handleConfirmAndParse}
            disabled={activeAction !== null || !rightsConfirmed || !draft.supported}
          >
            {activeAction === 'parse' ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            确认并生成本地报告
          </Button>
        ) : (
          <Button
            className="h-10 shrink-0"
            onClick={handlePreflight}
            disabled={activeAction !== null}
          >
            {activeAction === 'preflight' ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <FileText className="size-4" />
            )}
            开始编码预检
          </Button>
        )}
      </footer>
    </div>
  )
}

function ImportProgress({ currentStep }: { currentStep: number }): ReactElement {
  return (
    <div className="border-b border-border bg-surface-1/40 px-6 py-3">
      <ol className="grid grid-cols-3 gap-3" aria-label="导入进度">
        {IMPORT_STEPS.map((label, index) => {
          const step = index + 1
          const complete = step < currentStep
          const active = step === currentStep
          return (
            <li
              key={label}
              aria-current={active ? 'step' : undefined}
              className={`flex items-center gap-2 text-xs ${active ? 'font-medium text-primary' : complete ? 'text-success' : 'text-muted-foreground'}`}
            >
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[10px] tabular-nums ${active ? 'bg-primary text-primary-foreground' : complete ? 'bg-success/10 text-success' : 'bg-muted'}`}
              >
                {complete ? <Check className="size-3.5" /> : step}
              </span>
              <span className="truncate">{label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function PreflightSummary({ draft }: { draft: ReferencePreflightResult }): ReactElement {
  const confidence = Math.round(draft.encodingConfidence * 100)
  return (
    <section className="border-b border-border px-6 py-5">
      <div className="flex items-start gap-3">
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-full ${draft.supported ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}
        >
          {draft.supported ? (
            <CheckCircle2 className="size-5" />
          ) : (
            <AlertCircle className="size-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-text">{draft.displayName}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {draft.supported
                  ? '编码预检完成，可以确认解析设置。'
                  : '当前文件未通过硬限制，无法继续解析。'}
              </p>
            </div>
            <span
              className={`rounded-md px-2 py-1 text-[11px] font-medium ${draft.supported ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}
            >
              {draft.supported ? '预检通过' : '已阻止'}
            </span>
          </div>
          <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryMetric
              label="格式 / 大小"
              value={`${draft.fileFormat.toUpperCase()} / ${(draft.fileSize / 1024).toFixed(1)} KB`}
            />
            <SummaryMetric
              label="字符 / Token"
              value={`${draft.characterCount.toLocaleString()} / ${draft.estimatedTokens.toLocaleString()}`}
            />
            <SummaryMetric
              label="编码置信度"
              value={`${draft.detectedEncoding.toUpperCase()} / ${confidence}%`}
            />
            <SummaryMetric label="预计章节" value={String(draft.estimatedChapterCount)} />
            <SummaryMetric label="标准化哈希" value={`${draft.contentHash.slice(0, 12)}...`} mono />
          </dl>
          {draft.warnings.length > 0 && (
            <div className="mt-4 space-y-1 border-l-2 border-amber-500 pl-3 text-xs text-amber-700 dark:text-amber-300">
              {draft.warnings.map((warning) => (
                <p key={warning} className="text-pretty">
                  {warning}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function SummaryMetric({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 truncate text-xs font-medium tabular-nums text-text ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

function EstimateResult({ estimate }: { estimate: ReferenceTokenBudgetEstimate }): ReactElement {
  return (
    <div
      className={`mt-4 border-l-2 pl-3 text-xs ${estimate.withinLimit ? 'border-success' : 'border-destructive'}`}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryMetric
          label="有效输入上限"
          value={`${estimate.effectiveInputLimit.toLocaleString()} tokens`}
        />
        <SummaryMetric
          label="所选文本"
          value={`${estimate.selectedTextTokens.toLocaleString()} tokens`}
        />
        <SummaryMetric
          label="费用区间"
          value={
            estimate.estimatedCost
              ? `${estimate.estimatedCost.currency} ${estimate.estimatedCost.min} - ${estimate.estimatedCost.max}`
              : 'Provider 未配置价格'
          }
        />
      </div>
      {estimate.localChunkPlan.splitRequired && (
        <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          已按章节在本地分为 {estimate.localChunkPlan.chunks.length} 包，每包目标约{' '}
          {estimate.localChunkPlan.targetTokens.toLocaleString()} tokens。
        </div>
      )}
      <p
        className={`mt-3 font-medium ${estimate.withinLimit ? 'text-success' : 'text-destructive'}`}
      >
        {estimate.withinLimit
          ? estimate.localChunkPlan.splitRequired
            ? '整本会按章节边界合并分包处理，单个完整章节均可放入模型输入预算。'
            : '当前所选文本在模型有效输入预算内。'
          : `超出有效输入预算 ${estimate.excessTokens.toLocaleString()} tokens。`}
      </p>
      {estimate.warnings.length > 0 && (
        <div className="mt-2 space-y-1 text-muted-foreground">
          {estimate.warnings.map((warning) => (
            <p key={warning} className="text-pretty">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
