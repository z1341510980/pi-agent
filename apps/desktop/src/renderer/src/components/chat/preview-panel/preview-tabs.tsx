import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PreviewTab } from './preview-panel'

interface PreviewTabsProps {
  tabs: PreviewTab[]
  activeId: string
  onActivate: (id: string) => void
  onClose?: (id: string) => void
}

export function PreviewTabs({ tabs, activeId, onActivate, onClose }: PreviewTabsProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-surface-1 px-2 py-1 overflow-x-auto">
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={cn(
            'group flex items-center gap-1 rounded-md px-2 py-1 text-xs cursor-pointer',
            tab.id === activeId ? 'bg-surface-3 text-foreground' : 'text-muted-foreground hover:bg-surface-2'
          )}
          onClick={() => onActivate(tab.id)}
        >
          <span className="truncate max-w-[120px]">{tab.title}</span>
          {tab.closable !== false && onClose && (
            <button
              className="opacity-0 group-hover:opacity-100 hover:text-destructive"
              onClick={e => { e.stopPropagation(); onClose(tab.id) }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
