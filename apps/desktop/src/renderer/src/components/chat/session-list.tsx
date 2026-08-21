import type { ReactElement } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Pencil, Pin, PinOff, Trash2, GripVertical, MoreHorizontal, Plus } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { usePinnedSessions } from '@/hooks/use-pinned-sessions'
import { BUILTIN_PRESETS } from '@/config/preset-assistants'
import { AgentLogoIcon } from './agent-logo-icon'
import { useSessionStore } from '@/stores/session-store'
import { cn } from '@/lib/utils'

/** 会话元数据 */
export interface SessionSummary {
  id: string
  title: string
  preview: string
  createdAt: number
  updatedAt: number
  /** 会话关联的 Agent ID（用于显示 agent 身份标识） */
  agentId?: string
}

export interface SessionListProps {
  sessions: SessionSummary[]
  activeSessionId: string
  onSelectSession: (id: string) => void
  onNewSession: () => void
  onRenameSession: (id: string, newTitle: string) => void
  onDeleteSession: (id: string) => void
  /** 打开设置页（footer 入口） */
  onOpenSettings?: () => void
}

/** 按更新时间分组会话 */
function groupSessions(
  sessions: SessionSummary[]
): { label: string; sessions: SessionSummary[] }[] {
  const now = Date.now()
  const weekStart = now - 7 * 86_400_000

  const groups: { label: string; sessions: SessionSummary[] }[] = [
    { label: '最近对话', sessions: [] },
    { label: '更早', sessions: [] }
  ]

  for (const session of sessions) {
    if (session.updatedAt >= weekStart) {
      groups[0].sessions.push(session)
    } else {
      groups[1].sessions.push(session)
    }
  }

  return groups.filter((g) => g.sessions.length > 0)
}

// ── 虚拟化列表项类型 ──

type VirtualItem = { type: 'header'; label: string } | { type: 'session'; session: SessionSummary }

// 会话项固定高度（px）
const SESSION_ITEM_HEIGHT = 34
// 分组标题高度（px）
const HEADER_HEIGHT = 28

/** 将分组会话展平为虚拟化列表项数组 */
function flattenGroupedSessions(
  groups: { label: string; sessions: SessionSummary[] }[]
): VirtualItem[] {
  const items: VirtualItem[] = []
  for (const group of groups) {
    items.push({ type: 'header', label: group.label })
    for (const session of group.sessions) {
      items.push({ type: 'session', session })
    }
  }
  return items
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession
}: SessionListProps): ReactElement {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // 正在拖拽的会话 ID（用于 DragOverlay 渲染预览）
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  // 当前活跃 Agent ID（用于会话项回退显示 agent 标识）
  const activeAgentId = useSessionStore((s) => s.activeAgentId)

  const scrollRef = useRef<HTMLDivElement>(null)

  // ── 置顶会话管理（localStorage 持久化） ──
  const { pinnedOrder, togglePin, reorderPinned } = usePinnedSessions()

  // 按 pinnedOrder 顺序解析出实际存在的置顶会话
  const sessionsById = useMemo(() => {
    const map = new Map<string, SessionSummary>()
    for (const s of sessions) map.set(s.id, s)
    return map
  }, [sessions])

  const pinnedSessions = useMemo(() => {
    const result: SessionSummary[] = []
    for (const id of pinnedOrder) {
      const s = sessionsById.get(id)
      if (s) result.push(s)
    }
    return result
  }, [pinnedOrder, sessionsById])

  // 未置顶会话：按 updatedAt 降序
  const unpinnedSortedSessions = useMemo(() => {
    const pinnedSet = new Set(pinnedOrder)
    return sessions.filter((s) => !pinnedSet.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, pinnedOrder])

  const grouped = useMemo(() => groupSessions(unpinnedSortedSessions), [unpinnedSortedSessions])

  // 展平为虚拟化列表（仅未置顶会话）
  const virtualItems = useMemo(() => flattenGroupedSessions(grouped), [grouped])

  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      virtualItems[index].type === 'header' ? HEADER_HEIGHT : SESSION_ITEM_HEIGHT,
    overscan: 8
  })

  // ── 拖拽传感器：distance:6 区分点击与拖拽 ──
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveDragId(null)
      if (!over) return
      const activeId = String(active.id)
      const overId = String(over.id)
      if (activeId === overId) return
      reorderPinned(activeId, overId)
    },
    [reorderPinned]
  )

  // DragOverlay 预览数据
  const activeDragSession = activeDragId ? (sessionsById.get(activeDragId) ?? null) : null

  const handleContextMenuRename = useCallback((session: SessionSummary) => {
    setRenamingId(session.id)
    setRenameValue(session.title)
  }, [])

  const handleRenameConfirm = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      onRenameSession(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue, onRenameSession])

  const handleDeleteConfirm = useCallback(() => {
    if (deletingId) {
      onDeleteSession(deletingId)
    }
    setDeletingId(null)
  }, [deletingId, onDeleteSession])

  return (
    <nav
      className="pi-nav-panel flex flex-col min-w-0 overflow-hidden px-4 py-5 h-full"
      aria-label="会话"
      data-tour="session-list"
    >
      {/* 新建会话按钮（dsh New Session：38px 白底胶囊条 + 发丝线） */}
      <button
        type="button"
        onClick={onNewSession}
        aria-label="新建会话"
        className="flex w-full items-center justify-center gap-1.5 h-[38px] px-4 rounded-xl border border-border bg-[var(--dsw-alias-button-elevated-fill)] text-text text-sm leading-[22px] font-medium transition-colors hover:bg-[var(--dsw-alias-button-floating-hover)] active:scale-[0.99]"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        <span>新对话</span>
      </button>

      {/* 分隔线 */}
      <div className="h-px bg-[var(--dsw-alias-border-l1)] mx-1 my-2" aria-hidden="true" />

      {/* 置顶会话分组（独立区域，不参与虚拟化，可拖拽排序） */}
      {pinnedSessions.length > 0 && (
        <div className="shrink-0 mt-3">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveDragId(null)}
          >
            <p className="text-xs font-medium text-subtle m-0 px-2.5 mb-1">置顶</p>
            <SortableContext
              items={pinnedSessions.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              {pinnedSessions.map((session) => (
                <SortableSessionItem
                  key={session.id}
                  session={session}
                  isActive={session.id === activeSessionId}
                  activeAgentId={activeAgentId}
                  onSelect={() => onSelectSession(session.id)}
                  onRename={() => handleContextMenuRename(session)}
                  onDelete={() => setDeletingId(session.id)}
                  onTogglePin={() => togglePin(session.id)}
                />
              ))}
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {activeDragSession ? (
                <div className="opacity-70 rounded-md shadow-lg ring-1 ring-primary/20 bg-surface-2">
                  <SessionItem
                    session={activeDragSession}
                    isActive={activeDragSession.id === activeSessionId}
                    isPinned
                    activeAgentId={activeAgentId}
                    onSelect={() => onSelectSession(activeDragSession.id)}
                    onRename={() => handleContextMenuRename(activeDragSession)}
                    onDelete={() => setDeletingId(activeDragSession.id)}
                    onTogglePin={() => togglePin(activeDragSession.id)}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {/* 未置顶会话列表（虚拟化） */}
      <div ref={scrollRef} className="sidebar-scroll flex-1 min-h-0 overflow-auto mt-3">
        {virtualItems.length === 0 ? null : virtualizer.getVirtualItems().length === 0 ? (
          // 降级渲染（jsdom 或容器高度为 0 时）
          grouped.map((group) => (
            <div key={group.label} className="grid gap-0.5 mb-3">
              <p className="text-xs font-medium text-subtle m-0 px-2.5 mb-1">{group.label}</p>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isActive={session.id === activeSessionId}
                  isPinned={false}
                  activeAgentId={activeAgentId}
                  onSelect={() => onSelectSession(session.id)}
                  onRename={() => handleContextMenuRename(session)}
                  onDelete={() => setDeletingId(session.id)}
                  onTogglePin={() => togglePin(session.id)}
                />
              ))}
            </div>
          ))
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = virtualItems[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {item.type === 'header' ? (
                    <p
                      className="text-xs font-medium text-subtle m-0 px-2.5"
                      style={{ height: HEADER_HEIGHT, lineHeight: `${HEADER_HEIGHT}px` }}
                    >
                      {item.label}
                    </p>
                  ) : (
                    <SessionItem
                      session={item.session}
                      isActive={item.session.id === activeSessionId}
                      isPinned={false}
                      activeAgentId={activeAgentId}
                      onSelect={() => onSelectSession(item.session.id)}
                      onRename={() => handleContextMenuRename(item.session)}
                      onDelete={() => setDeletingId(item.session.id)}
                      onTogglePin={() => togglePin(item.session.id)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 重命名对话框 */}
      <Dialog
        open={renamingId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingId(null)
            setRenameValue('')
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>输入新的会话标题</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameConfirm()
            }}
            placeholder="会话标题"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRenamingId(null)
                setRenameValue('')
              }}
            >
              取消
            </Button>
            <Button size="sm" onClick={handleRenameConfirm} disabled={!renameValue.trim()}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <Dialog
        open={deletingId !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingId(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>确定要删除这个会话吗？此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeletingId(null)}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteConfirm}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </nav>
  )
}

/** 单个会话项（单击切换，hover 显示操作按钮） */
function SessionItem({
  session,
  isActive,
  isPinned = false,
  draggable = false,
  activeAgentId,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  dragHandleRef,
  dragListeners
}: {
  session: SessionSummary
  isActive: boolean
  isPinned?: boolean
  /** 是否启用拖拽（置顶项启用） */
  draggable?: boolean
  /** 当前活跃 Agent ID（用于会话项无 agentId 时回退显示） */
  activeAgentId?: string
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
  onTogglePin?: () => void
  /** 拖拽手柄 ref（由 useSortable 提供） */
  dragHandleRef?: React.Ref<HTMLButtonElement>
  /** 拖拽监听器（由 useSortable 提供） */
  dragListeners?: React.HTMLAttributes<HTMLElement>
}): ReactElement {
  // 会话关联的 agent（优先用会话自身的 agentId，回退到当前活跃 agent）
  const sessionAgentId = session.agentId ?? activeAgentId ?? 'default'
  const builtinPreset = BUILTIN_PRESETS[sessionAgentId]
  const agentIcon = builtinPreset?.icon
  const agentName = builtinPreset?.name ?? sessionAgentId

  return (
    <DropdownMenu.Root>
      <div
        className={cn(
          'group relative flex items-center gap-2.5 h-9 rounded-lg px-2.5 text-left transition-[background-color,color] cursor-pointer',
          isActive
            ? 'bg-[var(--color-sidebar-nav-active)]'
            : 'hover:bg-[var(--color-sidebar-nav-hover)]'
        )}
        onClick={onSelect}
        onDoubleClick={onRename}
        title="单击切换 · 双击重命名"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
      >
        {/* 左侧 Agent 身份标识 */}
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-secondary"
          aria-hidden="true"
          title={agentName}
        >
          <AgentLogoIcon
            agentId={sessionAgentId}
            agentName={agentName}
            icon={agentIcon}
            size="sm"
            className="!size-4 !rounded-sm"
          />
        </span>

        {/* 标题 */}
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <span
            className={cn(
              'block text-sm truncate',
              isActive ? 'font-medium text-text' : 'text-text-secondary'
            )}
          >
            {session.title}
          </span>
        </div>

        {/* 置顶标识 */}
        {isPinned && <Pin className="size-3 shrink-0 text-subtle rotate-45" aria-label="已置顶" />}

        {/* 拖拽手柄（仅置顶项显示，hover 时显现） */}
        {draggable && (
          <button
            ref={dragHandleRef}
            type="button"
            className="size-6 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-surface-2 active:scale-[0.96] transition-[opacity,background-color,transform] text-subtle cursor-grab active:cursor-grabbing"
            aria-label="拖拽排序"
            onClick={(e) => e.stopPropagation()}
            tabIndex={-1}
            {...(dragListeners ?? {})}
          >
            <GripVertical className="size-3.5" />
          </button>
        )}

        {/* hover 时显示的操作按钮（AionUi 风格：MoreHorizontal 三点图标） */}
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="size-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-surface-3 dark:hover:bg-surface-2 active:scale-[0.96] transition-[opacity,background-color,transform] text-subtle hover:text-text"
            aria-label="会话操作"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenu.Trigger>
      </div>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 min-w-36 rounded-xl border border-[var(--dsw-alias-border-inverted)] bg-popover p-1 text-popover-foreground shadow-[var(--dsw-shadow-lv3)] animate-in fade-in-0 zoom-in-95"
          side="right"
          align="start"
          sideOffset={4}
        >
          <DropdownMenu.Item
            className="flex min-h-[34px] cursor-default items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-40"
            onSelect={onRename}
          >
            <Pencil className="size-3.5" />
            重命名
          </DropdownMenu.Item>
          {onTogglePin && (
            <DropdownMenu.Item
              className="flex min-h-[34px] cursor-default items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-40"
              onSelect={onTogglePin}
            >
              {isPinned ? (
                <>
                  <PinOff className="size-3.5" />
                  取消置顶
                </>
              ) : (
                <>
                  <Pin className="size-3.5" />
                  置顶
                </>
              )}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-[var(--dsw-alias-border-l1)]" />
          <DropdownMenu.Item
            className="flex min-h-[34px] cursor-default items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-sm outline-none select-none hover:bg-destructive/10 hover:text-destructive data-disabled:pointer-events-none data-disabled:opacity-40"
            onSelect={onDelete}
          >
            <Trash2 className="size-3.5" />
            删除
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** 可拖拽排序的置顶会话项 */
function SortableSessionItem({
  session,
  isActive,
  activeAgentId,
  onSelect,
  onRename,
  onDelete,
  onTogglePin
}: {
  session: SessionSummary
  isActive: boolean
  activeAgentId?: string
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
  onTogglePin: () => void
}): ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: session.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <SessionItem
        session={session}
        isActive={isActive}
        isPinned
        draggable
        activeAgentId={activeAgentId}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
        onTogglePin={onTogglePin}
        dragHandleRef={setActivatorNodeRef}
        dragListeners={listeners}
      />
    </div>
  )
}
