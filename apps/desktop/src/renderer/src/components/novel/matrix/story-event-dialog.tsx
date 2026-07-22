import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createStoryEvent,
  getChapterStoryContext,
  type ChangeValueType,
  type CreateStoryEventPayload,
  type EntityStoryTimeline,
  type NovelStoryEntityType,
  type StoryEventEntityRole,
  type StoryEventStatus,
  type StoryEventType,
} from '@/api/novel-client'
import { useNovelDataStore } from '@/stores/novel-data-store'
import type { MatrixEntity } from './matrix-logic'
import { parseStoryValue } from './story-event-value'

interface StoryEventDialogProps {
  open: boolean
  projectId: string | null
  entity: MatrixEntity
  defaultChapter: number
  timeline?: EntityStoryTimeline
  onClose: () => void
  onCreated: () => void
}

interface CatalogItem {
  type: NovelStoryEntityType
  id: string
  label: string
}

interface EntityRefDraft {
  key: number
  entityType: NovelStoryEntityType
  entityId: string
  role: StoryEventEntityRole
  note: string
}

interface ChangeDraft {
  key: number
  subjectType: NovelStoryEntityType
  subjectId: string
  dimension: string
  targetType: NovelStoryEntityType | ''
  targetId: string
  valueType: ChangeValueType
  beforeValue: string
  afterValue: string
  reason: string
  significance: number
}

const SELECT_CLASS = 'h-8 w-full min-w-0 rounded border border-input bg-surface-1 px-2 text-xs text-text outline-none focus:border-primary'
const TEXTAREA_CLASS = 'min-h-16 w-full resize-y rounded border border-input bg-surface-1 px-2.5 py-2 text-xs text-text outline-none placeholder:text-muted-foreground focus:border-primary'

const ENTITY_TYPE_LABELS: Partial<Record<NovelStoryEntityType, string>> = {
  character: '角色',
  relationship: '人物关系',
  conflict: '冲突',
  foreshadow: '伏笔',
  clue: '线索',
  item: '物品',
  faction: '势力',
  location: '地点',
  world_element: '世界要素',
  world_rule: '世界规则',
  info_layer: '信息差',
  chapter: '章节',
}

const EVENT_TYPES: Array<{ value: StoryEventType; label: string }> = [
  { value: 'encounter', label: '相遇' },
  { value: 'conflict', label: '冲突' },
  { value: 'discovery', label: '发现' },
  { value: 'transfer', label: '转移' },
  { value: 'reveal', label: '揭示' },
  { value: 'decision', label: '决定' },
  { value: 'transition', label: '转折' },
  { value: 'resolution', label: '结果' },
  { value: 'custom', label: '自定义' },
]

const EVENT_STATUSES: Array<{ value: StoryEventStatus; label: string }> = [
  { value: 'planned', label: '计划' },
  { value: 'confirmed', label: '已确认' },
  { value: 'generated', label: '正文已生成' },
  { value: 'superseded', label: '已取代' },
]

const REF_ROLES: Array<{ value: StoryEventEntityRole; label: string }> = [
  { value: 'actor', label: '行动者' },
  { value: 'target', label: '目标' },
  { value: 'participant', label: '参与方' },
  { value: 'trigger', label: '触发因素' },
  { value: 'evidence', label: '证据' },
  { value: 'resource', label: '资源' },
  { value: 'location', label: '发生地点' },
  { value: 'affected', label: '受影响' },
  { value: 'outcome', label: '结果对象' },
]

const VALUE_TYPES: Array<{ value: ChangeValueType; label: string }> = [
  { value: 'enum', label: '状态' },
  { value: 'level', label: '等级' },
  { value: 'number', label: '数值' },
  { value: 'set', label: '集合' },
  { value: 'reference', label: '引用' },
  { value: 'text', label: '文本' },
]

const DEFAULT_DIMENSION: Partial<Record<NovelStoryEntityType, string>> = {
  character: 'state',
  relationship: 'relationship.trust',
  conflict: 'stage',
  foreshadow: 'status',
  clue: 'status',
  item: 'owner',
  faction: 'alignment',
  location: 'state',
  world_element: 'state',
  world_rule: 'state',
  info_layer: 'knownBy',
  chapter: 'state',
}

export function StoryEventDialog({
  open,
  projectId,
  entity,
  defaultChapter,
  timeline,
  onClose,
  onCreated,
}: StoryEventDialogProps): ReactElement {
  const characters = useNovelDataStore((state) => state.characters)
  const relationships = useNovelDataStore((state) => state.relationships)
  const conflicts = useNovelDataStore((state) => state.conflicts)
  const foreshadows = useNovelDataStore((state) => state.foreshadows)
  const clues = useNovelDataStore((state) => state.clues)
  const items = useNovelDataStore((state) => state.items)
  const factions = useNovelDataStore((state) => state.factions)
  const locations = useNovelDataStore((state) => state.locations)
  const worldElements = useNovelDataStore((state) => state.worldElements)
  const worldRules = useNovelDataStore((state) => state.worldRules)
  const infoLayers = useNovelDataStore((state) => state.infoLayers)
  const chapters = useNovelDataStore((state) => state.chapters)

  const catalog = useMemo<CatalogItem[]>(() => {
    const characterNames = new Map(characters.map((item) => [item.id, item.name]))
    return [
      ...characters.map((item) => ({ type: 'character' as const, id: item.id, label: item.name })),
      ...relationships.map((item) => ({
        type: 'relationship' as const,
        id: item.id,
        label: `${characterNames.get(item.characterA) ?? item.characterA} / ${characterNames.get(item.characterB) ?? item.characterB} · ${item.relationType}`,
      })),
      ...conflicts.map((item) => ({ type: 'conflict' as const, id: item.id, label: item.description })),
      ...foreshadows.map((item) => ({ type: 'foreshadow' as const, id: item.id, label: item.description })),
      ...clues.map((item) => ({ type: 'clue' as const, id: item.id, label: item.description })),
      ...items.map((item) => ({ type: 'item' as const, id: item.id, label: item.name })),
      ...factions.map((item) => ({ type: 'faction' as const, id: item.id, label: item.name })),
      ...locations.map((item) => ({ type: 'location' as const, id: item.id, label: item.name })),
      ...worldElements.map((item) => ({ type: 'world_element' as const, id: item.id, label: item.name })),
      ...worldRules.map((item) => ({ type: 'world_rule' as const, id: item.id, label: item.rule })),
      ...infoLayers.map((item) => ({ type: 'info_layer' as const, id: item.id, label: item.infoDescription })),
      ...chapters.map((item) => ({ type: 'chapter' as const, id: item.id, label: `第${item.chapterNumber}章 ${item.title}` })),
    ]
  }, [chapters, characters, clues, conflicts, factions, foreshadows, infoLayers, items, locations, relationships, worldElements, worldRules])

  const availableTypes = useMemo(
    () => [...new Set(catalog.map((item) => item.type))],
    [catalog],
  )
  const firstEntityId = (type: NovelStoryEntityType): string => catalog.find((item) => item.type === type)?.id ?? ''

  const [chapterNumber, setChapterNumber] = useState(defaultChapter)
  const [sceneOrder, setSceneOrder] = useState(0)
  const [eventType, setEventType] = useState<StoryEventType>('custom')
  const [status, setStatus] = useState<StoryEventStatus>('planned')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [outcome, setOutcome] = useState('')
  const [refs, setRefs] = useState<EntityRefDraft[]>([])
  const [changes, setChanges] = useState<ChangeDraft[]>([])
  const [nextKey, setNextKey] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chapterContextQuery = useQuery({
    queryKey: ['novel-chapter-story-context', projectId, chapterNumber],
    queryFn: () => getChapterStoryContext(projectId!, chapterNumber),
    enabled: open && Boolean(projectId),
  })

  useEffect(() => {
    if (!open) return
    setChapterNumber(defaultChapter)
    setSceneOrder(0)
    setEventType('custom')
    setStatus('planned')
    setTitle('')
    setSummary('')
    setOutcome('')
    setRefs([{ key: 0, entityType: entity.kind, entityId: entity.entityId, role: 'participant', note: '' }])
    setChanges([])
    setNextKey(1)
    setSubmitting(false)
    setError(null)
  }, [defaultChapter, entity.entityId, entity.kind, open])

  const entitiesFor = (type: NovelStoryEntityType | ''): CatalogItem[] => type ? catalog.filter((item) => item.type === type) : []

  const addRef = (): void => {
    const type = availableTypes[0] ?? entity.kind
    setRefs((current) => [...current, { key: nextKey, entityType: type, entityId: firstEntityId(type), role: 'participant', note: '' }])
    setNextKey((value) => value + 1)
  }

  const addChange = (): void => {
    setChanges((current) => [...current, {
      key: nextKey,
      subjectType: entity.kind,
      subjectId: entity.entityId,
      dimension: DEFAULT_DIMENSION[entity.kind] ?? 'state',
      targetType: '',
      targetId: '',
      valueType: 'enum',
      beforeValue: '',
      afterValue: '',
      reason: '',
      significance: 5,
    }])
    setNextKey((value) => value + 1)
  }

  const inferBeforeValue = (change: ChangeDraft): unknown => {
    if (change.beforeValue.trim()) return parseStoryValue(change.beforeValue, change.valueType)
    const candidates = (timeline?.changes ?? [])
      .filter((item) =>
        (item.chapterNumber < chapterNumber || (item.chapterNumber === chapterNumber && item.sceneOrder < sceneOrder))
        && item.subjectType === change.subjectType
        && item.subjectId === change.subjectId
        && item.dimension === change.dimension
        && item.targetType === (change.targetType || null)
        && item.targetId === (change.targetId || null),
      )
      .sort((a, b) => a.chapterNumber - b.chapterNumber || a.sceneOrder - b.sceneOrder)
    const timelineValue = candidates[candidates.length - 1]?.afterValue
    if (timelineValue !== undefined) return timelineValue
    return chapterContextQuery.data?.stateBeforeChapter.find((item) =>
      item.subjectType === change.subjectType
      && item.subjectId === change.subjectId
      && item.dimension === change.dimension
      && item.targetType === (change.targetType || null)
      && item.targetId === (change.targetId || null),
    )?.value ?? null
  }

  const handleSubmit = async (): Promise<void> => {
    if (!projectId || !title.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const payload: CreateStoryEventPayload = {
        event: {
          chapterNumber,
          sceneId: null,
          sceneOrder,
          type: eventType,
          title: title.trim(),
          summary: summary.trim(),
          outcome: outcome.trim(),
          status,
          parentEventId: null,
          source: 'manual',
        },
        entityRefs: refs.filter((ref) => ref.entityId).map((ref) => ({
          entityType: ref.entityType,
          entityId: ref.entityId,
          role: ref.role,
          note: ref.note.trim(),
        })),
        changes: changes.filter((change) => change.subjectId && change.dimension.trim()).map((change) => ({
          subjectType: change.subjectType,
          subjectId: change.subjectId,
          dimension: change.dimension.trim(),
          targetType: change.targetType || null,
          targetId: change.targetType ? change.targetId || null : null,
          valueType: change.valueType,
          beforeValue: inferBeforeValue(change),
          afterValue: parseStoryValue(change.afterValue, change.valueType),
          reason: change.reason.trim(),
          significance: change.significance,
          source: 'manual',
          cause: null,
          effectIds: [],
        })),
      }
      await createStoryEvent(projectId, payload)
      onCreated()
      onClose()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>新增故事事件</DialogTitle>
          <DialogDescription className="sr-only">新增故事事件及其关联实体和变化记录</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 overflow-y-auto pr-1">
          <section className="grid grid-cols-2 gap-3 border-b border-border/60 pb-4 md:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="story-event-chapter">章节</Label>
              <Input id="story-event-chapter" type="number" min={1} value={chapterNumber} onChange={(event) => setChapterNumber(Math.max(1, Number(event.target.value) || 1))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="story-event-scene-order">场景顺序</Label>
              <Input id="story-event-scene-order" type="number" min={0} value={sceneOrder} onChange={(event) => setSceneOrder(Math.max(0, Number(event.target.value) || 0))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="story-event-type">类型</Label>
              <select id="story-event-type" className={SELECT_CLASS} value={eventType} onChange={(event) => setEventType(event.target.value as StoryEventType)}>
                {EVENT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="story-event-status">状态</Label>
              <select id="story-event-status" className={SELECT_CLASS} value={status} onChange={(event) => setStatus(event.target.value as StoryEventStatus)}>
                {EVENT_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
            <div className="col-span-2 space-y-1.5 md:col-span-4">
              <Label htmlFor="story-event-title">事件标题</Label>
              <Input id="story-event-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="story-event-summary">发生过程</Label>
              <textarea id="story-event-summary" className={TEXTAREA_CLASS} value={summary} onChange={(event) => setSummary(event.target.value)} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="story-event-outcome">事件结果</Label>
              <textarea id="story-event-outcome" className={TEXTAREA_CLASS} value={outcome} onChange={(event) => setOutcome(event.target.value)} />
            </div>
          </section>

          <section className="space-y-2 border-b border-border/60 pb-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-text">关联实体</h3>
              <Button type="button" variant="outline" size="sm" onClick={addRef}><Plus className="size-3.5" />添加关联</Button>
            </div>
            {refs.map((ref) => (
              <div key={ref.key} className="grid grid-cols-[110px_minmax(140px,1fr)_110px_minmax(120px,1fr)_32px] gap-2">
                <select className={SELECT_CLASS} value={ref.entityType} onChange={(event) => {
                  const entityType = event.target.value as NovelStoryEntityType
                  setRefs((current) => current.map((item) => item.key === ref.key ? { ...item, entityType, entityId: firstEntityId(entityType) } : item))
                }}>
                  {availableTypes.map((type) => <option key={type} value={type}>{ENTITY_TYPE_LABELS[type] ?? type}</option>)}
                </select>
                <select className={SELECT_CLASS} value={ref.entityId} onChange={(event) => setRefs((current) => current.map((item) => item.key === ref.key ? { ...item, entityId: event.target.value } : item))}>
                  {entitiesFor(ref.entityType).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <select className={SELECT_CLASS} value={ref.role} onChange={(event) => setRefs((current) => current.map((item) => item.key === ref.key ? { ...item, role: event.target.value as StoryEventEntityRole } : item))}>
                  {REF_ROLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <Input aria-label="关联说明" placeholder="说明" value={ref.note} onChange={(event) => setRefs((current) => current.map((item) => item.key === ref.key ? { ...item, note: event.target.value } : item))} />
                <Button type="button" variant="ghost" size="icon-sm" aria-label="删除关联" title="删除关联" onClick={() => setRefs((current) => current.filter((item) => item.key !== ref.key))}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-text">变化记录</h3>
              <Button type="button" variant="outline" size="sm" onClick={addChange}><Plus className="size-3.5" />添加变化</Button>
            </div>
            {changes.map((change) => (
              <div key={change.key} className="grid grid-cols-2 gap-2 border-b border-border/40 pb-3 md:grid-cols-6">
                <select className={SELECT_CLASS} value={change.subjectType} onChange={(event) => {
                  const subjectType = event.target.value as NovelStoryEntityType
                  setChanges((current) => current.map((item) => item.key === change.key ? { ...item, subjectType, subjectId: firstEntityId(subjectType), dimension: DEFAULT_DIMENSION[subjectType] ?? 'state' } : item))
                }}>
                  {availableTypes.map((type) => <option key={type} value={type}>{ENTITY_TYPE_LABELS[type] ?? type}</option>)}
                </select>
                <select className={SELECT_CLASS} value={change.subjectId} onChange={(event) => setChanges((current) => current.map((item) => item.key === change.key ? { ...item, subjectId: event.target.value } : item))}>
                  {entitiesFor(change.subjectType).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <Input aria-label="变化维度" placeholder="维度，如 relationship.suspicion" value={change.dimension} onChange={(event) => setChanges((current) => current.map((item) => item.key === change.key ? { ...item, dimension: event.target.value } : item))} />
                <select className={SELECT_CLASS} value={change.valueType} onChange={(event) => setChanges((current) => current.map((item) => item.key === change.key ? { ...item, valueType: event.target.value as ChangeValueType } : item))}>
                  {VALUE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <Input aria-label="变化前值" placeholder="前值（留空自动推断）" value={change.beforeValue} onChange={(event) => setChanges((current) => current.map((item) => item.key === change.key ? { ...item, beforeValue: event.target.value } : item))} />
                <div className="flex gap-1">
                  <Input aria-label="变化后值" placeholder="后值" value={change.afterValue} onChange={(event) => setChanges((current) => current.map((item) => item.key === change.key ? { ...item, afterValue: event.target.value } : item))} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="删除变化" title="删除变化" onClick={() => setChanges((current) => current.filter((item) => item.key !== change.key))}><Trash2 className="size-3.5" /></Button>
                </div>
                <select className={SELECT_CLASS} value={change.targetType} onChange={(event) => {
                  const targetType = event.target.value as NovelStoryEntityType | ''
                  setChanges((current) => current.map((item) => item.key === change.key ? { ...item, targetType, targetId: targetType ? firstEntityId(targetType) : '' } : item))
                }}>
                  <option value="">无目标实体</option>
                  {availableTypes.map((type) => <option key={type} value={type}>目标：{ENTITY_TYPE_LABELS[type] ?? type}</option>)}
                </select>
                <select className={SELECT_CLASS} value={change.targetId} disabled={!change.targetType} onChange={(event) => setChanges((current) => current.map((item) => item.key === change.key ? { ...item, targetId: event.target.value } : item))}>
                  {!change.targetType && <option value="">无</option>}
                  {entitiesFor(change.targetType).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <Input className="md:col-span-3" aria-label="变化原因" placeholder="原因" value={change.reason} onChange={(event) => setChanges((current) => current.map((item) => item.key === change.key ? { ...item, reason: event.target.value } : item))} />
                <div className="flex items-center gap-2">
                  <Label className="shrink-0">重要度</Label>
                  <Input type="number" min={1} max={10} value={change.significance} onChange={(event) => setChanges((current) => current.map((item) => item.key === change.key ? { ...item, significance: Math.max(1, Math.min(10, Number(event.target.value) || 1)) } : item))} />
                </div>
              </div>
            ))}
          </section>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={submitting || !projectId || !title.trim()}>{submitting ? '保存中…' : '保存事件'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
