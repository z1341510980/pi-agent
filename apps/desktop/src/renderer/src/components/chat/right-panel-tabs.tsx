/**
 * 右栏 tab 容器。
 *
 * 宿主的「上下文」永远是第一个 tab 且不可移除；插件贡献到 `right-panel.tab`
 * 的条目作为可移除项插入。插件被禁用后其 tab 会从 registry 消失，如果它正被
 * 选中，这里自动回落到宿主 tab —— 不能留下一个指向已撤销贡献的空白面板。
 */
import { useEffect, type ReactElement, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { useOptionalSlotRegistry } from '../../core/slot-context-value'
import { SlotRenderer } from '../slot'

interface RightPanelTabsProps {
  /** null = 宿主上下文面板 */
  activeTab: string | null
  onSelectTab: (tab: string | null) => void
  /** 宿主上下文面板内容 */
  context: ReactNode
  threadId: string
}

function labelOf(label: string | (() => string) | undefined, fallback: string): string {
  if (typeof label === 'function') {
    try {
      return label()
    } catch {
      return fallback
    }
  }
  return label ?? fallback
}

export function RightPanelTabs({
  activeTab,
  onSelectTab,
  context,
  threadId
}: RightPanelTabsProps): ReactElement {
  const registry = useOptionalSlotRegistry()
  useSyncExternalStore(
    (listener) => registry?.subscribe('right-panel.tab', listener) ?? (() => {}),
    () => registry?.version('right-panel.tab') ?? 0,
    () => registry?.version('right-panel.tab') ?? 0
  )
  const entries = registry?.entriesOfSlot('right-panel.tab') ?? []
  const activeExists =
    activeTab === null || entries.some((entry) => entry.options.id === activeTab)

  // 选中的插件 tab 消失（插件被禁用 / generation 换代）时回落到宿主 tab
  useEffect(() => {
    if (!activeExists) onSelectTab(null)
  }, [activeExists, onSelectTab])

  const effectiveTab = activeExists ? activeTab : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {entries.length > 0 && (
        <div
          role="tablist"
          aria-label="右侧栏标签"
          className="flex shrink-0 items-center gap-1 border-b border-[var(--dsw-alias-border-l1)] px-2 py-1"
        >
          <TabButton
            active={effectiveTab === null}
            label="上下文"
            onClick={() => onSelectTab(null)}
          />
          {entries.map((entry) => (
            <TabButton
              key={entry.id}
              active={effectiveTab === entry.options.id}
              label={labelOf(entry.options.label, entry.options.id ?? entry.id)}
              onClick={() => onSelectTab(entry.options.id ?? null)}
            />
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {effectiveTab === null ? (
          context
        ) : (
          <SlotRenderer
            name="right-panel.tab"
            entryId={effectiveTab}
            fallback={null}
            extraProps={{ threadId, activeTabId: effectiveTab }}
          />
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  label,
  onClick
}: {
  active: boolean
  label: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded px-2 py-1 text-xs transition-colors',
        active ? 'bg-surface-3 text-text' : 'text-subtle hover:bg-surface-2 hover:text-text'
      )}
    >
      {label}
    </button>
  )
}
