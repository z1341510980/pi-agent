/**
 * EntityCreateDialog：新建实体对话框
 *
 * 触发：右键分组空白处（ruler 行下方、分组色条下方、行尾空单元格）
 *
 * 两阶段流程：
 * 1. input：用户输入核心风格描述（一句话，如 "沉默寡言的剑客" / "林墨与苏晚的信任危机"）
 *    - 直接「创建」：仅传 name/description + firstChapter 给 onSubmit（最简创建）
 *    - 「AI 补全」：调 aiGenerateEntity 拉取完整字段，进入 review 阶段
 * 2. review：展示 AI 生成的完整字段（按 entityType 适配），用户编辑后「确认创建」
 *
 * 不同类型实体的字段：
 * - character：name + 11 字段（identity/personality/appearance/...）
 * - conflict：description + type + intensity + stage + tier + participants + climaxChapter + climaxType + stakes + twistPotential
 * - foreshadow：description + category + status
 * - faction：name + description + type + ideology + strength + resources + allies + enemies + status
 * - location：name + description + type + significance + status
 * - world_element：category + name + description + attributes
 */

import { useEffect, useState, type ReactElement } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sparkles, Loader2 } from 'lucide-react'
import {
  GROUP_META,
  type MatrixEntityKind,
} from './matrix-logic'
import {
  aiGenerateEntity,
  type EntityGenerationProgressEvent,
  type GeneratedEntityResult,
} from '@/api/novel-client'
import { useNovelDataStore } from '@/stores/novel-data-store'

export interface EntityCreateDialogProps {
  open: boolean
  entityType: MatrixEntityKind | null
  /** 默认起始章节（点击的列号，用于新建时填充 firstChapter） */
  defaultChapter: number | null
  onClose: () => void
  onSubmit: (kind: MatrixEntityKind, data: EntityCreatePayload) => Promise<void>
}

export interface EntityCreatePayload {
  /** 简单创建模式：name 或 description */
  name?: string
  description?: string
  /** 起始章节 */
  firstChapter?: number | null
  /** AI 补全模式：完整字段（按 entityType 区分） */
  aiFields?: GeneratedEntityResult
}

const CORE_LABEL: Record<MatrixEntityKind, string> = {
  character: '角色核心风格',
  conflict: '冲突核心描述',
  clue: '线索核心描述',
  foreshadow: '伏笔核心描述',
  faction: '势力核心描述',
  location: '地点核心描述',
  world_element: '要素核心描述',
  info_layer: '信息差核心描述',
  item: '物品核心描述',
}

const CORE_PLACEHOLDER: Record<MatrixEntityKind, string> = {
  character: '如：沉默寡言的剑客，背负血海深仇',
  conflict: '如：林墨与苏晚之间的信任危机',
  clue: '如：现场留下一枚不属于死者的铜扣',
  foreshadow: '如：林墨母亲留下的玉佩',
  faction: '如：青衫会，江南最大的江湖势力',
  location: '如：青衫会总舵，藏于云雾山中',
  world_element: '如：玉佩之力，可镇压邪灵',
  info_layer: '如：林墨真实身世，读者暂不知',
  item: '如：母亲留下的玉佩，能感应被封印的记忆',
}

export function EntityCreateDialog({
  open,
  entityType,
  defaultChapter,
  onClose,
  onSubmit,
}: EntityCreateDialogProps): ReactElement | null {
  const [step, setStep] = useState<'input' | 'review'>('input')
  const [coreStyle, setCoreStyle] = useState('')
  const [aiFields, setAiFields] = useState<GeneratedEntityResult | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [aiGenerating, setAiGenerating] = useState(false)
  const [progressMsg, setProgressMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)

  useEffect(() => {
    if (open) {
      setStep('input')
      setCoreStyle('')
      setAiFields(null)
      setAiGenerating(false)
      setProgressMsg(null)
      setError(null)
      setSubmitting(false)
    }
  }, [open, entityType])

  if (!entityType) return null

  const meta = GROUP_META[entityType]
  const isNameField = entityType === 'character' || entityType === 'faction' || entityType === 'location' || entityType === 'world_element' || entityType === 'item'

  // ── 简单创建（跳过 AI）──
  const handleSimpleCreate = async (): Promise<void> => {
    const trimmed = coreStyle.trim()
    if (!trimmed) {
      setError(`${CORE_LABEL[entityType]}不能为空`)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const payload: EntityCreatePayload = isNameField
        ? { name: trimmed, firstChapter: defaultChapter }
        : { description: trimmed, firstChapter: defaultChapter }
      await onSubmit(entityType, payload)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建失败'
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  // ── AI 补全 ──
  const handleAiGenerate = async (): Promise<void> => {
    const trimmed = coreStyle.trim()
    if (!trimmed) {
      setError(`${CORE_LABEL[entityType]}不能为空`)
      return
    }
    setAiGenerating(true)
    setError(null)
    setProgressMsg('正在准备...')
    try {
      if (!currentProjectId) {
        throw new Error('未找到当前项目 ID')
      }
      if (!entityType || entityType === 'info_layer' || entityType === 'clue') {
        throw new Error('当前实体类型暂不支持 AI 补全')
      }
      const result = await aiGenerateEntity(
        currentProjectId,
        { entityType, coreStyle: trimmed },
        (event: EntityGenerationProgressEvent) => {
          setProgressMsg(event.message)
        },
      )
      setAiFields(result)
      setStep('review')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI 生成失败'
      setError(msg)
    } finally {
      setAiGenerating(false)
      setProgressMsg(null)
    }
  }

  // ── Review 阶段确认 ──
  const handleReviewSubmit = async (): Promise<void> => {
    if (!aiFields) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(entityType, { aiFields, firstChapter: defaultChapter })
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建失败'
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <span className="mr-1.5" style={{ color: meta.color }}>{meta.icon}</span>
            新建{meta.name}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {step === 'input'
              ? <>输入一句核心描述，可直接创建或用 AI 补全完整字段{defaultChapter != null ? <>，起始章节为第 <span className="tabular-nums">{defaultChapter}</span> 章</> : ''}。</>
              : <>AI 已生成字段，可调整后确认创建。</>}
          </DialogDescription>
        </DialogHeader>

        {step === 'input' ? (
          <div className="py-2 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="entity-core-input">{CORE_LABEL[entityType]}</Label>
              <Input
                id="entity-core-input"
                autoFocus
                value={coreStyle}
                onChange={(e) => setCoreStyle(e.target.value)}
                placeholder={CORE_PLACEHOLDER[entityType]}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !aiGenerating) {
                    e.preventDefault()
                    void handleSimpleCreate()
                  }
                }}
                disabled={submitting || aiGenerating}
              />
            </div>
            {progressMsg && (
              <p className="text-xs text-primary flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" />
                {progressMsg}
              </p>
            )}
            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        ) : (
          <ReviewFields entityType={entityType} aiFields={aiFields} />
        )}

        <DialogFooter>
          {step === 'input' ? (
            <>
              <Button variant="ghost" onClick={onClose} disabled={submitting || aiGenerating}>取消</Button>
              {entityType !== 'clue' && entityType !== 'info_layer' && (
                <Button
                  variant="outline"
                  onClick={() => void handleAiGenerate()}
                  disabled={aiGenerating || submitting || !coreStyle.trim()}
                >
                  {aiGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                  <span className="ml-1">AI 补全</span>
                </Button>
              )}
              <Button
                onClick={() => void handleSimpleCreate()}
                disabled={submitting || aiGenerating || !coreStyle.trim()}
              >
                {submitting ? '创建中…' : '直接创建'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep('input')} disabled={submitting}>返回</Button>
              <Button onClick={() => void handleReviewSubmit()} disabled={submitting}>
                {submitting ? '创建中…' : '确认创建'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Review 阶段字段表单（按 entityType 渲染对应字段，只读展示为主） ──

function ReviewFields({
  entityType,
  aiFields,
}: {
  entityType: MatrixEntityKind
  aiFields: GeneratedEntityResult | null
}): ReactElement {
  if (!aiFields) return <div className="py-4 text-center text-xs text-muted-foreground">无生成数据</div>

  return (
    <div className="py-2 space-y-2 max-h-[60vh] overflow-y-auto">
      <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
        以下字段由 AI 生成，确认后将作为实体创建。详细字段可在创建后于详情面板编辑。
      </div>
      {entityType === 'character' && aiFields.type === 'character' && (
        <CharacterReview data={aiFields.data} />
      )}
      {entityType === 'conflict' && aiFields.type === 'conflict' && (
        <ConflictReview data={aiFields.data} />
      )}
      {entityType === 'foreshadow' && aiFields.type === 'foreshadow' && (
        <ForeshadowReview data={aiFields.data} />
      )}
      {entityType === 'faction' && aiFields.type === 'faction' && (
        <FactionReview data={aiFields.data} />
      )}
      {entityType === 'location' && aiFields.type === 'location' && (
        <LocationReview data={aiFields.data} />
      )}
      {entityType === 'item' && aiFields.type === 'item' && (
        <ItemReview data={aiFields.data} />
      )}
      {entityType === 'world_element' && aiFields.type === 'world_element' && (
        <WorldElementReview data={aiFields.data} />
      )}
    </div>
  )
}

function FieldRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 items-start text-xs">
      <span className="text-muted-foreground pt-1.5">{label}</span>
      <div className="rounded border border-border bg-surface-1 px-2 py-1.5 text-text min-h-[28px] max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words">
        {value || <span className="text-muted-foreground italic">空</span>}
      </div>
    </div>
  )
}

function CharacterReview({ data }: { data: import('@/api/novel-client').GeneratedCharacterFields }): ReactElement {
  return (
    <>
      <FieldRow label="姓名" value={data.name} />
      <FieldRow label="描述" value={data.description} />
      <FieldRow label="身份" value={data.identity} />
      <FieldRow label="性格" value={data.personality} />
      <FieldRow label="外貌" value={data.appearance} />
      <FieldRow label="当前状态" value={data.currentState} />
      <FieldRow label="当前目标" value={data.currentGoal} />
      <FieldRow label="当前压力" value={data.currentPressure} />
      <FieldRow label="秘密" value={data.secret} />
      <FieldRow label="弧光阶段" value={data.arcStage} />
      <FieldRow label="说话风格" value={data.speechStyle} />
    </>
  )
}

function ConflictReview({ data }: { data: import('@/api/novel-client').GeneratedConflictFields }): ReactElement {
  const climaxChapterStr = data.climaxChapter != null ? `第 ${data.climaxChapter} 章` : ''
  const twistPotentialStr = data.twistPotential != null ? `${data.twistPotential}/10` : ''
  return (
    <>
      <FieldRow label="描述" value={data.description} />
      <FieldRow label="类型" value={data.type} />
      <FieldRow label="强度" value={String(data.intensity)} />
      <FieldRow label="阶段" value={data.stage} />
      <FieldRow label="层级" value={data.tier} />
      <FieldRow label="参与者" value={data.participants} />
      <FieldRow label="高潮章节" value={climaxChapterStr} />
      <FieldRow label="高潮类型" value={data.climaxType ?? ''} />
      <FieldRow label="赌注" value={data.stakes ?? ''} />
      <FieldRow label="突转潜力" value={twistPotentialStr} />
    </>
  )
}

function ForeshadowReview({ data }: { data: import('@/api/novel-client').GeneratedForeshadowFields }): ReactElement {
  return (
    <>
      <FieldRow label="描述" value={data.description} />
      <FieldRow label="类别" value={data.category} />
      <FieldRow label="状态" value={data.status} />
    </>
  )
}

function FactionReview({ data }: { data: import('@/api/novel-client').GeneratedFactionFields }): ReactElement {
  return (
    <>
      <FieldRow label="名称" value={data.name} />
      <FieldRow label="描述" value={data.description} />
      <FieldRow label="类型" value={data.type} />
      <FieldRow label="理念" value={data.ideology} />
      <FieldRow label="实力" value={data.strength} />
      <FieldRow label="资源" value={data.resources.join('、')} />
      <FieldRow label="盟友" value={data.allies.join('、')} />
      <FieldRow label="敌人" value={data.enemies.join('、')} />
      <FieldRow label="状态" value={data.status} />
    </>
  )
}

function LocationReview({ data }: { data: import('@/api/novel-client').GeneratedLocationFields }): ReactElement {
  return (
    <>
      <FieldRow label="名称" value={data.name} />
      <FieldRow label="描述" value={data.description} />
      <FieldRow label="类型" value={data.type} />
      <FieldRow label="重要性" value={data.significance} />
      <FieldRow label="状态" value={data.status} />
    </>
  )
}

function ItemReview({ data }: { data: import('@/api/novel-client').GeneratedItemFields }): ReactElement {
  return (
    <>
      <FieldRow label="名称" value={data.name} />
      <FieldRow label="描述" value={data.description} />
      <FieldRow label="类型" value={data.type} />
      <FieldRow label="持有者" value={data.ownerId ?? ''} />
      <FieldRow label="状态" value={data.status} />
      <FieldRow label="能力" value={data.abilities} />
      <FieldRow label="来源" value={data.origin} />
    </>
  )
}

function WorldElementReview({ data }: { data: import('@/api/novel-client').GeneratedWorldElementFields }): ReactElement {
  const attrStr = Object.entries(data.attributes)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
  return (
    <>
      <FieldRow label="类别" value={data.category} />
      <FieldRow label="名称" value={data.name} />
      <FieldRow label="描述" value={data.description} />
      <FieldRow label="属性" value={attrStr} />
    </>
  )
}
