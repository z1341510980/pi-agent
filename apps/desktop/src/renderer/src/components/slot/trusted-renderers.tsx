import type { ReactElement } from 'react'
import { BookOpen } from 'lucide-react'
import { NovelWorkspace } from '../novel/novel-workspace'
import { Button } from '../ui/button'
import { InfiniteCanvasNavigationContribution, InfiniteCanvasWorkspace } from '../infinite-canvas/infinite-canvas-workspace'

/**
 * 受信任 renderer：桌面构建产物中的静态组件。
 *
 * 只有宿主能把它们加进 slot-context 的白名单；服务端只能引用 rendererKey，
 * 不能下发可执行代码（动态 bundle 属 P3）。
 */

/** P2 示例：导航栏 / 插件页顶部使用的小卡片。 */
export function HelloPanelContribution(props: Record<string, unknown>): ReactElement {
  const initialGreetCount =
    typeof props.initialGreetCount === 'number' ? props.initialGreetCount : 0
  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-700">
      Hello 插件已启用（累计问候：{initialGreetCount}）
    </div>
  )
}

/** P2 示例：占据整个主工作区的插件页面。 */
export function HelloWorkspaceContribution(props: Record<string, unknown>): ReactElement {
  const title = typeof props.title === 'string' ? props.title : 'Hello 插件工作区'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-subtle">
      <h2 className="text-lg text-text">{title}</h2>
      <p className="text-sm">这是由插件贡献到 workspace.main 的示例页面。</p>
    </div>
  )
}

/** P2 示例：右栏 tab 内容。 */
export function HelloRightPanelContribution(props: Record<string, unknown>): ReactElement {
  const note = typeof props.note === 'string' ? props.note : '插件可以在右栏提供自己的检查视图。'
  return <div className="p-3 text-sm text-subtle">{note}</div>
}

/** Builtin novel workspace contribution. The host injects the navigation callback. */
export function NovelWorkspaceContribution(props: Record<string, unknown>): ReactElement {
  const onClose = typeof props.onClose === 'function' ? props.onClose as () => void : () => undefined
  return <NovelWorkspace onClose={onClose} />
}

/** Builtin novel navigation contribution. */
export function NovelNavigationContribution(props: Record<string, unknown>): ReactElement {
  const onNavigate = typeof props.onNavigate === 'function'
    ? props.onNavigate as (view: string) => void
    : undefined
  const currentView = typeof props.currentView === 'string' ? props.currentView : ''
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`relative size-9 ${currentView === 'plugin:novel' ? 'text-text' : 'text-subtle hover:text-text hover:bg-accent'}`}
      aria-label="小说创作"
      aria-current={currentView === 'plugin:novel' ? 'page' : undefined}
      title="小说创作"
      onClick={() => onNavigate?.('plugin:novel')}
    >
      <BookOpen className="size-4" />
    </Button>
  )
}

export function InfiniteCanvasWorkspaceContribution(props: Record<string, unknown>): ReactElement {
  const onClose = typeof props.onClose === 'function' ? props.onClose as () => void : undefined
  return <InfiniteCanvasWorkspace onClose={onClose} />
}

export { InfiniteCanvasNavigationContribution }
