import {
  BookOpen,
  CircleDot,
  Database,
  FileText,
  History,
  ListTree,
  Network,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import type { EntityStoryTimeline } from '@/api/novel-client'
import type { NovelNodeType } from '@/stores/novel-ui-store'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type DetailEntityType = Exclude<NovelNodeType, 'group'>

interface OverviewField {
  key: string
  label: string
  value: unknown
}

interface EntityPresentation {
  icon: LucideIcon
  tone: string
}

const ENTITY_PRESENTATIONS: Record<DetailEntityType, EntityPresentation> = {
  project: { icon: BookOpen, tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  character: { icon: CircleDot, tone: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' },
  chapter: { icon: FileText, tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  volume: { icon: BookOpen, tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  conflict: { icon: Sparkles, tone: 'bg-orange-500/10 text-orange-700 dark:text-orange-300' },
  clue: { icon: CircleDot, tone: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300' },
  foreshadow: { icon: Sparkles, tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  faction: { icon: Network, tone: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  location: { icon: CircleDot, tone: 'bg-teal-500/10 text-teal-700 dark:text-teal-300' },
  world_element: { icon: BookOpen, tone: 'bg-lime-500/10 text-lime-700 dark:text-lime-300' },
  info_layer: { icon: ListTree, tone: 'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300' },
  item: { icon: CircleDot, tone: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300' },
  narrative: { icon: History, tone: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300' }
}

export function getDetailEntityPresentation(entityType: DetailEntityType): EntityPresentation {
  return ENTITY_PRESENTATIONS[entityType]
}

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  name: '名称',
  description: '描述',
  summary: '摘要',
  premise: '核心设定',
  genre: '题材',
  themes: '主题',
  tone: '基调',
  style: '文风',
  status: '状态',
  type: '类型',
  category: '分类',
  identity: '身份',
  role: '角色定位',
  age: '年龄',
  gender: '性别',
  appearance: '外貌',
  background: '背景',
  motivation: '动机',
  goal: '目标',
  currentGoal: '当前目标',
  currentState: '当前状态',
  currentPressure: '当前压力',
  longTermDesire: '长期愿望',
  shortTermGoal: '近期目标',
  secret: '秘密',
  removalImpact: '删掉影响',
  arcStage: '弧光阶段',
  personality: '性格特征',
  speechStyle: '说话风格',
  strengths: '优势',
  weaknesses: '弱点',
  abilities: '能力',
  origin: '来源',
  ownerId: '持有者',
  intensity: '强度',
  stage: '阶段',
  stakes: '利害关系',
  progress: '推进度',
  currentStep: '当前步骤',
  nextStep: '下一步',
  pointsTo: '指向',
  isMisleading: '是否误导',
  significance: '重要性',
  authorKnows: '作者已知',
  readerKnows: '读者已知',
  characterKnows: '角色已知',
  content: '正文',
  outline: '大纲',
  chapterNumber: '章节序号',
  volumeNumber: '卷序号',
  wordCount: '字数',
  targetWords: '目标章节字数',
  targetWordCount: '目标章节字数',
  chapterSpans: '章节范围',
  appearChapters: '出场章节',
  firstChapter: '首次出现章节',
  beats: '伏笔节点',
  scenes: '场景',
  participants: '参与者',
  relationships: '关系',
  members: '成员',
  factions: '所属势力',
  relatedCharacters: '关联角色',
  createdAt: '创建时间',
  updatedAt: '更新时间'
}

const SYSTEM_FIELDS = new Set(['id', 'projectId', 'coverUrl', 'contentHtml'])
const PRIMARY_FIELDS = new Set([
  'title',
  'name',
  'description',
  'summary',
  'premise',
  'genre',
  'type',
  'category',
  'identity',
  'role',
  'status',
  'stage',
  'currentState',
  'currentGoal',
  'progress'
])
const NARRATIVE_FIELDS = ['summary', 'description', 'premise', 'background', 'identity']
const STRUCTURE_PATTERN = /chapter|span|beat|scene|volume|appear|firstChapter|outline|wordCount/i
const RELATION_PATTERN =
  /character|participant|relationship|member|faction|owner|related|target|all(y|ies)|enemy/i

function isEmpty(value: unknown): boolean {
  if (value == null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value as object).length === 0
}

function labelFor(key: string): string {
  return (
    FIELD_LABELS[key] ??
    key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())
  )
}

function formatValue(value: unknown, depth = 0): string {
  if (value == null) return '未设置'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return new Intl.NumberFormat('zh-CN').format(value)
  if (typeof value === 'string') return value.length > 420 ? `${value.slice(0, 420)}...` : value
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => formatValue(item, depth + 1))
    return `${items.join('、')}${value.length > 8 ? ` 等 ${value.length} 项` : ''}`
  }
  if (typeof value === 'object') {
    if (depth > 1) return '已配置'
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => !isEmpty(item)
    )
    const items = entries
      .slice(0, 6)
      .map(([key, item]) => `${labelFor(key)}：${formatValue(item, depth + 1)}`)
    return `${items.join('；')}${entries.length > 6 ? ` 等 ${entries.length} 项` : ''}`
  }
  return String(value)
}

function formatFieldValue(field: OverviewField): string {
  if ((field.key === 'createdAt' || field.key === 'updatedAt') && typeof field.value === 'number') {
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(field.value)
  }
  return formatValue(field.value)
}

function collectFields(entity: Record<string, unknown>): OverviewField[] {
  return Object.entries(entity)
    .filter(([key, value]) => !SYSTEM_FIELDS.has(key) && !isEmpty(value))
    .map(([key, value]) => ({ key, label: labelFor(key), value }))
}

function OverviewSection({
  title,
  icon: Icon,
  source,
  children,
  className
}: {
  title: string
  icon: LucideIcon
  source?: ReactNode
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <section className={cn('border-l-2 border-border/80 pl-3', className)}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-md bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_72%,transparent)]">
          <Icon className="size-3" aria-hidden />
        </span>
        <h3 className="text-micro font-semibold tracking-[0.04em] text-text-secondary">{title}</h3>
        {source && <div className="ml-auto">{source}</div>}
      </div>
      {children}
    </section>
  )
}

function FieldValue({ field }: { field: OverviewField }): ReactElement {
  const listValue = Array.isArray(field.value) ? field.value : null
  const isPrimitiveList =
    listValue !== null &&
    listValue.every((item) => typeof item === 'string' || typeof item === 'number')

  if (isPrimitiveList && listValue) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {listValue.slice(0, 6).map((item) => (
          <span
            key={String(item)}
            className="rounded-md bg-surface-2 px-1.5 py-0.5 text-micro text-text-secondary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_56%,transparent)]"
          >
            {formatValue(item)}
          </span>
        ))}
        {listValue.length > 6 && (
          <span className="self-center text-micro tabular-nums text-muted-foreground">
            +{listValue.length - 6}
          </span>
        )}
      </div>
    )
  }

  return (
    <span
      className={cn(
        'block whitespace-pre-wrap break-words text-caption leading-relaxed text-text-secondary',
        typeof field.value === 'number' && 'tabular-nums',
        typeof field.value === 'boolean' && 'font-medium text-text'
      )}
    >
      {formatFieldValue(field)}
    </span>
  )
}

function FieldList({ fields }: { fields: OverviewField[] }): ReactElement {
  return (
    <dl className="divide-y divide-border/45">
      {fields.map((field) => (
        <div
          key={field.key}
          className="grid grid-cols-[minmax(72px,0.34fr)_1fr] gap-3 py-2.5 first:pt-0 last:pb-0"
        >
          <dt className="pt-0.5 text-micro leading-relaxed text-muted-foreground">{field.label}</dt>
          <dd className="min-w-0">
            <FieldValue field={field} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function LedgerList({
  timeline,
  loading
}: {
  timeline?: EntityStoryTimeline
  loading: boolean
}): ReactElement {
  if (loading) return <p className="text-micro text-muted-foreground">正在读取账本实录...</p>
  // 不假定 timeline.changes 一定存在：后端返回部分字段时，直接读 .length
  // 会把整个详情面板打白。归一成本地数组后下面都不用再判空。
  const changes = timeline?.changes ?? []
  if (changes.length === 0) {
    return (
      <p className="text-micro leading-relaxed text-muted-foreground">
        暂无账本记录。AI 提取或事件关联后会在此显示。
      </p>
    )
  }

  return (
    <ol className="space-y-0">
      {changes.slice(0, 6).map((change, index) => (
        <li key={change.id} className="grid grid-cols-[17px_minmax(0,1fr)] gap-2.5">
          <div className="relative flex justify-center">
            <span className="mt-1.5 size-2 rounded-full bg-primary ring-4 ring-primary/10" />
            {index < Math.min(changes.length, 6) - 1 && (
              <span className="absolute bottom-0 top-4 w-px bg-border/80" />
            )}
          </div>
          <div className="pb-4 last:pb-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-nano tabular-nums text-text-secondary">
                第 {change.chapterNumber} 章
              </span>
              <span className="text-nano text-muted-foreground">
                {change.dimension || '状态变更'}
              </span>
            </div>
            <p className="mt-1.5 text-caption leading-relaxed text-text-secondary">
              {change.reason || formatValue(change.afterValue)}
            </p>
          </div>
        </li>
      ))}
      {changes.length > 6 && (
        <li className="pl-[27px] text-micro tabular-nums text-muted-foreground">
          另有 {changes.length - 6} 条实录
        </li>
      )}
    </ol>
  )
}

export function EntityOverview({
  entity,
  entityType,
  timeline,
  timelineLoading
}: {
  entity: Record<string, unknown>
  entityType: DetailEntityType
  timeline?: EntityStoryTimeline
  timelineLoading: boolean
}): ReactElement {
  const fields = collectFields(entity)
  const narrative = fields.find((field) => NARRATIVE_FIELDS.includes(field.key))
  const contentFields = fields.filter(
    (field) => !['title', 'name', narrative?.key].includes(field.key)
  )
  const core = contentFields.filter((field) => PRIMARY_FIELDS.has(field.key))
  const structure = contentFields.filter(
    (field) => !PRIMARY_FIELDS.has(field.key) && STRUCTURE_PATTERN.test(field.key)
  )
  const relations = contentFields.filter(
    (field) =>
      !PRIMARY_FIELDS.has(field.key) &&
      !STRUCTURE_PATTERN.test(field.key) &&
      RELATION_PATTERN.test(field.key)
  )
  const details = contentFields.filter(
    (field) => !core.includes(field) && !structure.includes(field) && !relations.includes(field)
  )
  const presentation = getDetailEntityPresentation(entityType)
  const EntityIcon = presentation.icon

  return (
    <div className="space-y-5 px-3 py-3">
      <section className="rounded-lg bg-surface-2/70 p-3 shadow-[var(--shadow-border)]">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_12%,transparent)]',
              presentation.tone
            )}
          >
            <EntityIcon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-micro font-semibold tracking-[0.04em] text-text-secondary">
              实体摘要
            </p>
            <p className="mt-0.5 text-nano text-muted-foreground">
              基础信息与矩阵字段在编辑模式维护
            </p>
          </div>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-caption leading-relaxed text-text-secondary">
          {narrative
            ? formatFieldValue(narrative)
            : '暂未记录概述，可在编辑模式补充这个实体的核心设定。'}
        </p>
        {core.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-border/60 pt-2.5">
            {core.slice(0, 4).map((field) => (
              <span key={field.key} className="max-w-full text-micro text-muted-foreground">
                {field.label}
                <span className="mx-1 text-border-strong">/</span>
                <span className="text-text-secondary">{formatFieldValue(field)}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      {structure.length > 0 && (
        <OverviewSection
          title="矩阵编排"
          icon={ListTree}
          source={
            <Badge variant="secondary" className="h-5 px-1.5 text-nano font-medium">
              可编辑
            </Badge>
          }
        >
          <p className="mb-2.5 text-micro leading-relaxed text-muted-foreground">
            与时间线矩阵共用的数据字段，在编辑模式统一维护。
          </p>
          <FieldList fields={structure} />
        </OverviewSection>
      )}

      {relations.length > 0 && (
        <OverviewSection title="关联" icon={Network}>
          <FieldList fields={relations} />
        </OverviewSection>
      )}

      {details.length > 0 && (
        <OverviewSection title="详细资料" icon={FileText}>
          <FieldList fields={details} />
        </OverviewSection>
      )}

      {entityType !== 'project' && entityType !== 'volume' && (
        <OverviewSection
          title="账本实录"
          icon={History}
          source={
            <Badge variant="outline" className="h-5 px-1.5 text-nano font-medium">
              <Database className="mr-1 size-2.5" />
              只读投影
            </Badge>
          }
        >
          <p className="mb-3 text-micro leading-relaxed text-muted-foreground">
            由事件账本与 AI 实录投影而来，不能在此直接编辑。
          </p>
          <LedgerList timeline={timeline} loading={timelineLoading} />
        </OverviewSection>
      )}
    </div>
  )
}
