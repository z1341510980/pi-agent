import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Compass, History, Link2, MessageSquare, Plus, Sparkles, User } from 'lucide-react'
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
  type NovelCharacterGender,
} from '@/api/novel-client'
import {
  CHARACTER_PLOT_ROLE_OPTIONS,
  CHARACTER_GENDER_OPTIONS,
  CONFLICT_STAGE_OPTIONS,
  DYNAMIC_FIELDS,
  HISTORY_FIELD_LABELS,
  JsonObjectEditor,
  relativeTime,
  FormSection,
  SaveButton,
  STAGE_OPTIONS,
  TextArea,
  TextInput,
  FieldRow,
} from './shared'
import { EdgeRelationField } from './edge-relation-field'

// ── 角色表单 ──

export function CharacterForm({ entity }: { entity: NovelCharacter }): ReactElement {
  const upsertCharacter = useNovelDataStore((s) => s.upsertCharacter)
  const conflicts = useNovelDataStore((s) => s.conflicts)
  const [form, setForm] = useState({
    name: entity.name,
    gender: entity.gender ?? null,
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

  /**
   * 参与冲突的候选。
   *
   * 关联数据在 edges 表里（edgeType='involvement'），此前表单侧只留了一段注释说
   * "需要时应通过 edges 查询实现"，于是这个关联只能在画布上连线建立。
   */
  const conflictOptions = useMemo(
    () =>
      conflicts.map((c) => ({
        id: c.id,
        label: c.description.length > 30 ? `…` : c.description,
        hint: CONFLICT_STAGE_OPTIONS.find((o) => o.value === c.stage)?.label,
      })),
    [conflicts],
  )

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
    <div className="space-y-2.5">
      <FormSection title="基础信息" icon={<User className="size-3.5" />} collapsible={false}>
        <FieldRow label="姓名">
          <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </FieldRow>
        <FieldRow label="性别">
          <Select
            value={form.gender ?? '__none__'}
            onValueChange={(v) => setForm((f) => ({ ...f, gender: v === '__none__' ? null : (v as NovelCharacterGender) }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="未设置" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">未设置</SelectItem>
              {CHARACTER_GENDER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="身份">
          <TextArea variant="short" value={form.identity} onChange={(e) => setForm((f) => ({ ...f, identity: e.target.value }))} />
        </FieldRow>
        <FieldRow label="简述">
          <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </FieldRow>
        <FieldRow label="外貌">
          <TextArea variant="medium" value={form.appearance} onChange={(e) => setForm((f) => ({ ...f, appearance: e.target.value }))} />
        </FieldRow>
      </FormSection>

      {/* 三层模型：长期欲望 / 角色层级 / 删掉影响 */}
      <FormSection
        title="角色定位"
        hint="跨章节稳定"
        icon={<Compass className="size-3.5" />}
        collapsible={false}
      >
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
        <FieldRow label="长期欲望" hint="区别于当前目标">
          <TextArea variant="short" value={form.longTermDesire} onChange={(e) => setForm((f) => ({ ...f, longTermDesire: e.target.value }))} placeholder="驱动这个角色跨章节行动的根本欲望" />
        </FieldRow>
        <FieldRow label="删掉影响">
          <TextArea variant="short" value={form.removalImpact} onChange={(e) => setForm((f) => ({ ...f, removalImpact: e.target.value }))} placeholder="删掉这个角色哪段剧情会受影响" />
        </FieldRow>
      </FormSection>

      <FormSection
        title="当前状态"
        hint="修改会记录到变更历史"
        icon={<Activity className="size-3.5" />}
        collapsible={false}
      >
        <FieldRow label="此刻状态">
          <TextArea variant="short" value={form.currentState} onChange={(e) => setForm((f) => ({ ...f, currentState: e.target.value }))} />
        </FieldRow>
        <FieldRow label="当前目标">
          <TextArea variant="short" value={form.currentGoal} onChange={(e) => setForm((f) => ({ ...f, currentGoal: e.target.value }))} />
        </FieldRow>
        <FieldRow label="当前压力">
          <TextArea variant="short" value={form.currentPressure} onChange={(e) => setForm((f) => ({ ...f, currentPressure: e.target.value }))} />
        </FieldRow>
        <FieldRow label="弧光阶段">
          <Select
            value={form.arcStage || '__none__'}
            onValueChange={(v) => setForm((f) => ({ ...f, arcStage: v === '__none__' ? '' : v }))}
          >
            <SelectTrigger className="w-full">
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
        <FieldRow label="秘密" hint="不对其他角色公开">
          <TextArea variant="medium" value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} />
        </FieldRow>
      </FormSection>

      {/* 「参与冲突」曾被整体移除（数据迁到 edges 后表单侧没跟上，
          此前传 raw="" 恒显示「暂无参与冲突」）。现在通过 EdgeRelationField 真正实现。 */}
      <FormSection title="关联" hint="即时生效" icon={<Link2 className="size-3.5" />}>
        <FieldRow label="参与冲突" hint="勾选即生效，无需保存">
          <EdgeRelationField
            entityId={entity.id}
            entityType="character"
            targetType="conflict"
            edgeType="involvement"
            options={conflictOptions}
            placeholder="关联此角色参与的冲突"
            searchPlaceholder="搜索冲突…"
            emptyHint="本项目还没有冲突"
          />
        </FieldRow>
      </FormSection>

      {/* 两个 JSON 编辑器默认折叠：它们是本表单里最占高度的部分
          （每个字段一张卡片），而多数编辑动作发生在上方的状态字段 */}
      <FormSection
        title="性格特征"
        hint="核心 / 优点 / 缺点 / 座右铭"
        icon={<Sparkles className="size-3.5" />}
        defaultCollapsed
      >
        <JsonObjectEditor value={form.personality} onChange={(v) => setForm((f) => ({ ...f, personality: v }))} />
      </FormSection>

      <FormSection
        title="说话风格"
        hint="决定多角色同场时能否分辨谁在说话"
        icon={<MessageSquare className="size-3.5" />}
        defaultCollapsed
      >
        <JsonObjectEditor value={form.speechStyle} onChange={(v) => setForm((f) => ({ ...f, speechStyle: v }))} />
      </FormSection>

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
          <Badge variant="secondary" className="h-4 px-1 text-nano tabular-nums">
            {history.length}
          </Badge>
        </div>
        <Button size="xs" variant="ghost" onClick={() => setManualOpen(true)}>
          <Plus className="size-3" />
          手动记录变更
        </Button>
      </div>

      {isLoading ? (
        <p className="text-micro text-muted-foreground px-1 py-2">加载中...</p>
      ) : error ? (
        <p className="text-micro text-destructive px-1 py-2">
          {error instanceof Error ? error.message : '加载历史失败'}
        </p>
      ) : history.length === 0 ? (
        <p className="text-micro text-muted-foreground px-1 py-2">暂无变更记录</p>
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
                <span className="text-micro font-medium text-text">
                  {chapterLabel} · {fieldLabel}
                </span>
                <span className="text-nano text-muted-foreground">
                  {relativeTime(entry.createdAt)}
                </span>
              </div>
              <div className="mt-1 space-y-0.5 text-nano">
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
