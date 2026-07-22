/**
 * SubtrackPopover：子轨道双击弹窗，补充缺失数据
 *
 * 触发：双击子轨道色带/节点，onSubtrackDoubleClick(trackKey, entity)
 * 行为：根据 trackKey 显示对应的表单，提交后调用 updateConflict/updateForeshadow 写回
 *
 * 支持的轨道（样板阶段）：
 * - 冲突：intensity(强度点) / participants(参与方) / turning-points(转折点) / resolution(解决进度) / linked-clues(关联线索)
 * - 伏笔：beats(事件链) / resolution(回收进度) / linked-entities(关联角色) / info-layer(信息差)
 * - status / stage 轨道不弹窗（已有主矩阵编辑入口）
 */

import { useEffect, useState, useRef, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  updateConflict,
  updateForeshadow,
  type ForeshadowBeatType,
} from '@/api/novel-client'
import { GROUP_META, type MatrixEntity } from './matrix-logic'
import { computeSubtrackPopoverPosition } from './subtrack-popover-position'

export interface SubtrackPopoverProps {
  open: boolean
  trackKey: string | null
  entity: MatrixEntity | null
  maxChapter: number
  onClose: () => void
  anchor: { x: number; y: number } | null
}

// ── 轨道元信息：标题 / 描述 / 输入模式 ──

interface TrackMeta {
  title: string
  description: string
  /** 输入模式决定表单字段 */
  mode: 'point-value' | 'point-label' | 'participant' | 'link-clues' | 'link-chars' | 'beat' | 'info-layer'
  /** point-value 模式的数值范围与单位 */
  valueMin?: number
  valueMax?: number
  valueStep?: number
  valueLabel?: string
}

function getTrackMeta(kind: MatrixEntity['kind'], trackKey: string): TrackMeta | null {
  if (kind === 'conflict') {
    switch (trackKey) {
      case 'intensity':
        return { title: '强度曲线', description: '添加冲突在指定章节的强度值（0-10）', mode: 'point-value', valueMin: 0, valueMax: 10, valueStep: 1, valueLabel: '强度' }
      case 'participants':
        return { title: '参与方', description: '添加角色参与冲突的章节跨度', mode: 'participant' }
      case 'stakes':
      case 'turning-points':
        return { title: '关键转折', description: '添加冲突转折点（章节 + 标签）', mode: 'point-label' }
      case 'resolution':
        return { title: '解决进度', description: '添加解决进度点（章节 + 百分比 0-100）', mode: 'point-value', valueMin: 0, valueMax: 100, valueStep: 5, valueLabel: '百分比' }
      case 'linked-clues':
        return { title: '关联线索', description: '关联与本冲突相关的线索', mode: 'link-clues' }
      default:
        return null
    }
  }
  if (kind === 'foreshadow') {
    switch (trackKey) {
      case 'beats':
        return { title: '事件链', description: '添加伏笔事件节点（章节 + 类型 + 备注）', mode: 'beat' }
      case 'resolution':
        return { title: '回收进度', description: '添加回收进度点（章节 + 标签）', mode: 'point-label' }
      case 'linked-entities':
        return { title: '关联角色', description: '关联与本伏笔相关的角色', mode: 'link-chars' }
      case 'info-layer':
        return { title: '信息差承载', description: '关联与本伏笔相关的信息差 ID（逗号分隔）', mode: 'info-layer' }
      default:
        return null
    }
  }
  return null
}

// ── 组件 ──

export function SubtrackPopover({
  open, trackKey, entity, maxChapter, onClose, anchor,
}: SubtrackPopoverProps): ReactElement | null {
  if (!entity || !trackKey) return null
  const meta = GROUP_META[entity.kind]
  const trackMeta = getTrackMeta(entity.kind, trackKey)

  if (!trackMeta) {
    return (
      <div className="fixed z-[100] w-[360px] rounded-xl border border-border bg-surface-1 p-4 shadow-xl" style={computeSubtrackPopoverPosition(anchor ?? { x: 12, y: 12 }, { width: 360, height: 120 }, { width: window.innerWidth, height: window.innerHeight })}>
        <div className="flex items-center justify-between"><span className="text-sm font-semibold">该轨道暂不支持编辑</span><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
        <p className="mt-2 text-xs text-muted-foreground">轨道「{trackKey}」暂不支持弹窗补数据。</p>
      </div>
    )
  }

  return (
    <SubtrackForm
      open={open}
      entity={entity}
      trackKey={trackKey}
      trackMeta={trackMeta}
      metaColor={meta.color}
      maxChapter={maxChapter}
      onClose={onClose}
      anchor={anchor}
    />
  )
}

// ── 表单主体 ──

interface SubtrackFormProps {
  open: boolean
  entity: MatrixEntity
  trackKey: string
  trackMeta: TrackMeta
  metaColor: string
  maxChapter: number
  onClose: () => void
  anchor: { x: number; y: number } | null
}

function SubtrackForm({
  open, entity, trackKey, trackMeta, metaColor, maxChapter, onClose, anchor,
}: SubtrackFormProps): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  const conflicts = useNovelDataStore((s) => s.conflicts)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)
  const characters = useNovelDataStore((s) => s.characters)
  const clues = useNovelDataStore((s) => s.clues)
  const upsertConflict = useNovelDataStore((s) => s.upsertConflict)
  const upsertForeshadow = useNovelDataStore((s) => s.upsertForeshadow)

  // 表单字段
  const [chapter, setChapter] = useState('')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [startCh, setStartCh] = useState('')
  const [endCh, setEndCh] = useState('')
  const [beatType, setBeatType] = useState<ForeshadowBeatType>('reinforce')
  const [beatNote, setBeatNote] = useState('')
  const [infoLayerIds, setInfoLayerIds] = useState('')
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 初始化：打开时加载现有关联
  useEffect(() => {
    if (!open) return
    setError(null)
    setSubmitting(false)
    setChapter('')
    setValue('')
    setLabel('')
    setCharacterId('')
    setStartCh('')
    setEndCh('')
    setBeatType('reinforce')
    setBeatNote('')
    setInfoLayerIds('')

    // 关联字段已迁移至 edges，暂用空数组占位（后续接 edges API 查询）
    if (trackMeta.mode === 'link-clues' && entity.kind === 'conflict') {
      setLinkedIds(new Set())
    } else if (trackMeta.mode === 'link-chars' && entity.kind === 'foreshadow') {
      setLinkedIds(new Set())
    } else if (trackMeta.mode === 'info-layer' && entity.kind === 'foreshadow') {
      setInfoLayerIds('')
    }
  }, [open, trackMeta.mode, entity, conflicts, foreshadows])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('pointerdown', handlePointerDown); document.removeEventListener('keydown', handleKeyDown) }
  }, [open, onClose])

  // ── 提交逻辑 ──

  const handleSubmit = async (): Promise<void> => {
    setError(null)
    const ch = Number(chapter)

    try {
      if (entity.kind === 'conflict') {
        await handleConflictSubmit(ch)
      } else if (entity.kind === 'foreshadow') {
        await handleForeshadowSubmit(ch)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleConflictSubmit = async (ch: number): Promise<void> => {
    const conflict = conflicts.find((x) => x.id === entity.entityId)
    if (!conflict) throw new Error('未找到冲突')

    if (trackKey === 'intensity') {
      const v = Number(value)
      if (!Number.isFinite(v) || v < (trackMeta.valueMin ?? 0) || v > (trackMeta.valueMax ?? 10)) {
        throw new Error(`${trackMeta.valueLabel} 需为 ${trackMeta.valueMin}-${trackMeta.valueMax} 的数字`)
      }
      if (!Number.isFinite(ch) || ch < 1 || ch > maxChapter) throw new Error('章节号无效')
      const points = [...(conflict.intensityPoints ?? []), { chapter: ch, value: v }]
        .sort((a, b) => a.chapter - b.chapter)
      const updated = await updateConflict(conflict.id, { intensityPoints: points })
      upsertConflict(updated)
    } else if (trackKey === 'participants') {
      if (!characterId) throw new Error('请选择角色')
      const sCh = Number(startCh)
      const eCh = Number(endCh)
      if (!Number.isFinite(sCh) || !Number.isFinite(eCh) || sCh < 1 || eCh < 1 || sCh > eCh) throw new Error('起止章节无效')
      const spans = [...(conflict.participantSpans ?? []), { characterId, startCh: sCh, endCh: eCh }]
      const updated = await updateConflict(conflict.id, { participantSpans: spans })
      upsertConflict(updated)
    } else if (trackKey === 'turning-points') {
      if (!Number.isFinite(ch) || ch < 1 || ch > maxChapter) throw new Error('章节号无效')
      if (!label.trim()) throw new Error('请输入转折标签')
      const points = [...(conflict.turningPoints ?? []), { chapter: ch, label: label.trim() }]
        .sort((a, b) => a.chapter - b.chapter)
      const updated = await updateConflict(conflict.id, { turningPoints: points })
      upsertConflict(updated)
    } else if (trackKey === 'resolution') {
      const v = Number(value)
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('百分比需为 0-100')
      if (!Number.isFinite(ch) || ch < 1 || ch > maxChapter) throw new Error('章节号无效')
      const points = [...(conflict.resolutionProgress ?? []), { chapter: ch, percent: v }]
        .sort((a, b) => a.chapter - b.chapter)
      const updated = await updateConflict(conflict.id, { resolutionProgress: points })
      upsertConflict(updated)
    }
  }

  const handleForeshadowSubmit = async (ch: number): Promise<void> => {
    const foreshadow = foreshadows.find((x) => x.id === entity.entityId)
    if (!foreshadow) throw new Error('未找到伏笔')

    if (trackKey === 'beats') {
      if (!Number.isFinite(ch) || ch < 1 || ch > maxChapter) throw new Error('章节号无效')
      const beats = [...(foreshadow.beats ?? []), { chapter: ch, type: beatType, ...(beatNote.trim() ? { note: beatNote.trim() } : {}) }]
        .sort((a, b) => a.chapter - b.chapter)
      const updated = await updateForeshadow(foreshadow.id, { beats })
      upsertForeshadow(updated)
    } else if (trackKey === 'resolution') {
      if (!Number.isFinite(ch) || ch < 1 || ch > maxChapter) throw new Error('章节号无效')
      if (!label.trim()) throw new Error('请输入标签')
      const points = [...(foreshadow.resolutionPoints ?? []), { chapter: ch, label: label.trim() }]
        .sort((a, b) => a.chapter - b.chapter)
      const updated = await updateForeshadow(foreshadow.id, { resolutionPoints: points })
      upsertForeshadow(updated)
    }
  }

  // ── 删除单项 ──

  const handleDeleteItem = async (idx: number): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      if (entity.kind === 'conflict') {
        const conflict = conflicts.find((x) => x.id === entity.entityId)
        if (!conflict) return
        if (trackKey === 'intensity') {
          const points = (conflict.intensityPoints ?? []).filter((_, i) => i !== idx)
          const updated = await updateConflict(conflict.id, { intensityPoints: points })
          upsertConflict(updated)
        } else if (trackKey === 'participants') {
          const spans = (conflict.participantSpans ?? []).filter((_, i) => i !== idx)
          const updated = await updateConflict(conflict.id, { participantSpans: spans })
          upsertConflict(updated)
        } else if (trackKey === 'turning-points') {
          const points = (conflict.turningPoints ?? []).filter((_, i) => i !== idx)
          const updated = await updateConflict(conflict.id, { turningPoints: points })
          upsertConflict(updated)
        } else if (trackKey === 'resolution') {
          const points = (conflict.resolutionProgress ?? []).filter((_, i) => i !== idx)
          const updated = await updateConflict(conflict.id, { resolutionProgress: points })
          upsertConflict(updated)
        }
      } else if (entity.kind === 'foreshadow') {
        const foreshadow = foreshadows.find((x) => x.id === entity.entityId)
        if (!foreshadow) return
        if (trackKey === 'beats') {
          const beats = (foreshadow.beats ?? []).filter((_, i) => i !== idx)
          const updated = await updateForeshadow(foreshadow.id, { beats })
          upsertForeshadow(updated)
        } else if (trackKey === 'resolution') {
          const points = (foreshadow.resolutionPoints ?? []).filter((_, i) => i !== idx)
          const updated = await updateForeshadow(foreshadow.id, { resolutionPoints: points })
          upsertForeshadow(updated)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setSubmitting(false)
    }
  }

  // ── 现有数据列表 ──

  const renderExistingItems = (): ReactElement | null => {
    const items: Array<{ id: string; label: string }> = []
    if (entity.kind === 'conflict') {
      const c = conflicts.find((x) => x.id === entity.entityId)
      if (!c) return null
      if (trackKey === 'intensity') (c.intensityPoints ?? []).forEach((p, i) => items.push({ id: String(i), label: `CH.${p.chapter} · 强度 ${p.value}` }))
      if (trackKey === 'participants') {
        (c.participantSpans ?? []).forEach((p, i) => {
          const char = characters.find((ch) => ch.id === p.characterId)
          items.push({ id: String(i), label: `${char?.name ?? p.characterId.slice(0, 4)} · CH.${p.startCh}-${p.endCh}` })
        })
      }
      if (trackKey === 'turning-points') (c.turningPoints ?? []).forEach((p, i) => items.push({ id: String(i), label: `CH.${p.chapter} · ${p.label}` }))
      if (trackKey === 'resolution') (c.resolutionProgress ?? []).forEach((p, i) => items.push({ id: String(i), label: `CH.${p.chapter} · ${p.percent}%` }))
    } else if (entity.kind === 'foreshadow') {
      const f = foreshadows.find((x) => x.id === entity.entityId)
      if (!f) return null
      if (trackKey === 'beats') (f.beats ?? []).forEach((b, i) => items.push({ id: String(i), label: `CH.${b.chapter} · ${b.type}${b.note ? ' · ' + b.note : ''}` }))
      if (trackKey === 'resolution') (f.resolutionPoints ?? []).forEach((p, i) => items.push({ id: String(i), label: `CH.${p.chapter} · ${p.label}` }))
    }
    if (items.length === 0) return null
    return (
      <div className="space-y-1 max-h-32 overflow-y-auto">
        <p className="text-[11px] text-muted-foreground">现有数据（{items.length}）</p>
        {items.map((item, idx) => (
          <div key={item.id} className="flex items-center justify-between rounded px-2 py-1 bg-muted/40 text-xs">
            <span className="truncate">{item.label}</span>
            <button
              type="button"
              className="ml-2 text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => void handleDeleteItem(idx)}
              disabled={submitting}
              aria-label="删除"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    )
  }

  // ── 表单字段（按 mode 渲染）──

  const renderForm = (): ReactElement => {
    const mode = trackMeta.mode

    if (mode === 'link-clues') {
      return (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">勾选要关联的线索</p>
          <div className="max-h-48 overflow-y-auto space-y-1 rounded border border-border p-2">
            {clues.length === 0 && <p className="text-xs text-muted-foreground">暂无线索</p>}
            {clues.map((clue) => (
              <label key={clue.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5">
                <input
                  type="checkbox"
                  checked={linkedIds.has(clue.id)}
                  onChange={(e) => {
                    const next = new Set(linkedIds)
                    if (e.target.checked) next.add(clue.id)
                    else next.delete(clue.id)
                    setLinkedIds(next)
                  }}
                  disabled={submitting}
                />
                <span className="truncate">{clue.description}</span>
              </label>
            ))}
          </div>
        </div>
      )
    }

    if (mode === 'link-chars') {
      return (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">勾选要关联的角色</p>
          <div className="max-h-48 overflow-y-auto space-y-1 rounded border border-border p-2">
            {characters.length === 0 && <p className="text-xs text-muted-foreground">暂无角色</p>}
            {characters.map((char) => (
              <label key={char.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5">
                <input
                  type="checkbox"
                  checked={linkedIds.has(char.id)}
                  onChange={(e) => {
                    const next = new Set(linkedIds)
                    if (e.target.checked) next.add(char.id)
                    else next.delete(char.id)
                    setLinkedIds(next)
                  }}
                  disabled={submitting}
                />
                <span className="truncate">{char.name}{char.isProtagonist ? '（主角）' : ''}</span>
              </label>
            ))}
          </div>
        </div>
      )
    }

    if (mode === 'info-layer') {
      return (
        <div className="space-y-1.5">
          <Label htmlFor="info-ids">信息差 ID（逗号分隔）</Label>
          <Input
            id="info-ids"
            value={infoLayerIds}
            onChange={(e) => setInfoLayerIds(e.target.value)}
            placeholder="id1, id2, id3"
            disabled={submitting}
          />
        </div>
      )
    }

    if (mode === 'participant') {
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="participant-char">角色</Label>
            <select
              id="participant-char"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
              disabled={submitting}
            >
              <option value="">选择角色…</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="p-start">起始章</Label>
              <Input id="p-start" type="number" min={1} max={maxChapter} value={startCh} onChange={(e) => setStartCh(e.target.value)} disabled={submitting} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-end">结束章</Label>
              <Input id="p-end" type="number" min={1} max={maxChapter} value={endCh} onChange={(e) => setEndCh(e.target.value)} disabled={submitting} />
            </div>
          </div>
        </div>
      )
    }

    if (mode === 'beat') {
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="beat-ch">章节</Label>
            <Input id="beat-ch" type="number" min={1} max={maxChapter} value={chapter} onChange={(e) => setChapter(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="beat-type">事件类型</Label>
            <select
              id="beat-type"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              value={beatType}
              onChange={(e) => setBeatType(e.target.value as ForeshadowBeatType)}
              disabled={submitting}
            >
              <option value="plant">埋设</option>
              <option value="reinforce">强化</option>
              <option value="reveal">揭示</option>
              <option value="payoff">回收</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="beat-note">备注（可选）</Label>
            <Input id="beat-note" value={beatNote} onChange={(e) => setBeatNote(e.target.value)} placeholder="本次事件的具体内容" disabled={submitting} />
          </div>
        </div>
      )
    }

    // point-value / point-label 通用
    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="point-ch">章节</Label>
          <Input id="point-ch" type="number" min={1} max={maxChapter} value={chapter} onChange={(e) => setChapter(e.target.value)} disabled={submitting} />
        </div>
        {mode === 'point-value' && (
          <div className="space-y-1.5">
            <Label htmlFor="point-val">{trackMeta.valueLabel ?? '值'}（{trackMeta.valueMin}-{trackMeta.valueMax}）</Label>
            <Input
              id="point-val"
              type="number"
              min={trackMeta.valueMin}
              max={trackMeta.valueMax}
              step={trackMeta.valueStep}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={submitting}
            />
          </div>
        )}
        {mode === 'point-label' && (
          <div className="space-y-1.5">
            <Label htmlFor="point-label">标签</Label>
            <Input id="point-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="转折点描述" disabled={submitting} />
          </div>
        )}
      </div>
    )
  }

  const isLinkMode = trackMeta.mode === 'link-clues' || trackMeta.mode === 'link-chars' || trackMeta.mode === 'info-layer'

  return (
    <div ref={panelRef} className="fixed z-[100] w-[360px] max-h-[420px] overflow-y-auto rounded-xl border border-border bg-surface-1 p-4 shadow-xl" style={computeSubtrackPopoverPosition(anchor ?? { x: 12, y: 12 }, { width: 360, height: 420 }, { width: window.innerWidth, height: window.innerHeight })}>
        <div className="flex items-start justify-between gap-3">
          <div>
          <h2 className="text-sm font-semibold">
            <span className="mr-1.5" style={{ color: metaColor }}>{GROUP_META[entity.kind].icon}</span>
            {trackMeta.title}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {trackMeta.description} · 实体「{entity.name}」
          </p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} className="text-muted-foreground hover:text-text" aria-label="关闭">×</button>
        </div>
        <div className="py-2 space-y-3">
          {renderExistingItems()}
          {renderForm()}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          <Button onClick={() => { setSubmitting(true); void handleSubmit() }} disabled={submitting}>
            {submitting ? '保存中…' : (isLinkMode ? '保存关联' : '添加')}
          </Button>
        </div>
    </div>
  )
}
