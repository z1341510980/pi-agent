import type { ReactElement } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Pencil, Trash2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
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
}

/** 将时间戳格式化为相对时间文本 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 7) return `${days} 天前`

  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 按更新时间分组会话 */
function groupSessions(sessions: SessionSummary[]): { label: string; sessions: SessionSummary[] }[] {
  const now = Date.now()
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const yesterdayStart = todayStart - 86_400_000
  const weekStart = now - 7 * 86_400_000

  const groups: { label: string; sessions: SessionSummary[] }[] = [
    { label: '今天', sessions: [] },
    { label: '昨天', sessions: [] },
    { label: '最近 7 天', sessions: [] },
    { label: '更早', sessions: [] },
  ]

  for (const session of sessions) {
    if (session.updatedAt >= todayStart) {
      groups[0].sessions.push(session)
    } else if (session.updatedAt >= yesterdayStart) {
      groups[1].sessions.push(session)
    } else if (session.updatedAt >= weekStart) {
      groups[2].sessions.push(session)
    } else {
      groups[3].sessions.push(session)
    }
  }

  return groups.filter((g) => g.sessions.length > 0)
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
}: SessionListProps): ReactElement {
  const [search, setSearch] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase()
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!query) return sorted
    return sorted.filter(
      (s) => `${s.title} ${s.preview}`.toLowerCase().includes(query)
    )
  }, [search, sessions])

  const grouped = useMemo(() => groupSessions(filteredSessions), [filteredSessions])

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
      className="bg-surface-1 border-r border-border flex flex-col gap-3.5 min-w-0 overflow-hidden p-3.5"
      aria-label="会话"
    >
      {/* Agent 切换 + 新建会话 */}
      <div className="flex items-center justify-between">
        <button
          className="inline-flex flex-1 items-center gap-2.5 min-h-[42px] min-w-0 px-2 py-1.5 rounded-lg bg-surface-2 border border-border text-text text-left"
          type="button"
          aria-label="切换 Agent"
        >
          <span className="inline-flex items-center justify-center size-7 rounded-[7px] bg-avatar-bg text-avatar-text text-xs font-extrabold shrink-0">
            pi
          </span>
          <span>
            <strong className="block font-[760] leading-tight">pi</strong>
            <small className="text-muted text-xs leading-snug">代码助手</small>
          </span>
        </button>
        <Button
          size="icon"
          className="shrink-0 text-xl font-bold"
          aria-label="新建会话"
          onClick={onNewSession}
        >
          +
        </Button>
      </div>

      {/* 搜索框 */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          placeholder="搜索会话..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 min-h-[38px] bg-input-bg border-border text-text placeholder:text-muted-foreground"
        />
      </div>

      {/* 会话列表 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {grouped.map((group) => (
          <div key={group.label} className="grid gap-2 mb-3">
            <p className="text-subtle text-xs font-[760] m-0">{group.label}</p>
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
        ))}
        {filteredSessions.length === 0 && search && (
          <p className="text-muted text-xs text-center py-4">没有找到匹配的会话</p>
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

/** 单个会话项（含右键菜单） */
function SessionItem({
  session,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionSummary
  isActive: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}): ReactElement {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={cn(
            'bg-transparent border rounded-lg text-text grid gap-1 min-h-[58px] p-2 text-left hover:bg-surface-2 hover:border-border focus-visible:bg-surface-2 focus-visible:border-border',
            isActive ? 'border-border bg-surface-2' : 'border-transparent'
          )}
          type="button"
          onClick={onSelect}
        >
          <span>
            <strong className="block font-[760] leading-tight truncate">
              {session.title}
            </strong>
            <small className="text-muted text-xs leading-snug truncate block">
              {session.preview}
            </small>
          </span>
          <time className="text-subtle text-[11px]">
            {formatRelativeTime(session.updatedAt)}
          </time>
        </button>
      </DropdownMenu.Trigger>
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
