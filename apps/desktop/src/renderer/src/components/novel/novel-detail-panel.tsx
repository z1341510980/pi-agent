import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, X, Info, History, Plus } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  updateProject,
  updateCharacter,
  updateChapter,
  updateConflict,
  updateForeshadow,
  listCharacterHistory,
  createCharacterHistory,
  type NovelProject,
  type NovelCharacter,
  type NovelChapter,
  type NovelConflict,
  type NovelForeshadow,
  type NovelCharacterHistory,
  type CharacterHistoryField,
  type StoryStage,
  type ChapterStatus,
  type ConflictType,
  type ConflictStage,
  type ForeshadowStatus,
} from '@/api/novel-client'

// ── 字段组件 ──

function FieldRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function TextInput(props: React.ComponentProps<typeof Input>): ReactElement {
  return <Input {...props} />
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

// ── 选项常量 ──

const STAGE_OPTIONS: { value: StoryStage; label: string }[] = [
  { value: 'setup', label: '铺垫' },
  { value: 'rising', label: '上升' },
  { value: 'climax', label: '高潮' },
  { value: 'falling', label: '回落' },
  { value: 'resolution', label: '结局' },
]

const PROJECT_STATUS_OPTIONS = [
  { value: 'active', label: '进行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
]

const CHAPTER_STATUS_OPTIONS: { value: ChapterStatus; label: string }[] = [
  { value: 'planned', label: '已规划' },
  { value: 'drafting', label: '草稿中' },
  { value: 'review', label: '审核中' },
  { value: 'published', label: '已发布' },
  { value: 'rejected', label: '已驳回' },
]

const CONFLICT_TYPE_OPTIONS: { value: ConflictType; label: string }[] = [
  { value: 'inner', label: '内心' },
  { value: 'relationship', label: '关系' },
  { value: 'faction', label: '阵营' },
  { value: 'interest', label: '利益' },
  { value: 'moral', label: '道德' },
  { value: 'identity', label: '身份' },
  { value: 'emotional', label: '情感' },
  { value: 'world_rule', label: '世界规则' },
  { value: 'survival', label: '生存' },
]

const CONFLICT_STAGE_OPTIONS: { value: ConflictStage; label: string }[] = [
  { value: 'latent', label: '潜伏' },
  { value: 'emerging', label: '浮现' },
  { value: 'escalating', label: '升级' },
  { value: 'erupting', label: '爆发' },
  { value: 'reversing', label: '逆转' },
  { value: 'resolved', label: '已解决' },
  { value: 'transformed', label: '转化' },
]

const FORESHADOW_STATUS_OPTIONS: { value: ForeshadowStatus; label: string }[] = [
  { value: 'planned', label: '已规划' },
  { value: 'planted', label: '已埋设' },
  { value: 'reinforced', label: '已强化' },
  { value: 'partially_revealed', label: '部分揭示' },
  { value: 'recovering', label: '回收中' },
  { value: 'recovered', label: '已回收' },
  { value: 'abandoned', label: '已废弃' },
]

// 动态状态字段（用于变更历史记录）
const DYNAMIC_FIELDS: CharacterHistoryField[] = [
  'currentState',
  'currentGoal',
  'currentPressure',
  'secret',
  'arcStage',
]

const HISTORY_FIELD_LABELS: Record<CharacterHistoryField, string> = {
  currentState: '当前状态',
  currentGoal: '当前目标',
  currentPressure: '当前压力',
  secret: '秘密',
  arcStage: '弧光阶段',
}

// 简单的相对时间格式化
function relativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  const year = Math.floor(month / 12)
  return `${year} 年前`
}

// ── 主组件 ──

export function NovelDetailPanel(): ReactElement {
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelStore((s) => s.selectedNodeType)
  const clearSelection = useNovelStore((s) => s.clearSelection)
  const projects = useNovelStore((s) => s.projects)
  const characters = useNovelStore((s) => s.characters)
  const chapters = useNovelStore((s) => s.chapters)
  const conflicts = useNovelStore((s) => s.conflicts)
  const foreshadows = useNovelStore((s) => s.foreshadows)

  const entity = useMemo(() => {
    if (!selectedNodeId || !selectedNodeType) return null
    switch (selectedNodeType) {
      case 'project':
        return projects.find((p) => p.id === selectedNodeId) ?? null
      case 'character':
        return characters.find((c) => c.id === selectedNodeId) ?? null
      case 'chapter':
        return chapters.find((c) => c.id === selectedNodeId) ?? null
      case 'conflict':
        return conflicts.find((c) => c.id === selectedNodeId) ?? null
      case 'foreshadow':
        return foreshadows.find((f) => f.id === selectedNodeId) ?? null
      default:
        return null
    }
  }, [selectedNodeId, selectedNodeType, projects, characters, chapters, conflicts, foreshadows])

  if (!entity || !selectedNodeType) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-surface-1 border-l border-border p-6 text-center">
        <Info className="size-6 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">
          在画布上选择一个节点以查看详情
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface-1 border-l border-border">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="secondary" className="shrink-0">
            {selectedNodeType}
          </Badge>
          <span className="text-sm font-medium text-text truncate">
            {entityTitle(entity, selectedNodeType)}
          </span>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={clearSelection} aria-label="关闭">
          <X className="size-3.5" />
        </Button>
      </div>

      {/* 表单 */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {selectedNodeType === 'project' && (
          <ProjectForm key={entity.id} entity={entity as NovelProject} />
        )}
        {selectedNodeType === 'character' && (
          <CharacterForm key={entity.id} entity={entity as NovelCharacter} />
        )}
        {selectedNodeType === 'chapter' && (
          <ChapterForm key={entity.id} entity={entity as NovelChapter} />
        )}
        {selectedNodeType === 'conflict' && (
          <ConflictForm key={entity.id} entity={entity as NovelConflict} />
        )}
        {selectedNodeType === 'foreshadow' && (
          <ForeshadowForm key={entity.id} entity={entity as NovelForeshadow} />
        )}
      </div>
    </div>
  )
}

function entityTitle(entity: unknown, type: string): string {
  const e = entity as Record<string, unknown>
  if (type === 'project') return String(e.title ?? '')
  if (type === 'chapter') return String(e.title ?? `第 ${e.chapterNumber} 章`)
  if (type === 'character') return String(e.name ?? '')
  if (type === 'conflict' || type === 'foreshadow') {
    const d = String(e.description ?? '')
    return d.length > 20 ? `${d.slice(0, 20)}...` : d
  }
  return ''
}

// ── 保存按钮 ──

function SaveButton({
  onSave,
  disabled,
  saving,
}: {
  onSave: () => void
  disabled: boolean
  saving: boolean
}): ReactElement {
  return (
    <div className="pt-2">
      <Button onClick={onSave} disabled={disabled || saving} className="w-full">
        <Save className="size-3.5" />
        {saving ? '保存中...' : '保存修改'}
      </Button>
    </div>
  )
}

// ── 项目表单 ──

function ProjectForm({ entity }: { entity: NovelProject }): ReactElement {
  const upsertProject = useNovelStore((s) => s.upsertProject)
  const [form, setForm] = useState({
    title: entity.title,
    genre: entity.genre,
    synopsis: entity.synopsis,
    targetWords: String(entity.targetWords),
    currentStage: entity.currentStage,
    status: entity.status,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    form.title !== entity.title ||
    form.genre !== entity.genre ||
    form.synopsis !== entity.synopsis ||
    Number(form.targetWords) !== entity.targetWords ||
    form.currentStage !== entity.currentStage ||
    form.status !== entity.status

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateProject(entity.id, {
        title: form.title,
        genre: form.genre,
        synopsis: form.synopsis,
        targetWords: Number(form.targetWords) || 0,
        currentStage: form.currentStage,
        status: form.status,
      })
      upsertProject(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertProject])

  return (
    <div className="space-y-3">
      <FieldRow label="标题">
        <TextInput value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
      </FieldRow>
      <FieldRow label="题材">
        <TextInput value={form.genre} onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))} />
      </FieldRow>
      <FieldRow label="简介">
        <TextArea value={form.synopsis} onChange={(e) => setForm((f) => ({ ...f, synopsis: e.target.value }))} />
      </FieldRow>
      <FieldRow label="目标字数">
        <TextInput
          type="number"
          value={form.targetWords}
          onChange={(e) => setForm((f) => ({ ...f, targetWords: e.target.value }))}
        />
      </FieldRow>
      <FieldRow label="当前阶段">
        <Select value={form.currentStage} onValueChange={(v) => setForm((f) => ({ ...f, currentStage: v as StoryStage }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STAGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as NovelProject['status'] }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 角色表单 ──

function CharacterForm({ entity }: { entity: NovelCharacter }): ReactElement {
  const upsertCharacter = useNovelStore((s) => s.upsertCharacter)
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
    <div className="space-y-3">
      <FieldRow label="姓名">
        <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </FieldRow>
      <FieldRow label="身份">
        <TextInput value={form.identity} onChange={(e) => setForm((f) => ({ ...f, identity: e.target.value }))} />
      </FieldRow>
      <FieldRow label="简述">
        <TextArea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>
      <FieldRow label="性格">
        <TextArea value={form.personality} onChange={(e) => setForm((f) => ({ ...f, personality: e.target.value }))} />
      </FieldRow>
      <FieldRow label="外貌">
        <TextArea value={form.appearance} onChange={(e) => setForm((f) => ({ ...f, appearance: e.target.value }))} />
      </FieldRow>

      {/* 动态状态字段分组（带变更历史提示） */}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-2">
        <p className="text-[10px] text-amber-700 dark:text-amber-300 flex items-center gap-1">
          <Info className="size-3" />
          修改动态状态会记录到变更历史
        </p>
        <FieldRow label="当前状态">
          <TextInput value={form.currentState} onChange={(e) => setForm((f) => ({ ...f, currentState: e.target.value }))} />
        </FieldRow>
        <FieldRow label="当前目标">
          <TextInput value={form.currentGoal} onChange={(e) => setForm((f) => ({ ...f, currentGoal: e.target.value }))} />
        </FieldRow>
        <FieldRow label="当前压力">
          <TextInput value={form.currentPressure} onChange={(e) => setForm((f) => ({ ...f, currentPressure: e.target.value }))} />
        </FieldRow>
        <FieldRow label="秘密">
          <TextArea value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} />
        </FieldRow>
        <FieldRow label="弧光阶段">
          <TextInput value={form.arcStage} onChange={(e) => setForm((f) => ({ ...f, arcStage: e.target.value }))} />
        </FieldRow>
      </div>

      <FieldRow label="说话风格">
        <TextInput value={form.speechStyle} onChange={(e) => setForm((f) => ({ ...f, speechStyle: e.target.value }))} />
      </FieldRow>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />

      {/* 状态变更历史时间线 */}
      <CharacterHistorySection characterId={entity.id} />
    </div>
  )
}

// ── 角色状态变更历史 ──

function CharacterHistorySection({ characterId }: { characterId: string }): ReactElement {
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const addCharacterHistory = useNovelStore((s) => s.addCharacterHistory)
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
          <Badge variant="secondary" className="h-4 px-1 text-[10px]">
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

function CharacterHistoryTimeline({
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

interface ManualHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  characterId: string
  onCreated: (entry: NovelCharacterHistory) => void
}

function ManualHistoryDialog({
  open,
  onOpenChange,
  characterId,
  onCreated,
}: ManualHistoryDialogProps): ReactElement {
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
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
          <DialogDescription>记录角色动态状态的一次变更</DialogDescription>
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

// ── 章节表单 ──

function ChapterForm({ entity }: { entity: NovelChapter }): ReactElement {
  const upsertChapter = useNovelStore((s) => s.upsertChapter)
  const [form, setForm] = useState({
    title: entity.title,
    content: entity.content,
    status: entity.status,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    form.title !== entity.title ||
    form.content !== entity.content ||
    form.status !== entity.status

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateChapter(entity.id, form)
      upsertChapter(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertChapter])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>第 {entity.chapterNumber} 章 · 卷 {entity.volume}</span>
        <span>{entity.wordCount} 字</span>
      </div>
      <FieldRow label="标题">
        <TextInput value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
      </FieldRow>
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as ChapterStatus }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHAPTER_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="内容">
        <TextArea
          value={form.content}
          onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
          className="min-h-[200px] font-mono text-xs"
        />
      </FieldRow>
      {entity.narrativeTask && (
        <FieldRow label="叙事任务">
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap rounded bg-muted/50 p-2">
            {entity.narrativeTask}
          </pre>
        </FieldRow>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 冲突编辑表单 ──

function ConflictForm({ entity }: { entity: NovelConflict }): ReactElement {
  const upsertConflict = useNovelStore((s) => s.upsertConflict)
  const [form, setForm] = useState({
    description: entity.description,
    type: entity.type,
    intensity: String(entity.intensity),
    stage: entity.stage,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  let participants: string[] = []
  try {
    const p = JSON.parse(entity.participants)
    if (Array.isArray(p)) participants = p.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }

  const dirty =
    form.description !== entity.description ||
    form.type !== entity.type ||
    form.stage !== entity.stage ||
    Number(form.intensity) !== entity.intensity

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateConflict(entity.id, {
        description: form.description,
        type: form.type,
        intensity: Number(form.intensity) || 0,
        stage: form.stage,
      })
      upsertConflict(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertConflict])

  return (
    <div className="space-y-3">
      <FieldRow label="描述">
        <TextArea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>
      <FieldRow label="类型">
        <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as ConflictType }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONFLICT_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="阶段">
        <Select value={form.stage} onValueChange={(v) => setForm((f) => ({ ...f, stage: v as ConflictStage }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONFLICT_STAGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="强度">
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-rose-500"
              style={{ width: `${(Number(form.intensity) / 10) * 100}%` }}
            />
          </div>
          <TextInput
            type="number"
            min={0}
            max={10}
            value={form.intensity}
            onChange={(e) => setForm((f) => ({ ...f, intensity: e.target.value }))}
            className="w-16"
          />
          <span className="text-xs text-muted-foreground">/10</span>
        </div>
      </FieldRow>
      {participants.length > 0 && (
        <FieldRow label="参与者">
          <div className="flex flex-wrap gap-1">
            {participants.map((id) => (
              <Badge key={id} variant="outline" className="text-[10px]">{id}</Badge>
            ))}
          </div>
        </FieldRow>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}

// ── 伏笔编辑表单 ──

function ForeshadowForm({ entity }: { entity: NovelForeshadow }): ReactElement {
  const upsertForeshadow = useNovelStore((s) => s.upsertForeshadow)
  const [form, setForm] = useState({
    description: entity.description,
    category: entity.category,
    status: entity.status,
    firstChapter: entity.firstChapter != null ? String(entity.firstChapter) : '',
    lastChapter: entity.lastChapter != null ? String(entity.lastChapter) : '',
    recoverByChapter: entity.recoverByChapter != null ? String(entity.recoverByChapter) : '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  let linkedCharacters: string[] = []
  try {
    const p = JSON.parse(entity.linkedCharacters)
    if (Array.isArray(p)) linkedCharacters = p.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }

  const toNumOrNull = (v: string): number | null => (v === '' ? null : Number(v))

  const dirty =
    form.description !== entity.description ||
    form.category !== entity.category ||
    form.status !== entity.status ||
    toNumOrNull(form.firstChapter) !== entity.firstChapter ||
    toNumOrNull(form.lastChapter) !== entity.lastChapter ||
    toNumOrNull(form.recoverByChapter) !== entity.recoverByChapter

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateForeshadow(entity.id, {
        description: form.description,
        category: form.category,
        status: form.status,
        firstChapter: toNumOrNull(form.firstChapter),
        lastChapter: toNumOrNull(form.lastChapter),
        recoverByChapter: toNumOrNull(form.recoverByChapter),
      })
      upsertForeshadow(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertForeshadow])

  return (
    <div className="space-y-3">
      <FieldRow label="描述">
        <TextArea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </FieldRow>
      <FieldRow label="分类">
        <TextInput value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} />
      </FieldRow>
      <FieldRow label="状态">
        <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as ForeshadowStatus }))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORESHADOW_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <div className="grid grid-cols-3 gap-2">
        <FieldRow label="首次出现">
          <TextInput
            type="number"
            value={form.firstChapter}
            onChange={(e) => setForm((f) => ({ ...f, firstChapter: e.target.value }))}
          />
        </FieldRow>
        <FieldRow label="最后强化">
          <TextInput
            type="number"
            value={form.lastChapter}
            onChange={(e) => setForm((f) => ({ ...f, lastChapter: e.target.value }))}
          />
        </FieldRow>
        <FieldRow label="回收期限">
          <TextInput
            type="number"
            value={form.recoverByChapter}
            onChange={(e) => setForm((f) => ({ ...f, recoverByChapter: e.target.value }))}
          />
        </FieldRow>
      </div>
      {linkedCharacters.length > 0 && (
        <FieldRow label="关联角色">
          <div className="flex flex-wrap gap-1">
            {linkedCharacters.map((id) => (
              <Badge key={id} variant="outline" className="text-[10px]">{id}</Badge>
            ))}
          </div>
        </FieldRow>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
