/**
 * NovelReviewCenter：审校中心（右栏 Tab）
 *
 * 聚合五个审校面板的唯一挂载点：剧情轨道 / 待审实体 / 待确认事件 / 批注 / 叙事修订。
 * 此前这批面板分别挂在画布工具栏与矩阵工具栏（两个互斥视图），同类功能被视图切换撕裂；
 * 收敛到右栏后任意布局模式可达，Tab 角标展示全局待办数。
 *
 * 面板本体仍是对话框组件（原样复用）；本组件负责入口列表 + 单点挂载 + 快捷路由
 * （autoOpen：矩阵/画布工具栏的入口点击后跳转到这里并直接打开对应面板）。
 */
import { useEffect, useState, type ReactElement } from 'react'
import {
  ChevronRight,
  ClipboardCheck,
  GitBranch,
  Inbox,
  MessageSquareText,
  PencilLine,
  ShieldQuestion,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { NarrativeTrackPanel } from './narrative-track-panel'
import { EntityCandidatePanel } from './entity-candidate-panel'
import { PendingEventsDialog } from './matrix/pending-events-dialog'
import { AnnotationPanelDialog } from './matrix/annotation-panel-dialog'
import { NarrativeRevisionPanel } from './narrative-revision-panel'
import type { ReviewCounts } from '@/hooks/use-review-counts'

/** 可被外部快捷入口点名的面板 */
export type ReviewPanelKind = 'track' | 'candidate' | 'events' | 'annotations' | 'revision'

export interface NovelReviewCenterProps {
  projectId: string | null
  /** 外部路由请求打开的面板；消费后回调清空 */
  autoOpen: ReviewPanelKind | null
  onAutoOpenConsumed: () => void
  counts: ReviewCounts
}

export function NovelReviewCenter({
  projectId,
  autoOpen,
  onAutoOpenConsumed,
  counts,
}: NovelReviewCenterProps): ReactElement {
  const [trackOpen, setTrackOpen] = useState(false)
  const [candidateOpen, setCandidateOpen] = useState(false)
  const [eventsOpen, setEventsOpen] = useState(false)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [revisionOpen, setRevisionOpen] = useState(false)

  // 快捷路由：矩阵/画布工具栏点名某面板时直接打开，然后清空请求避免重渲染复开
  useEffect(() => {
    if (autoOpen == null) return
    switch (autoOpen) {
      case 'track': setTrackOpen(true); break
      case 'candidate': setCandidateOpen(true); break
      case 'events': setEventsOpen(true); break
      case 'annotations': setAnnotationsOpen(true); break
      case 'revision': setRevisionOpen(true); break
    }
    onAutoOpenConsumed()
  }, [autoOpen, onAutoOpenConsumed])

  const entries: Array<{
    kind: ReviewPanelKind
    icon: typeof GitBranch
    name: string
    description: string
    badge?: number
    open: () => void
  }> = [
    {
      kind: 'events',
      icon: Inbox,
      name: '待确认事件',
      description: 'AI 自动提取的故事事件，确认后进入语义账本',
      badge: counts.pendingEventCount,
      open: () => setEventsOpen(true),
    },
    {
      kind: 'candidate',
      icon: ShieldQuestion,
      name: '待审实体',
      description: 'Memory 提出的新冲突/线索候选，需人工确认',
      badge: counts.candidateCount,
      open: () => setCandidateOpen(true),
    },
    {
      kind: 'track',
      icon: GitBranch,
      name: '剧情轨道',
      description: '查看故事线如何被逐章推进（剧情推进轨道）',
      open: () => setTrackOpen(true),
    },
    {
      kind: 'revision',
      icon: PencilLine,
      name: '叙事修订',
      description: '故事线与场景的修订提交、审批与回滚',
      open: () => setRevisionOpen(true),
    },
    {
      kind: 'annotations',
      icon: MessageSquareText,
      name: '批注',
      description: '统一批注：说明、意图、待办、警告、疑问',
      open: () => setAnnotationsOpen(true),
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <ClipboardCheck className="size-4 text-primary" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text">审校中心</div>
          <div className="text-nano text-subtle">审校类功能的统一入口，任意布局可达</div>
        </div>
        {counts.total > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-semibold leading-4 text-white tabular-nums">
            {counts.total > 99 ? '99+' : counts.total} 待办
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        <ul className="space-y-1.5">
          {entries.map((entry) => {
            const Icon = entry.icon
            return (
              <li key={entry.kind}>
                <button
                  type="button"
                  onClick={entry.open}
                  disabled={!projectId}
                  className={cn(
                    'group flex w-full items-center gap-2.5 rounded-lg border border-border/60 bg-surface-2/40 px-2.5 py-2 text-left',
                    'transition-colors hover:bg-surface-2 hover:border-border disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-text-secondary group-hover:text-text">
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-text">{entry.name}</span>
                      {entry.badge != null && entry.badge > 0 && (
                        <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums">
                          {entry.badge > 99 ? '99+' : entry.badge}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-nano text-subtle">{entry.description}</span>
                  </span>
                  <ChevronRight className="size-3.5 shrink-0 text-hint transition-transform group-hover:translate-x-0.5" />
                </button>
              </li>
            )
          })}
        </ul>
        {!projectId && (
          <p className="px-2 pt-3 text-center text-nano text-hint">请先选择项目</p>
        )}
      </div>

      {/* 五个面板的唯一挂载点（对话框形态原样复用） */}
      <NarrativeTrackPanel open={trackOpen} onOpenChange={setTrackOpen} projectId={projectId} />
      <EntityCandidatePanel open={candidateOpen} onOpenChange={setCandidateOpen} projectId={projectId} />
      <PendingEventsDialog open={eventsOpen} onOpenChange={setEventsOpen} projectId={projectId} />
      <AnnotationPanelDialog open={annotationsOpen} onOpenChange={setAnnotationsOpen} projectId={projectId} />
      <NarrativeRevisionPanel open={revisionOpen} onOpenChange={setRevisionOpen} projectId={projectId} />
    </div>
  )
}
