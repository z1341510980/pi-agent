import { useEffect, useMemo, useState, type ChangeEvent, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  FileText,
  LoaderCircle,
  Upload,
  ClipboardPaste,
  Calculator,
  Check
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

interface ReferenceImportPanelProps {
  projectId: string
  initialSource?: ReferenceSourceDetail | null
  onParsed: (source: ReferenceSourceDetail) => void
  onSourceCreated: (source: ReferenceSourceDetail) => void
}

export function ReferenceImportPanel({
  projectId,
  initialSource,
  onParsed,
  onSourceCreated
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providersQuery = useQuery({
    queryKey: ['reference-analysis', 'providers'],
    queryFn: listReferenceProviders
  })
  const provider = useMemo(
    () => providersQuery.data?.find((item) => item.id === providerId),
    [providersQuery.data, providerId]
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

  async function handlePreflight(): Promise<void> {
    setError(null)
    setEstimate(null)
    if (!displayName.trim()) {
      setError('请输入参考源名称')
      return
    }
    if (mode === 'file' && !file) {
      setError('请选择 TXT 或 Markdown 文件')
      return
    }
    if (mode === 'paste' && !pasteText.trim()) {
      setError('请粘贴参考文本')
      return
    }
    setBusy(true)
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
      setError(cause instanceof Error ? cause.message : '预检失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleEstimate(): Promise<void> {
    if (!draft || !providerId || !modelId) return
    setBusy(true)
    setError(null)
    try {
      setEstimate(await estimateReferenceAnalysis(draft.id, { providerId, modelId }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预算估算失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirmAndParse(): Promise<void> {
    if (!draft) return
    if (!rightsConfirmed) {
      setError('请先确认有权分析该文本')
      return
    }
    setBusy(true)
    setError(null)
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
      setError(cause instanceof Error ? cause.message : '解析失败')
    } finally {
      setBusy(false)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.target.files?.[0] ?? null
    setFile(next)
    if (next && !displayName) setDisplayName(next.name.replace(/\.(txt|md|markdown)$/i, ''))
  }

  return (
    <div className="h-full overflow-y-auto">
      <section className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={() => setMode('file')}
            className={`inline-flex h-8 items-center gap-1.5 border-b-2 px-2 text-xs font-medium ${mode === 'file' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-text'}`}
          >
            <Upload className="size-3.5" /> 文件
          </button>
          <button
            type="button"
            onClick={() => setMode('paste')}
            className={`inline-flex h-8 items-center gap-1.5 border-b-2 px-2 text-xs font-medium ${mode === 'paste' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-text'}`}
          >
            <ClipboardPaste className="size-3.5" /> 粘贴文本
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(180px,280px)_1fr_auto] md:items-end">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>参考源名称</span>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如：叙事节奏参考"
            />
          </label>
          {mode === 'file' ? (
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>TXT / Markdown</span>
              <input
                type="file"
                accept=".txt,.md,.markdown,text/plain,text/markdown"
                onChange={handleFileChange}
                className="block h-9 w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs text-text file:mr-3 file:border-0 file:bg-transparent file:text-xs file:font-medium"
              />
            </label>
          ) : (
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>文本内容</span>
              <textarea
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                placeholder="粘贴完整文本"
                className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-text outline-none focus:border-ring"
              />
            </label>
          )}
          <Button onClick={handlePreflight} disabled={busy}>
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <FileText className="size-4" />
            )}
            编码预检
          </Button>
        </div>
      </section>

      {draft && (
        <>
          <section className="grid gap-4 border-b border-border px-5 py-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-3 text-xs font-semibold text-text">导入确认</h3>
              <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs">
                <dt className="text-muted-foreground">格式 / 大小</dt>
                <dd className="text-text">
                  {draft.fileFormat.toUpperCase()} / {(draft.fileSize / 1024).toFixed(1)} KB
                </dd>
                <dt className="text-muted-foreground">字符 / Token</dt>
                <dd className="text-text tabular-nums">
                  {draft.characterCount.toLocaleString()} / {draft.estimatedTokens.toLocaleString()}
                </dd>
                <dt className="text-muted-foreground">预计章节</dt>
                <dd className="text-text tabular-nums">{draft.estimatedChapterCount}</dd>
                <dt className="text-muted-foreground">标准化哈希</dt>
                <dd className="truncate font-mono text-[11px] text-text" title={draft.contentHash}>
                  {draft.contentHash.slice(0, 16)}...
                </dd>
              </dl>
              {draft.warnings.length > 0 && (
                <div className="mt-3 space-y-1 border-l-2 border-amber-500 pl-3 text-xs text-amber-700 dark:text-amber-300">
                  {draft.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>文本编码</span>
                <select
                  value={encoding}
                  onChange={(event) => setEncoding(event.target.value as ReferenceTextEncoding)}
                  disabled={draft.inputKind === 'paste'}
                  className="h-9 w-full rounded-md border border-input bg-surface-1 px-2 text-xs text-text"
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="utf-8-bom">UTF-8 BOM</option>
                  <option value="gbk">GBK</option>
                  <option value="gb18030">GB18030</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>原文保留</span>
                <select
                  value={retentionPolicy}
                  onChange={(event) =>
                    setRetentionPolicy(event.target.value as typeof retentionPolicy)
                  }
                  className="h-9 w-full rounded-md border border-input bg-surface-1 px-2 text-xs text-text"
                >
                  <option value="manual_delete">手动删除</option>
                  <option value="keep_local">保留在本机</option>
                  <option value="delete_after_activation">激活后删除</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                <span>权利说明</span>
                <Input
                  value={rightsStatement}
                  onChange={(event) => setRightsStatement(event.target.value)}
                  placeholder="授权、自有文本或其他合法来源"
                />
              </label>
              <label className="flex items-start gap-2 text-xs text-text sm:col-span-2">
                <input
                  type="checkbox"
                  checked={rightsConfirmed}
                  onChange={(event) => setRightsConfirmed(event.target.checked)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>我确认有权分析此文本，并了解原文仅保存在本机参考源存储中。</span>
              </label>
            </div>
          </section>

          <section className="border-b border-border px-5 py-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-48 flex-1 space-y-1 text-xs text-muted-foreground">
                <span>Provider</span>
                <select
                  value={providerId}
                  onChange={(event) => {
                    setProviderId(event.target.value)
                    setModelId('')
                    setEstimate(null)
                  }}
                  className="h-9 w-full rounded-md border border-input bg-surface-1 px-2 text-xs text-text"
                >
                  {providersQuery.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-56 flex-1 space-y-1 text-xs text-muted-foreground">
                <span>模型</span>
                <select
                  value={modelId}
                  onChange={(event) => {
                    setModelId(event.target.value)
                    setEstimate(null)
                  }}
                  className="h-9 w-full rounded-md border border-input bg-surface-1 px-2 text-xs text-text"
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
                onClick={handleEstimate}
                disabled={busy || !providerId || !modelId}
              >
                <Calculator className="size-4" /> 估算限制与费用
              </Button>
            </div>
            {estimate && (
              <div
                className={`mt-3 grid gap-2 border-l-2 pl-3 text-xs sm:grid-cols-3 ${estimate.withinLimit ? 'border-success' : 'border-destructive'}`}
              >
                <p>
                  <span className="text-muted-foreground">有效输入上限：</span>
                  {estimate.effectiveInputLimit.toLocaleString()} tokens
                </p>
                <p>
                  <span className="text-muted-foreground">所选文本：</span>
                  {estimate.selectedTextTokens.toLocaleString()} tokens
                </p>
                <p>
                  <span className="text-muted-foreground">费用：</span>
                  {estimate.estimatedCost
                    ? `${estimate.estimatedCost.currency} ${estimate.estimatedCost.min} - ${estimate.estimatedCost.max}`
                    : 'Provider 未配置价格'}
                </p>
                <div className="sm:col-span-3 space-y-1 text-muted-foreground">
                  {estimate.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <span>
                本阶段只执行本地解析与统计，不调用模型、不自动应用模板，也不写入人物或剧情实体。
              </span>
            </div>
            <Button onClick={handleConfirmAndParse} disabled={busy || !rightsConfirmed}>
              {busy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              确认并生成本地报告
            </Button>
          </section>
        </>
      )}

      {error && (
        <p className="mx-5 my-3 border-l-2 border-destructive pl-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
