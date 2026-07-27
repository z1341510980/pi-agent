import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ReactNode } from 'react'

interface TitlebarProps {
  title?: string
  onWorkspaceToggle?: () => void
  workspaceCollapsed?: boolean
  rightExtra?: ReactNode
}

export function Titlebar({ title, onWorkspaceToggle, workspaceCollapsed, rightExtra }: TitlebarProps) {
  return (
    <header className="flex h-10 items-center justify-between border-b border-border bg-titlebar-bg px-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-1">
        {rightExtra}
        {onWorkspaceToggle && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onWorkspaceToggle}>
            {workspaceCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
          </Button>
        )}
      </div>
    </header>
  )
}
