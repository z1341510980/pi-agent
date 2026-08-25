import { useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ModelPicker, type ModelRef } from '@/components/novel/model-picker'
import { distillReferenceStyle } from '@/api/novel-client'
import type { StyleDistillDraftApi } from '@/api/novel-client'

export type { StyleDistillDraftApi } from '@/api/novel-client'

interface StyleDistillReviewDialogProps {
  sourceId: string
  sourceTitle: string
  sectionIds: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onAccepted: (draft: StyleDistillDraftApi) => Promise<void>
}

const DIMENSION_LABELS: Record<string, string> = {
  scene_craft: '场景描写',
  character_craft: '人物描写',
  dialogue_craft: '对话描写',
  action_craft: '动作/打斗',
  emotion_craft: '感情引爆',
  narrative_craft: '叙事结构'
}

export function StyleDistillReviewDialog({
  sourceId,
  sourceTitle,
  sectionIds,
  open,
  onOpenChange,
  onAccepted
}: StyleDistillReviewDialogProps): ReactElement {
  const [draft, setDraft] = useState<StyleDistillDraftApi | null>(null)
  const [notes, setNotes] = useState('')
  const [model, setModel] = useState<ModelRef | null>(null)
  const [loading, setLoading] = useState(false)
  const [accepting, setAccepting] = useState(false)

  async function runDistill(): Promise<void> {
    setLoading(true)
    try {
      setDraft(
        await distillReferenceStyle(sourceId, {
          sectionIds,
          notes: notes || undefined,
          modelId: model ? { provider: model.provider, modelId: model.modelId } : undefined
        })
      )
    } finally {
      setLoading(false)
    }
  }

  async function accept(): Promise<void> {
    if (!draft) return
    setAccepting(true)
    try {
      await onAccepted({
        ...draft,
        techniques: draft.techniques.filter((technique) => technique.kept)
      })
      onOpenChange(false)
      setDraft(null)
    } finally {
      setAccepting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
          <DialogTitle>从参考小说蒸馏文风专家</DialogTitle>
          <DialogDescription>
            来源：{sourceTitle} · 已选择 {sectionIds.length}{' '}
            个章节。超长参考会先在本地按章节分包，再均衡取样分析。
          </DialogDescription>
        </DialogHeader>
        {!draft ? (
          <div className="space-y-4 p-5">
            <ModelPicker
              value={model}
              onChange={setModel}
              label="蒸馏模型（建议选支持工具调用的模型）"
            />
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="重点关注什么（可选），例如：感情爆发、打斗节奏、人物潜台词"
            />
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm text-muted-foreground">
                将分析场景、人物、对话、动作/打斗、感情引爆和叙事结构六类手法。
              </p>
              <Button className="mt-4" onClick={() => void runDistill()} disabled={loading}>
                {loading ? '分析中...' : '开始深度分析'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-muted-foreground">专家名称</label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">能力摘要</label>
                <Input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-text">独立文风提示词</label>
              <textarea
                value={draft.distilledPrompt}
                onChange={(e) => setDraft({ ...draft, distilledPrompt: e.target.value })}
                className="mt-1 min-h-28 w-full rounded-md border border-border bg-input-bg p-2 text-sm text-text"
              />
            </div>
            <div>
              <h3 className="text-sm font-medium text-text">手法卡（逐条审核）</h3>
              <div className="mt-2 space-y-2">
                {draft.techniques.map((technique, index) => (
                  <div
                    key={technique.id}
                    className={`rounded-lg border p-3 ${technique.kept ? 'border-primary/40 bg-primary/5' : 'border-border opacity-55'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-text">
                        {DIMENSION_LABELS[technique.dimension] ?? technique.dimension} ·{' '}
                        {technique.name}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            techniques: draft.techniques.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, kept: !item.kept } : item
                            )
                          })
                        }
                      >
                        {technique.kept ? '保留' : '已丢弃'}
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-text/85">机制：{technique.mechanism}</p>
                    <p className="mt-1 text-xs text-muted-foreground">迁移：{technique.transfer}</p>
                    {technique.evidence.map((evidence) => (
                      <blockquote
                        key={`${evidence.sectionId}-${evidence.quote}`}
                        className="mt-2 border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground"
                      >
                        “{evidence.quote}”
                      </blockquote>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-medium text-text">不可迁移内容</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {draft.exclusions.join(' · ') || '未检测到排除项'}
              </p>
            </div>
          </div>
        )}
        {draft && (
          <DialogFooter className="shrink-0 border-t border-border px-5 py-3">
            <Button variant="outline" onClick={() => setDraft(null)}>
              重新分析
            </Button>
            <Button onClick={() => void accept()} disabled={accepting}>
              {accepting ? '保存中...' : '接受并进入专家库'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
