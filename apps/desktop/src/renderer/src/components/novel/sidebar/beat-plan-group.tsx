import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { NovelVolume, NovelBeatPlan, BeatDramaticFunction } from '@/api/novel-client'
import { generateVolumeBeatPlan, listBeatPlans, updateBeatPlan } from '@/api/novel-client'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import { EmptyHint } from './empty-hint'
import { CollapsibleGroup } from './project-tree'

// ── 节拍表分组（P0-1 前端入口）──

const BEAT_FUNCTION_LABELS: Record<BeatDramaticFunction, string> = {
  setup: '铺垫',
  escalation: '递进加压',
  false_victory: '假胜利',
  false_defeat: '假失败',
  midpoint_turn: '中点反转',
  low_point: '低谷',
  climax: '爆发',
  payoff: '兑现爽点',
  aftermath: '余波',
  breather: '缓冲',
}

/** 戏剧功能配色：爆发/兑现暖色警示，低谷冷灰，反转系紫，铺垫缓冲绿蓝 */
const BEAT_FUNCTION_ACCENTS: Record<BeatDramaticFunction, string> = {
  setup: 'text-blue-500',
  escalation: 'text-orange-500',
  false_victory: 'text-violet-500',
  false_defeat: 'text-violet-500',
  midpoint_turn: 'text-violet-600 font-medium',
  low_point: 'text-slate-400',
  climax: 'text-rose-500 font-medium',
  payoff: 'text-amber-500 font-medium',
  aftermath: 'text-emerald-500',
  breather: 'text-emerald-400',
}

const BEAT_STATUS_LABELS: Record<NovelBeatPlan['status'], string> = {
  planned: '待执行',
  confirmed: '已发布',
  superseded: '已取代',
}

export interface BeatPlanGroupProps {
  projectId: string
  volumes: NovelVolume[]
}

export function BeatPlanGroup({ projectId, volumes }: BeatPlanGroupProps): ReactElement {
  const collapsedGroups = useNovelUiStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useNovelUiStore((s) => s.toggleCollapsedGroup)

  const [beats, setBeats] = useState<NovelBeatPlan[]>([])
  const [loading, setLoading] = useState(false)
  const [showGenerate, setShowGenerate] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  /** 最近一次生成的提示信息（notes/warnings），可关闭 */
  const [lastRunInfo, setLastRunInfo] = useState<{ notes: string; warnings: string[] } | null>(null)
  const [volumeNumber, setVolumeNumber] = useState<string>(String(volumes[0]?.volumeNumber ?? 1))
  const [count, setCount] = useState('6')
  const [instruction, setInstruction] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{
    dramaticFunction: BeatDramaticFunction
    emotionalDebt: string
    payoff: string
    arcPosition: string
    summary: string
  } | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const result = await listBeatPlans(projectId)
      setBeats(result.beats)
    } catch (err) {
      console.error('[BeatPlanGroup] 加载节拍表失败:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (volumes.length > 0 && !volumes.some((v) => String(v.volumeNumber) === volumeNumber)) {
      setVolumeNumber(String(volumes[0].volumeNumber))
    }
  }, [volumes, volumeNumber])

  const handleGenerate = useCallback(async () => {
    const targetVolume = Number.parseInt(volumeNumber, 10)
    if (!Number.isInteger(targetVolume) || targetVolume < 1) {
      setError('请选择要规划节拍的卷')
      return
    }
    setGenerating(true)
    setError('')
    try {
      const result = await generateVolumeBeatPlan(projectId, targetVolume, {
        count: Number.parseInt(count, 10) || undefined,
        instruction: instruction.trim() || undefined,
      })
      setLastRunInfo({
        notes: result.notes,
        warnings: result.warnings,
      })
      setShowGenerate(false)
      await reload()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`节拍表生成失败：${message}`)
      console.error('[BeatPlanGroup] 节拍表生成失败:', err)
    } finally {
      setGenerating(false)
    }
  }, [projectId, volumeNumber, count, instruction, reload])

  const startEdit = useCallback((beat: NovelBeatPlan) => {
    setEditingId(beat.id)
    setEditForm({
      dramaticFunction: beat.dramaticFunction,
      emotionalDebt: beat.emotionalDebt,
      payoff: beat.payoff,
      arcPosition: beat.arcPosition,
      summary: beat.summary,
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (!editingId || !editForm) return
    setSaving(true)
    try {
      const updated = await updateBeatPlan(editingId, editForm)
      setBeats((prev) => prev.map((beat) => (beat.id === updated.id ? updated : beat)))
      setEditingId(null)
      setEditForm(null)
    } catch (err) {
      console.error('[BeatPlanGroup] 保存节拍失败:', err)
      setError('保存节拍失败，请重试')
    } finally {
      setSaving(false)
    }
  }, [editingId, editForm])

  return (
    <CollapsibleGroup
      kind="beat_plan"
      icon={Zap}
      label="节拍表"
      count={beats.length}
      accent="text-fuchsia-500"
      collapsed={collapsedGroups.includes('beat_plan')}
      onToggle={toggleCollapsedGroup}
      onAdd={() => setShowGenerate((v) => !v)}
      addLabel="生成本卷节拍表"
    >
      {error && (
        <div className="px-1.5 py-1 text-nano text-destructive">{error}</div>
      )}

      {showGenerate && (
        <div className="mx-1 mb-1 rounded-lg border border-border/60 p-2 space-y-2">
          <div className="space-y-1">
            <Label className="text-nano">目标卷</Label>
            <Select value={volumeNumber} onValueChange={setVolumeNumber}>
              <SelectTrigger className="w-full h-7">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {volumes.map((volume) => (
                  <SelectItem key={volume.id} value={String(volume.volumeNumber)}>
                    第 {volume.volumeNumber} 卷{volume.title ? `·${volume.title}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-nano">规划章数（3-8）</Label>
            <Input
              type="number"
              min={3}
              max={8}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-nano">补充要求（可选）</Label>
            <Input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例如：本卷中段安排一次假胜利"
              className="h-7 text-xs"
            />
          </div>
          <p className="text-nano text-muted-foreground">
            生成会覆盖该卷「待执行」的旧节拍；已发布章节的节拍保留不动。需要先填写卷纲。
          </p>
          <div className="flex gap-1.5 justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-nano"
              onClick={() => setShowGenerate(false)}
              disabled={generating}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-nano"
              onClick={handleGenerate}
              disabled={generating || volumes.length === 0}
            >
              {generating ? '生成中...' : '生成'}
            </Button>
          </div>
        </div>
      )}

      {lastRunInfo && (lastRunInfo.notes || lastRunInfo.warnings.length > 0) && (
        <div className="mx-1 mb-1 rounded-lg bg-muted/60 p-2 space-y-0.5">
          <div className="flex items-start justify-between gap-1">
            <span className="text-nano font-medium text-text">本次生成提示</span>
            <button
              type="button"
              className="text-nano text-muted-foreground hover:text-foreground"
              onClick={() => setLastRunInfo(null)}
            >
              关闭
            </button>
          </div>
          {lastRunInfo.notes && (
            <div className="text-nano text-muted-foreground whitespace-pre-wrap">{lastRunInfo.notes}</div>
          )}
          {lastRunInfo.warnings.map((warning) => (
            <div key={warning} className="text-nano text-amber-500">⚠ {warning}</div>
          ))}
        </div>
      )}

      {loading ? (
        <EmptyHint text="加载中..." />
      ) : beats.length === 0 ? (
        <EmptyHint text="暂无节拍；先填卷纲，再点上方「生成本卷节拍表」" />
      ) : (
        beats.map((beat) =>
          editingId === beat.id && editForm ? (
            <div key={beat.id} className="mx-1 my-0.5 rounded-lg border border-border/60 p-2 space-y-1.5">
              <div className="space-y-1">
                <Label className="text-nano">戏剧功能</Label>
                <Select
                  value={editForm.dramaticFunction}
                  onValueChange={(v) => setEditForm((f) => f ? { ...f, dramaticFunction: v as BeatDramaticFunction } : f)}
                >
                  <SelectTrigger className="w-full h-7">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(BEAT_FUNCTION_LABELS) as BeatDramaticFunction[]).map((fn) => (
                      <SelectItem key={fn} value={fn}>{BEAT_FUNCTION_LABELS[fn]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-nano">情绪债务</Label>
                <Input
                  value={editForm.emotionalDebt}
                  onChange={(e) => setEditForm((f) => f ? { ...f, emotionalDebt: e.target.value } : f)}
                  className="h-7 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-nano">爽点/回报</Label>
                <Input
                  value={editForm.payoff}
                  onChange={(e) => setEditForm((f) => f ? { ...f, payoff: e.target.value } : f)}
                  className="h-7 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-nano">核心走向</Label>
                <Input
                  value={editForm.summary}
                  onChange={(e) => setEditForm((f) => f ? { ...f, summary: e.target.value } : f)}
                  className="h-7 text-xs"
                />
              </div>
              <div className="flex gap-1.5 justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-nano"
                  onClick={() => { setEditingId(null); setEditForm(null) }}
                  disabled={saving}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-6 px-2 text-nano"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? '保存中...' : '保存'}
                </Button>
              </div>
            </div>
          ) : (
            <button
              key={beat.id}
              type="button"
              onClick={() => startEdit(beat)}
              title={`${BEAT_FUNCTION_LABELS[beat.dramaticFunction]}｜点击编辑`}
              className="group w-full flex items-start gap-1.5 px-1.5 py-1 rounded-lg text-left hover:bg-muted transition-colors duration-150 ease-out"
            >
              <Badge variant="secondary" className="mt-0.5 h-4 px-1 text-nano tabular-nums shrink-0">
                第{beat.chapterNumber}章
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className={cn('text-xs', BEAT_FUNCTION_ACCENTS[beat.dramaticFunction])}>
                    {BEAT_FUNCTION_LABELS[beat.dramaticFunction]}
                  </span>
                  {beat.status !== 'planned' && (
                    <span className="text-nano text-muted-foreground">
                      ·{BEAT_STATUS_LABELS[beat.status]}
                    </span>
                  )}
                </div>
                {beat.summary && (
                  <div className="text-nano text-muted-foreground line-clamp-2">
                    {beat.arcPosition ? `〔${beat.arcPosition}〕` : ''}{beat.summary}
                  </div>
                )}
              </div>
            </button>
          )
        )
      )}
    </CollapsibleGroup>
  )
}
