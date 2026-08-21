import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { useOptionalSlotRegistry } from '../../core/slot-context-value'
import type { PluginUiRegistry } from '../../ui/plugin-ui-registry'
import type { StoredEntry } from '../../ui/slot-types'

interface SlotRendererProps {
  name: string
  extraProps?: Record<string, unknown>
  fallback?: ReactElement | null
  /**
   * keyed slot 的单元键：只渲染 options.key 命中的 entry。
   *
   * keyed slot 的语义是"一个 key 一个席位"，渲染点通常只关心当前 key
   * （例如 workspace.main 只渲染当前视图、chat.tool.detail 只渲染当前工具）。
   * 不传则渲染全部席位。
   */
  entryKey?: string
  /**
   * list slot 的条目 id：只渲染 options.id 命中的 entry。
   *
   * 用于 tab 型渲染点 —— tab 栏列出全部 entry，内容区只渲染当前选中的那个。
   */
  entryId?: string
  /**
   * chain slot 的宿主对象：交给每个 entry 的 select() 决定它消费什么。
   *
   * chain 不做遮蔽，全部 entry 依次渲染；select 返回 undefined 的 entry 跳过。
   */
  chainOwner?: unknown
}

interface EntryBoundaryProps {
  slot: string
  entry: StoredEntry
  registry: PluginUiRegistry
  children: ReactNode
}

interface EntryBoundaryState {
  error?: Error
}

class EntryBoundary extends Component<EntryBoundaryProps, EntryBoundaryState> {
  state: EntryBoundaryState = {}

  static getDerivedStateFromError(error: Error): EntryBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.registry.reportEntryError(this.props.slot, this.props.entry, error)
  }

  render(): ReactNode {
    if (this.state.error) return null
    return this.props.children
  }
}

export function SlotRenderer({
  name,
  extraProps = {},
  fallback = null,
  entryKey,
  entryId,
  chainOwner
}: SlotRendererProps): ReactElement | null {
  // 没有 SlotProvider 时（局部挂载、单测）宿主 UI 照常工作，只是没有插件贡献。
  const registry = useOptionalSlotRegistry()
  useSyncExternalStore(
    (listener) => registry?.subscribe(name, listener) ?? (() => {}),
    () => registry?.version(name) ?? 0,
    () => registry?.version(name) ?? 0
  )
  if (!registry) return fallback

  const spec = registry.spec(name)
  const entries = registry.entriesOfSlot(name).filter((entry) => {
    if (entryKey !== undefined && entry.options.key !== entryKey) return false
    if (entryId !== undefined && entry.options.id !== entryId) return false
    return true
  })

  if (entries.length === 0) return fallback

  return (
    <>
      {entries.map((entry) => {
        const Component = entry.component
        // chain：由 entry 自己的 select 决定消费内容，返回 undefined 表示不参与本次渲染
        const selected =
          spec?.kind === 'chain' && entry.select ? entry.select(chainOwner) : undefined
        if (spec?.kind === 'chain' && entry.select && selected === undefined) return null
        return (
          <EntryBoundary key={entry.id} slot={name} entry={entry} registry={registry}>
            <Component
              {...(entry.inject?.() ?? {})}
              {...(selected !== undefined ? { selected } : {})}
              {...extraProps}
            />
          </EntryBoundary>
        )
      })}
    </>
  )
}
