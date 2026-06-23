import type { ReactElement } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import {
  Pencil,
  Trash2,
  SettingsIcon
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
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
import { cn } from '@/lib/utils'

/** 会话元数据 */
export interface SessionSummary {
  id: string
  title: string
  preview: string
  createdAt: number
  updatedAt: number
}

export interface SessionListProps {
  sessions: SessionSummary[]
  activeSessionId: string
  onSelectSession: (id: string) => void
  onNewSession: () => void
  onRenameSession: (id: string, newTitle: string) => void
  onDeleteSession: (id: string) => void
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
const SESSION_ITEM_HEIGHT = 36
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
  onDeleteSession,
  onOpenSettings
}: SessionListProps): ReactElement {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions]
  )

  const grouped = useMemo(() => groupSessions(sortedSessions), [sortedSessions])

  // 展平为虚拟化列表
  const virtualItems = useMemo(() => flattenGroupedSessions(grouped), [grouped])

  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      virtualItems[index].type === 'header' ? HEADER_HEIGHT : SESSION_ITEM_HEIGHT,
    overscan: 8
  })

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
      className="bg-surface-1 border-r border-border flex flex-col min-w-0 overflow-hidden px-4 py-5"
      aria-label="会话"
    >
      {/* 新建会话按钮 */}
      <Button
        className="w-full justify-center rounded-md h-9 text-sm font-medium bg-primary hover:bg-primary/95 text-primary-foreground shadow-sm"
        onClick={onNewSession}
        aria-label="新建会话"
      >
        开启新对话
      </Button>

      {/* 会话列表 */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto mt-3">
        {virtualItems.length === 0 ? null : virtualizer.getVirtualItems().length === 0 ? (
          // 降级渲染（jsdom 或容器高度为 0 时）
          grouped.map((group) => (
            <div key={group.label} className="grid gap-0.5 mb-3">
              <p className="text-xs font-medium text-subtle m-0 px-2.5 mb-1">
                {group.label}
              </p>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isActive={session.id === activeSessionId}
                  onSelect={() => onSelectSession(session.id)}
                  onRename={() => handleContextMenuRename(session)}
                  onDelete={() => setDeletingId(session.id)}
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
                      onSelect={() => onSelectSession(item.session.id)}
                      onRename={() => handleContextMenuRename(item.session)}
                      onDelete={() => setDeletingId(item.session.id)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 底部设置按钮 */}
      <div className="mt-auto pt-3">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-2.5 w-full h-9 rounded-md px-2.5 text-sm text-text-secondary hover:bg-surface-3 cursor-pointer transition-colors"
          aria-label="打开设置"
        >
          <SettingsIcon className="size-4 text-subtle shrink-0" />
          <span>设置</span>
        </button>
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
  onSelect,
  onRename,
  onDelete
}: {
  session: SessionSummary
  isActive: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}): ReactElement {
  return (
    <DropdownMenu.Root>
      <div
        className={cn(
          'group relative flex items-center gap-2.5 h-9 rounded-md px-2.5 text-left transition-colors cursor-pointer',
          isActive
            ? 'bg-[#EEF0FF] dark:bg-purple-950/20'
            : 'hover:bg-surface-3 dark:hover:bg-surface-2'
        )}
        onClick={onSelect}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
      >
        {/* 左侧指示器：统一圆点，选中为紫色，未选中为灰色 */}
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            isActive ? 'bg-primary' : 'bg-hint'
          )}
          aria-hidden="true"
        />

        {/* 标题 */}
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <span className={cn('block text-sm truncate', isActive ? 'font-medium text-text' : 'text-text-secondary')}>
            {session.title}
          </span>
        </div>

        {/* hover 时显示的操作按钮 */}
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="size-5 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-surface-2 transition-opacity text-subtle"
            aria-label="会话操作"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-xs leading-none">...</span>
          </button>
        </DropdownMenu.Trigger>
      </div>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
          side="right"
          align="start"
          sideOffset={4}
        >
          <DropdownMenu.Item
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
            onSelect={onRename}
          >
            <Pencil className="size-3.5" />
            重命名
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none hover:bg-destructive/10 hover:text-destructive data-disabled:pointer-events-none data-disabled:opacity-50"
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
