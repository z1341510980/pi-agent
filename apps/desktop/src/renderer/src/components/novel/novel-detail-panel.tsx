import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { Save, X, Info } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  updateProject,
  updateCharacter,
  updateChapter,
  type NovelProject,
  type NovelCharacter,
  type NovelChapter,
  type NovelConflict,
  type NovelForeshadow,
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
          <ConflictView entity={entity as NovelConflict} />
        )}
        {selectedNodeType === 'foreshadow' && (
          <ForeshadowView entity={entity as NovelForeshadow} />
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
      <FieldRow label="说话风格">
        <TextInput value={form.speechStyle} onChange={(e) => setForm((f) => ({ ...f, speechStyle: e.target.value }))} />
      </FieldRow>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
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

// ── 冲突只读视图 ──

function ConflictView({ entity }: { entity: NovelConflict }): ReactElement {
  const typeLabel = CONFLICT_TYPE_OPTIONS.find((o) => o.value === entity.type)?.label ?? entity.type
  const stageLabel = CONFLICT_STAGE_OPTIONS.find((o) => o.value === entity.stage)?.label ?? entity.stage
  let participants: string[] = []
  try {
    const p = JSON.parse(entity.participants)
    if (Array.isArray(p)) participants = p.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-rose-500/5 border border-rose-500/20 p-2.5">
        <p className="text-sm text-text">{entity.description}</p>
      </div>
      <FieldRow label="类型">
        <Badge variant="secondary">{typeLabel}</Badge>
      </FieldRow>
      <FieldRow label="阶段">
        <Badge variant="secondary">{stageLabel}</Badge>
      </FieldRow>
      <FieldRow label="强度">
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-rose-500"
              style={{ width: `${(entity.intensity / 10) * 100}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">{entity.intensity}/10</span>
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
      <p className="text-[10px] text-muted-foreground flex items-center gap-1 pt-2">
        <Info className="size-3" /> 冲突暂不支持编辑，可通过创建流程更新
      </p>
    </div>
  )
}

// ── 伏笔只读视图 ──

function ForeshadowView({ entity }: { entity: NovelForeshadow }): ReactElement {
  const statusLabel = FORESHADOW_STATUS_OPTIONS.find((o) => o.value === entity.status)?.label ?? entity.status
  let linkedCharacters: string[] = []
  try {
    const p = JSON.parse(entity.linkedCharacters)
    if (Array.isArray(p)) linkedCharacters = p.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-2.5">
        <p className="text-sm text-text">{entity.description}</p>
      </div>
      <FieldRow label="分类">
        <Badge variant="secondary">{entity.category || '未分类'}</Badge>
      </FieldRow>
      <FieldRow label="状态">
        <Badge variant="secondary">{statusLabel}</Badge>
      </FieldRow>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded bg-muted/50 p-2">
          <div className="text-muted-foreground text-[10px]">首次出现</div>
          <div className="text-text">{entity.firstChapter ?? '—'}</div>
        </div>
        <div className="rounded bg-muted/50 p-2">
          <div className="text-muted-foreground text-[10px]">最后强化</div>
          <div className="text-text">{entity.lastChapter ?? '—'}</div>
        </div>
        <div className="rounded bg-muted/50 p-2">
          <div className="text-muted-foreground text-[10px]">回收期限</div>
          <div className="text-text">{entity.recoverByChapter ?? '—'}</div>
        </div>
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
      <p className="text-[10px] text-muted-foreground flex items-center gap-1 pt-2">
        <Info className="size-3" /> 伏笔暂不支持编辑，可通过创建流程更新
      </p>
    </div>
  )
}
