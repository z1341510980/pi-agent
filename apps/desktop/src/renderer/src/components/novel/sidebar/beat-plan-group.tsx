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
import type { NovelVolume, NovelBeatPlan } from '@/api/novel-client'
import { generateVolumeBeatPlan, updateBeatPlan } from '@/api/novel-client'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import { useNovelBeatStore } from '@/stores/novel-beat-store'
import { EmptyHint } from './empty-hint'
import { CollapsibleGroup } from './project-tree'
import { BEAT_FUNCTION_LABELS, BEAT_FUNCTION_ACCENTS, BEAT_STATUS_LABELS } from './beat-labels'
import { BeatEditForm, type BeatEditFormFields } from './beat-edit-form'

// ── 节拍表分组（P0-1 前端入口）──
// 数据源是共享的 useNovelBeatStore（由 ProjectTree 上的 useBeatPlansLoader 加载），
// 与大纲树章节行的节拍徽标同源，编辑/生成后双方同步刷新。

export interface BeatPlanGroupProps {
  projectId: string
  volumes: NovelVolume[]
}

export function BeatPlanGroup({ projectId, volumes }: BeatPlanGroupProps): ReactElement {
  const collapsedGroups = useNovelUiStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useNovelUiStore((s) => s.toggleCollapsedGroup)
  const beats = useNovelBeatStore((s) => s.beats)
  const setBeats = useNovelBeatStore((s) => s.setBeats)
  const upsertBeat = useNovelBeatStore((s) => s.upsertBeat)

  const [showGenerate, setShowGenerate] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  /** 最近一次生成的提示信息（notes/warnings），可关闭 */
  const [lastRunInfo, setLastRunInfo] = useState<{ notes: string; warnings: string[] } | null>(null)
  const [volumeNumber, setVolumeNumber] = useState<string>(String(volumes[0]?.volumeNumber ?? 1))
  const [count, setCount] = useState('6')
  const [instruction, setInstruction] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editInitial, setEditInitial] = useState<BeatEditFormFields | null>(null)
  const [saving, setSaving] = useState(false)

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
      // 整卷替换：保留其他卷的行，用返回结果覆盖该卷
      const rest = useNovelBeatStore.getState().beats.filter(
        (beat) => beat.volumeNumber !== targetVolume
      )
      setBeats(projectId, [...rest, ...result.beats].sort((a, b) => a.chapterNumber - b.chapterNumber))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`节拍表生成失败：${message}`)
      console.error('[BeatPlanGroup] 节拍表生成失败:', err)
    } finally {
      setGenerating(false)
    }
  }, [projectId, volumeNumber, count, instruction, setBeats])

  const startEdit = useCallback((beat: NovelBeatPlan) => {
    setEditingId(beat.id)
    setEditInitial({
      dramaticFunction: beat.dramaticFunction,
      emotionalDebt: beat.emotionalDebt,
      payoff: beat.payoff,
      arcPosition: beat.arcPosition,
      summary: beat.summary,
    })
  }, [])

  const handleSave = useCallback(
    async (fields: BeatEditFormFields) => {
      if (!editingId) return
      setSaving(true)
      try {
        const updated = await updateBeatPlan(editingId, fields)
        upsertBeat(updated)
        setEditingId(null)
        setEditInitial(null)
      } catch (err) {
        console.error('[BeatPlanGroup] 保存节拍失败:', err)
        setError('保存节拍失败，请重试')
      } finally {
        setSaving(false)
      }
    },
    [editingId, upsertBeat]
  )

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
            <Label className="text-nano">规划章数（3-100）</Label>
            <Input
              type="number"
              min={3}
              max={100}
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

      {beats.length === 0 ? (
        <EmptyHint text="暂无节拍；先填卷纲，再点上方「生成本卷节拍表」" />
      ) : (
        beats.map((beat) =>
          editingId === beat.id && editInitial ? (
            <BeatEditForm
              key={beat.id}
              initial={editInitial}
              saving={saving}
              onSave={handleSave}
              onCancel={() => {
                setEditingId(null)
                setEditInitial(null)
              }}
            />
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
