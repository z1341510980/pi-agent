import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Sparkles, RotateCcw, Save, X, AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  aiGenerateCharacter,
  updateCharacter,
  deleteCharacter,
  type NovelCharacter,
  type CreateCharacterInput,
} from '@/api/novel-client'

export interface CharacterCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
}

const MAX_CORE_STYLE = 500

/** 角色生成阶段顺序（用于进度指示器） */
const PHASE_ORDER = ['preparing', 'generating', 'parsing', 'completed']

const ARC_STAGE_OPTIONS = [
  { value: 'introduction', label: '出场' },
  { value: 'development', label: '发展' },
  { value: 'struggle', label: '挣扎' },
  { value: 'transformation', label: '转变' },
  { value: 'resolution', label: '收束' },
]

type Step = 'input' | 'review'

interface EditableForm {
  name: string
  description: string
  identity: string
  personality: string
  appearance: string
  currentState: string
  currentGoal: string
  currentPressure: string
  secret: string
  arcStage: string
  speechStyle: string
}

function toForm(c: NovelCharacter): EditableForm {
  return {
    name: c.name,
    description: c.description,
    identity: c.identity,
    personality: c.personality,
    appearance: c.appearance,
    currentState: c.currentState,
    currentGoal: c.currentGoal,
    currentPressure: c.currentPressure,
    secret: c.secret,
    arcStage: c.arcStage,
    speechStyle: c.speechStyle,
  }
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return (
    <textarea
      {...props}
      className={cn(
        'w-full min-h-[60px] rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30',
        props.className,
      )}
    />
  )
}

export function CharacterCreateDialog({
  open,
  onOpenChange,
  projectId,
}: CharacterCreateDialogProps): ReactElement {
  const upsertCharacter = useNovelStore((s) => s.upsertCharacter)
  const removeCharacter = useNovelStore((s) => s.removeCharacter)

  const [step, setStep] = useState<Step>('input')
  const [coreStyle, setCoreStyle] = useState('')
  const [generated, setGenerated] = useState<NovelCharacter | null>(null)
  const [form, setForm] = useState<EditableForm | null>(null)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 进度状态：保留 data 字段以承载流式文本预览（data.partial）
  const [progress, setProgress] = useState<{ phase: string; message: string; data?: { partial?: string } } | null>(null)

  // 打开/关闭时重置状态
  useEffect(() => {
    if (open) {
      setStep('input')
      setCoreStyle('')
      setGenerated(null)
      setForm(null)
      setError(null)
      setGenerating(false)
      setSaving(false)
      setProgress(null)
    }
  }, [open])

  const handleGenerate = useCallback(async () => {
    if (!projectId) {
      setError('未选择项目')
      return
    }
    const trimmed = coreStyle.trim()
    if (!trimmed) {
      setError('请描述角色的核心风格')
      return
    }
    setGenerating(true)
    setError(null)
    setProgress(null)
    try {
      const character = await aiGenerateCharacter(
        projectId,
        { coreStyle: trimmed },
        (event) => {
          // 保留 data 字段以承载流式文本预览（data.partial）
          setProgress({
            phase: event.phase,
            message: event.message,
            data: (event.data as { partial?: string } | undefined) ?? undefined,
          })
        },
      )
      setGenerated(character)
      setForm(toForm(character))
      upsertCharacter(character)
      setStep('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 生成失败')
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }, [projectId, coreStyle, upsertCharacter])

  const handleRegenerate = useCallback(() => {
    setStep('input')
    setGenerated(null)
    setForm(null)
    setError(null)
  }, [])

  const isDirty = (() => {
    if (!generated || !form) return false
    return (Object.keys(form) as (keyof EditableForm)[]).some((k) => form[k] !== toForm(generated)[k])
  })()

  const handleSave = useCallback(async () => {
    if (!generated || !form) {
      onOpenChange(false)
      return
    }
    // 未编辑直接关闭
    if (!isDirty) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: CreateCharacterInput = {
        name: form.name,
        description: form.description,
        identity: form.identity,
        personality: form.personality,
        appearance: form.appearance,
        currentState: form.currentState,
        currentGoal: form.currentGoal,
        currentPressure: form.currentPressure,
        secret: form.secret,
        arcStage: form.arcStage,
        speechStyle: form.speechStyle,
      }
      const updated = await updateCharacter(generated.id, payload)
      upsertCharacter(updated)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [generated, form, isDirty, upsertCharacter, onOpenChange])

  const handleCancel = useCallback(async () => {
    // 如果已生成角色，确认放弃后删除已创建的实体
    if (generated) {
      const confirmed = window.confirm('放弃后将删除 AI 已创建的角色，确认继续？')
      if (!confirmed) return
      try {
        await deleteCharacter(generated.id)
        removeCharacter(generated.id)
      } catch {
        // 后端删除失败不阻塞关闭
      }
    }
    onOpenChange(false)
  }, [generated, removeCharacter, onOpenChange])

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          // 通过点击遮罩/关闭按钮关闭时，若已生成则同样提示
          void handleCancel()
        } else {
          onOpenChange(v)
        }
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            AI 角色创建
          </DialogTitle>
          <DialogDescription>
            {step === 'input'
              ? '描述角色的核心风格，AI 将自动生成完整角色设定'
              : '审阅并编辑 AI 生成的角色设定'}
          </DialogDescription>
        </DialogHeader>

        {step === 'input' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="core-style">核心风格描述</Label>
              <TextArea
                id="core-style"
                value={coreStyle}
                onChange={(e) => setCoreStyle(e.target.value.slice(0, MAX_CORE_STYLE))}
                placeholder="例如：神秘的剑客，外冷内热，背负血海深仇"
                className="min-h-[100px]"
                disabled={generating}
              />
              <div className="flex justify-end text-[10px] text-muted-foreground">
                {coreStyle.length}/{MAX_CORE_STYLE}
              </div>
            </div>
            {generating && (
              <div className="flex flex-col items-center gap-3 py-6">
                <Loader2 className="size-6 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">
                  {progress?.message ?? '正在生成...'}
                </p>
                {/* 流式文本预览：展示 LLM 实时输出的最后一段文本 */}
                {progress?.data?.partial && (
                  <div className="max-h-32 w-full overflow-y-auto rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
                    {progress.data.partial}
                  </div>
                )}
                {progress && (
                  <div className="flex items-center gap-1.5">
                    {PHASE_ORDER.map((phase, i) => (
                      <div
                        key={phase}
                        className={cn(
                          'h-1.5 w-8 rounded-full transition-colors',
                          PHASE_ORDER.indexOf(progress.phase) >= i
                            ? 'bg-primary'
                            : 'bg-muted',
                        )}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            {error && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="size-3" />
                {error}
              </p>
            )}
          </div>
        ) : (
          form && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">姓名</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">简述</Label>
                <TextArea
                  value={form.description}
                  onChange={(e) => setForm((f) => (f ? { ...f, description: e.target.value } : f))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">身份</Label>
                <Input
                  value={form.identity}
                  onChange={(e) => setForm((f) => (f ? { ...f, identity: e.target.value } : f))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">性格</Label>
                <TextArea
                  value={form.personality}
                  onChange={(e) => setForm((f) => (f ? { ...f, personality: e.target.value } : f))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">外貌</Label>
                <TextArea
                  value={form.appearance}
                  onChange={(e) => setForm((f) => (f ? { ...f, appearance: e.target.value } : f))}
                />
              </div>
              <div className="grid grid-cols-1 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">当前状态</Label>
                  <Input
                    value={form.currentState}
                    onChange={(e) => setForm((f) => (f ? { ...f, currentState: e.target.value } : f))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">当前目标</Label>
                  <Input
                    value={form.currentGoal}
                    onChange={(e) => setForm((f) => (f ? { ...f, currentGoal: e.target.value } : f))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">当前压力</Label>
                  <Input
                    value={form.currentPressure}
                    onChange={(e) => setForm((f) => (f ? { ...f, currentPressure: e.target.value } : f))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">秘密</Label>
                  <TextArea
                    value={form.secret}
                    onChange={(e) => setForm((f) => (f ? { ...f, secret: e.target.value } : f))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">弧光阶段</Label>
                  <Select
                    value={form.arcStage}
                    onValueChange={(v) => setForm((f) => (f ? { ...f, arcStage: v } : f))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="选择阶段" />
                    </SelectTrigger>
                    <SelectContent>
                      {ARC_STAGE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">说话风格</Label>
                  <Input
                    value={form.speechStyle}
                    onChange={(e) => setForm((f) => (f ? { ...f, speechStyle: e.target.value } : f))}
                  />
                </div>
              </div>
              {error && (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertCircle className="size-3" />
                  {error}
                </p>
              )}
            </div>
          )
        )}

        <DialogFooter>
          {step === 'input' ? (
            <>
              <Button variant="outline" onClick={handleCancel} disabled={generating}>
                <X className="size-3.5" />
                取消
              </Button>
              <Button onClick={handleGenerate} disabled={generating || !projectId}>
                <Sparkles className="size-3.5" />
                {generating ? '生成中...' : 'AI 生成'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleRegenerate} disabled={saving}>
                <RotateCcw className="size-3.5" />
                重新生成
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={saving}>
                <X className="size-3.5" />
                取消
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                <Save className="size-3.5" />
                {saving ? '保存中...' : isDirty ? '保存' : '完成'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
