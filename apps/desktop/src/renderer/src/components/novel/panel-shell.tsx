/**
 * PanelShell：右栏面板的统一骨架（P2-4）
 *
 * 右栏各面板此前各自手写「固定区 + 自滚动 body」结构，类名细节互有漂移。
 * 本组件收口该模式：
 *
 *   ┌─ notice  （可选，瞬态提示条，如「创作进行中」）─┐
 *   ├─ header  （可选，固定标题/摘要区）              │
 *   ├─ body    （flex-1 滚动区，children）           │
 *   └─ footer  （可选，固定底栏）                    ┘
 *
 * 纯布局组件，不带任何业务语义。
 */
import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PanelShellProps {
  /** 瞬态提示条（渲染在最顶部，不随内容滚动） */
  notice?: ReactNode
  /** 固定头部（标题、健康摘要等） */
  header?: ReactNode
  /** 滚动内容 */
  children: ReactNode
  /** 固定底栏 */
  footer?: ReactNode
  className?: string
  /** 滚动区的附加类名（内边距等由各面板自定义） */
  bodyClassName?: string
}

export function PanelShell({
  notice,
  header,
  children,
  footer,
  className,
  bodyClassName,
}: PanelShellProps): ReactElement {
  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-surface-1', className)}>
      {notice != null && <div className="shrink-0">{notice}</div>}
      {header != null && <div className="shrink-0">{header}</div>}
      <div className={cn('min-h-0 flex-1 overflow-y-auto', bodyClassName)}>{children}</div>
      {footer != null && <div className="shrink-0">{footer}</div>}
    </div>
  )
}
