import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { AlertTriangle, Check, LoaderCircle, RotateCcw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  generateChapterOutline,
  type ChapterOutlineGenerationMode,
  type ChapterOutlineGenerationResult,
  type NovelChapter
} from '@/api/novel-client'
import { FieldRow, SectionHeader, TextArea, TextInput } from './shared'

export interface AppliedChapterOutlineGeneration {
  generationId: string
  outlineHash: string
  contentRevisionId: string | null
}

export function ChapterOutlineEditor({
  entity,
  value,
  saveError,
  onChange,
  onApplyGeneration
}: {
  entity: NovelChapter
  value: string
  saveError?: string | null
  onChange: (value: string) => void
  onApplyGeneration: (outline: string, generation: AppliedChapterOutlineGeneration) => void
}): ReactElement {
  const [mode, setMode] = useState<ChapterOutlineGenerationMode>(
    value.trim() ? 'rewrite' : 'create'
  )
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState<ChapterOutlineGenerationResult | null>(null)
  const [sourceOutline, setSourceOutline] = useState('')
  const [generating, setGenerating] = useState(false)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setMode((entity.outline ?? '').trim() ? 'rewrite' : 'create')
    setInstruction('')
    setResult(null)
    setSourceOutline('')
    setApplied(false)
    setError(null)
    controllerRef.current?.abort()
    controllerRef.current = null
    setGenerating(false)
  }, [entity.id, entity.outline, entity.status])

  useEffect(() => () => controllerRef.current?.abort(), [])

  useEffect(() => {
    if (!value.trim() && mode !== 'create') setMode('create')
  }, [mode, value])

  const handleGenerate = useCallback(async () => {
    if (generating || entity.status === 'published') return
    const controller = new AbortController()
    controllerRef.current = controller
    setGenerating(true)
    setError(null)
    setApplied(false)
    setResult(null)
    const inputOutline = value
    setSourceOutline(inputOutline)
    try {
      const generated = await generateChapterOutline(
        entity.projectId,
        entity.chapterNumber,
        {
          mode,
          currentOutline: inputOutline,
          expectedOutline: entity.outline ?? '',
          ...(instruction.trim() ? { instruction: instruction.trim() } : {})
        },
        controller.signal
      )
      if (controller.signal.aborted) return
      setResult(generated)
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError'))
        return
      setError(err instanceof Error ? err.message : '章纲生成失败')
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null
        setGenerating(false)
      }
    }
  }, [
    entity.chapterNumber,
    entity.outline,
    entity.projectId,
    entity.status,
    generating,
    instruction,
    mode,
    value
  ])

  const handleCancel = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setGenerating(false)
  }, [])

  const sourceChanged = result !== null && !applied && value !== sourceOutline
  const disabled = entity.status === 'published'

  return (
    <div className="space-y-2.5">
      <SectionHeader
        title="章纲"
        action={
          generating ? (
            <Button type="button" size="xs" variant="outline" onClick={handleCancel}>
              <X />
              取消
            </Button>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="soft"
              onClick={() => void handleGenerate()}
              disabled={disabled}
              title={disabled ? '已发布章节不能修改章纲' : '根据当前项目状态生成章纲草稿'}
            >
              <Sparkles />
              AI 生成章纲
            </Button>
          )
        }
      />

      <FieldRow label="章纲内容" hint={disabled ? '已发布' : '保存修改后生效'}>
        <TextArea
          variant="long"
          aria-label="章纲内容"
          value={value}
          placeholder="编写章纲（生成的统一起点）..."
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </FieldRow>

      {!disabled && (
        <FieldRow label="生成要求" hint="可选">
          <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-2">
            <Select
              value={mode}
              onValueChange={(next) => setMode(next as ChapterOutlineGenerationMode)}
            >
              <SelectTrigger className="w-full" aria-label="章纲生成方式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="create">重新规划</SelectItem>
                <SelectItem value="rewrite" disabled={!value.trim()}>
                  改写
                </SelectItem>
                <SelectItem value="expand" disabled={!value.trim()}>
                  扩写
                </SelectItem>
              </SelectContent>
            </Select>
            <TextInput
              value={instruction}
              aria-label="章纲生成补充要求"
              placeholder="例如：加强结尾悬念"
              maxLength={2000}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </div>
        </FieldRow>
      )}

      {generating && (
        <div className="flex min-h-10 items-center gap-2 border-y border-border/60 px-1 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          正在生成章纲草稿...
        </div>
      )}

      {result && (
        <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-text">AI 章纲草稿</span>
            <span className="text-nano text-muted-foreground tabular-nums">
              {result.draft.sceneCountEstimate} 个预计场景
            </span>
          </div>

          <dl className="grid gap-1.5 text-xs">
            <div>
              <dt className="font-medium text-text-secondary">本章目标</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                {result.draft.chapterGoal}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-text-secondary">开篇状态</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                {result.draft.openingState}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-text-secondary">核心推进</dt>
              <dd className="mt-0.5 space-y-0.5 text-muted-foreground">
                {result.draft.progression.map((item, index) => (
                  <div key={`${index}:${item}`}>
                    {index + 1}. {item}
                  </div>
                ))}
              </dd>
            </div>
            {result.draft.obstacles.length > 0 && (
              <div>
                <dt className="font-medium text-text-secondary">阻力与代价</dt>
                <dd className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                  {result.draft.obstacles.join('；')}
                </dd>
              </div>
            )}
            <div>
              <dt className="font-medium text-text-secondary">转折与结尾</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                {result.draft.turningPoint}；{result.draft.endingState}；{result.draft.hook}
              </dd>
            </div>
            {result.draft.povSuggestions.length > 0 && (
              <div>
                <dt className="font-medium text-text-secondary">POV</dt>
                <dd className="mt-0.5 text-muted-foreground">
                  {result.draft.povSuggestions
                    .map((item) =>
                      item.mode === 'single'
                        ? `${item.characterName}（单一视角）`
                        : item.mode === 'omniscient'
                          ? '全知视角'
                          : '无固定视角'
                    )
                    .join('、')}
                </dd>
              </div>
            )}
            {result.draft.storylines.length > 0 && (
              <div>
                <dt className="font-medium text-text-secondary">故事线推进</dt>
                <dd className="mt-0.5 space-y-0.5 text-muted-foreground">
                  {result.draft.storylines.map((item) => (
                    <div key={item.storylineId}>
                      {item.storylineName}：{item.intendedProgress}
                    </div>
                  ))}
                </dd>
              </div>
            )}
          </dl>

          {(result.warnings.length > 0 ||
            result.draft.continuityRisks.length > 0 ||
            sourceChanged) && (
            <div className="space-y-1 border-t border-border/60 pt-2 text-nano text-amber-700 dark:text-amber-400">
              {sourceChanged && (
                <div className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  当前编辑内容在生成后发生了变化，请重新生成后再应用。
                </div>
              )}
              {result.warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
              {result.draft.continuityRisks.map((risk, index) => (
                <div key={`${risk.type}:${index}`}>{risk.description}</div>
              ))}
            </div>
          )}

          <div className="max-h-52 overflow-y-auto whitespace-pre-wrap border-y border-border/60 py-2 text-xs leading-5 text-text">
            {result.draft.outlineText}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-nano text-muted-foreground">
              {result.model.modelId ?? '默认模型'} · {result.model.promptVersion}
            </span>
            <div className="flex gap-1.5">
              <Button type="button" size="xs" variant="ghost" onClick={() => setResult(null)}>
                <X />
                {applied ? '关闭' : '放弃'}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void handleGenerate()}
                disabled={disabled}
              >
                <RotateCcw />
                重新生成
              </Button>
              <Button
                type="button"
                size="xs"
                onClick={() => {
                  onApplyGeneration(result.draft.outlineText, {
                    generationId: result.generationId,
                    outlineHash: result.base.outlineHash,
                    contentRevisionId: result.base.contentRevisionId
                  })
                  setApplied(true)
                }}
                disabled={disabled || sourceChanged || applied}
              >
                <Check />
                {applied ? '已应用' : '应用到编辑器'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {(error || saveError) && <p className="text-xs text-destructive">{error ?? saveError}</p>}
    </div>
  )
}
