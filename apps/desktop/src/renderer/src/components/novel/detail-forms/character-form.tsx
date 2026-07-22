import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  updateCharacter,
  listCharacterHistory,
  createCharacterHistory,
  type CharacterHistoryField,
  type NovelCharacter,
  type NovelCharacterHistory,
  type NovelCharacterPlotRole,
} from '@/api/novel-client'
import {
  CHARACTER_PLOT_ROLE_OPTIONS,
  DYNAMIC_FIELDS,
  HISTORY_FIELD_LABELS,
  JsonObjectEditor,
  ParticipatingConflictsBadges,
  relativeTime,
  SaveButton,
  SectionHeader,
  STAGE_OPTIONS,
  TextArea,
  TextInput,
  FieldRow,
} from './shared'

// ── 角色表单 ──

export function CharacterForm({ entity }: { entity: NovelCharacter }): ReactElement {
  const upsertCharacter = useNovelDataStore((s) => s.upsertCharacter)
  const [form, setForm] = useState({
    name: entity.name,
    identity: entity.identity,
    personality: entity.personality,
    appearance: entity.appearance,
    currentState: entity.currentState,
    currentGoal: entity.currentGoal,
    currentPressure: entity.currentPressure,
    secret: entity.secret,
    arcStage: entity.arcStage,
    speechStyle: entity.speechStyle,
    description: entity.description,
    // ── 三层模型：长期欲望 / 角色层级 / 删掉影响 ──
    longTermDesire: entity.longTermDesire,
    plotRole: entity.plotRole,
    removalImpact: entity.removalImpact,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = (Object.keys(form) as (keyof typeof form)[]).some(
    (k) => form[k] !== entity[k],
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateCharacter(entity.id, form)
      upsertCharacter(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertCharacter])

  return (
    <div className="space-y-2">
      <SectionHeader title="基础信息" />
      <FieldRow label="姓名">
        <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </FieldRow>
      <FieldRow label="身份">
        <TextArea variant="short" value={form.identity} onChange={(e) => setForm((f) => ({ ...f, identity: e.target.value }))} />
      </FieldRow>
      <FieldRow label="外貌">
        <TextArea variant="medium" value={form.appearance} onChange={(e) => setForm((f) => ({ ...f, appearance: e.target.value }))} />
      </FieldRow>

      {/* 三层模型：长期欲望 / 角色层级 / 删掉影响 */}
      <SectionHeader title="角色定位" hint="跨章节稳定的发动机与功能位约束" />
      <FieldRow label="长期欲望">
        <TextArea variant="short" value={form.longTermDesire} onChange={(e) => setForm((f) => ({ ...f, longTermDesire: e.target.value }))} placeholder="区别于当前目标，跨章节稳定" />
      </FieldRow>
      <FieldRow label="角色层级">
        <Select value={form.plotRole} onValueChange={(v) => setForm((f) => ({ ...f, plotRole: v as NovelCharacterPlotRole }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHARACTER_PLOT_ROLE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="删掉影响">
        <TextArea variant="short" value={form.removalImpact} onChange={(e) => setForm((f) => ({ ...f, removalImpact: e.target.value }))} placeholder="删掉这个角色哪段剧情会受影响" />
      </FieldRow>

      <SectionHeader title="简述" />
      <FieldRow label="简述">
        <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>

      <SectionHeader title="性格特征" hint="支持核心、优点、缺点、座右铭等结构化字段" />
      <JsonObjectEditor value={form.personality} onChange={(v) => setForm((f) => ({ ...f, personality: v }))} />

      <SectionHeader title="说话风格" hint="支持基调、特点、典型句式等结构化字段" />
      <JsonObjectEditor value={form.speechStyle} onChange={(v) => setForm((f) => ({ ...f, speechStyle: v }))} />

      <SectionHeader title="当前状态" hint="修改动态状态会记录到变更历史" />
      <FieldRow label="当前状态">
        <TextArea variant="short" value={form.currentState} onChange={(e) => setForm((f) => ({ ...f, currentState: e.target.value }))} />
      </FieldRow>
      <FieldRow label="当前目标">
        <TextArea variant="short" value={form.currentGoal} onChange={(e) => setForm((f) => ({ ...f, currentGoal: e.target.value }))} />
      </FieldRow>
      <FieldRow label="当前压力">
        <TextArea variant="short" value={form.currentPressure} onChange={(e) => setForm((f) => ({ ...f, currentPressure: e.target.value }))} />
      </FieldRow>
      <FieldRow label="秘密">
        <TextArea variant="medium" value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} />
      </FieldRow>
      <FieldRow label="弧光阶段">
        <Select
          value={form.arcStage || '__none__'}
          onValueChange={(v) => setForm((f) => ({ ...f, arcStage: v === '__none__' ? '' : v }))}
        >
          <SelectTrigger className="h-9">
            <SelectValue placeholder="未设置" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">未设置</SelectItem>
            {STAGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {/* 三层模型④：影响层反向索引（只读，由冲突 CRUD 自动同步） */}
      <SectionHeader title="参与冲突" hint="反向索引：由冲突编辑时的 participants 自动同步" />
      <ParticipatingConflictsBadges raw="" />

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />

      {/* 状态变更历史时间线 */}
      <CharacterHistorySection characterId={entity.id} />
    </div>
  )
}

// ── 角色状态变更历史 ──

export function CharacterHistorySection({ characterId }: { characterId: string }): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const addCharacterHistory = useNovelDataStore((s) => s.addCharacterHistory)
  const queryClient = useQueryClient()
  const [manualOpen, setManualOpen] = useState(false)

  const queryKey = useMemo(
    () => ['novel-character-history', currentProjectId, characterId] as const,
    [currentProjectId, characterId],
  )

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!currentProjectId) return []
      return listCharacterHistory(currentProjectId, characterId)
    },
    enabled: !!currentProjectId,
  })

  const history = data ?? []

  const handleManualCreated = useCallback(
    (entry: NovelCharacterHistory) => {
      addCharacterHistory(entry)
      void queryClient.invalidateQueries({ queryKey })
    },
    [addCharacterHistory, queryClient, queryKey],
  )

  return (
    <div className="pt-3 mt-3 border-t border-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <History className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-text">状态变更历史</span>
          <Badge variant="secondary" className="h-4 px-1 text-[10px] tabular-nums">
            {history.length}
          </Badge>
        </div>
        <Button size="xs" variant="ghost" onClick={() => setManualOpen(true)}>
          <Plus className="size-3" />
          手动记录变更
        </Button>
      </div>

      {isLoading ? (
        <p className="text-[11px] text-muted-foreground px-1 py-2">加载中...</p>
      ) : error ? (
        <p className="text-[11px] text-destructive px-1 py-2">
          {error instanceof Error ? error.message : '加载历史失败'}
        </p>
      ) : history.length === 0 ? (
        <p className="text-[11px] text-muted-foreground px-1 py-2">暂无变更记录</p>
      ) : (
        <CharacterHistoryTimeline history={history} />
      )}

      <ManualHistoryDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        characterId={characterId}
        onCreated={handleManualCreated}
      />
    </div>
  )
}

export function CharacterHistoryTimeline({
  history,
}: {
  history: NovelCharacterHistory[]
}): ReactElement {
  // 按时间倒序
  const sorted = useMemo(
    () => [...history].sort((a, b) => b.createdAt - a.createdAt),
    [history],
  )
  return (
    <ol className="relative space-y-2.5 pl-3">
      {/* 时间线竖线 */}
      <span
        className="absolute left-[3px] top-1 bottom-1 w-px bg-border"
        aria-hidden="true"
      />
      {sorted.map((entry) => {
        const fieldLabel = HISTORY_FIELD_LABELS[entry.fieldName] ?? entry.fieldName
        const chapterLabel =
          entry.chapterNumber != null
            ? `第 ${entry.chapterNumber} 章`
            : '手动'
        return (
          <li key={entry.id} className="relative">
            {/* 节点圆点 */}
            <span
              className="absolute -left-3 top-1 size-1.5 rounded-full bg-primary ring-2 ring-background"
              aria-hidden="true"
            />
            <div className="rounded-md bg-muted/40 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-text">
                  {chapterLabel} · {fieldLabel}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {relativeTime(entry.createdAt)}
                </span>
              </div>
              <div className="mt-1 space-y-0.5 text-[10px]">
                {entry.oldValue != null && (
                  <div className="text-muted-foreground">
                    旧值: <span className="text-text">{entry.oldValue || '（空）'}</span>
                  </div>
                )}
                {entry.newValue != null && (
                  <div className="text-muted-foreground">
                    新值: <span className="text-text">{entry.newValue || '（空）'}</span>
                  </div>
                )}
                {entry.reason && (
                  <div className="text-muted-foreground">
                    原因: <span className="text-text">{entry.reason}</span>
                  </div>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ── 手动记录变更对话框 ──

export interface ManualHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  characterId: string
  onCreated: (entry: NovelCharacterHistory) => void
}

export function ManualHistoryDialog({
  open,
  onOpenChange,
  characterId,
  onCreated,
}: ManualHistoryDialogProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const [fieldName, setFieldName] = useState<CharacterHistoryField>('currentState')
  const [oldValue, setOldValue] = useState('')
  const [newValue, setNewValue] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 关闭时重置表单
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setFieldName('currentState')
        setOldValue('')
        setNewValue('')
        setReason('')
        setError(null)
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const handleSave = useCallback(async () => {
    if (!currentProjectId) {
      setError('未选择项目')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const entry = await createCharacterHistory(currentProjectId, characterId, {
        fieldName,
        oldValue: oldValue || null,
        newValue: newValue || null,
        reason: reason || null,
      })
      onCreated(entry)
      handleOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [currentProjectId, characterId, fieldName, oldValue, newValue, reason, onCreated, handleOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>手动记录变更</DialogTitle>
          <DialogDescription className="text-pretty">记录角色动态状态的一次变更</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">字段</Label>
            <Select
              value={fieldName}
              onValueChange={(v) => setFieldName(v as CharacterHistoryField)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DYNAMIC_FIELDS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {HISTORY_FIELD_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hist-old" className="text-xs text-muted-foreground">旧值</Label>
            <Input
              id="hist-old"
              value={oldValue}
              onChange={(e) => setOldValue(e.target.value)}
              placeholder="原值（可留空）"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hist-new" className="text-xs text-muted-foreground">新值</Label>
            <Input
              id="hist-new"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="变更后的值"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hist-reason" className="text-xs text-muted-foreground">原因</Label>
            <Input
              id="hist-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="变更原因（可选）"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || !currentProjectId}>
            {saving ? '保存中...' : '保存记录'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
