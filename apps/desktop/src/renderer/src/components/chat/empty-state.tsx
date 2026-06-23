import type { ReactElement } from 'react'
import { MessageSquareIcon, SparklesIcon } from 'lucide-react'

// ── 类型定义 ──

interface EmptyStateProps {
  /** 点击示例问题回调 */
  onExampleClick?: (text: string) => void
}

// ── 常量 ──

const examples = [
  '帮我列出当前目录的文件',
  '解释这段代码的作用',
  '帮我重构这个函数',
  '写一个快速排序的实现',
]

// ── 主组件 ──

/**
 * EmptyState：空状态
 *
 * 无消息时显示引导语和示例问题
 */
export function EmptyState({ onExampleClick }: EmptyStateProps): ReactElement {
  return (
    <div
      className="flex flex-col items-center justify-center gap-5 py-16 text-center"
      role="region"
      aria-label="空状态引导"
    >
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10"
        aria-hidden="true"
      >
        <SparklesIcon className="h-7 w-7 text-accent" />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-base font-[780]">开始与 PI Agent 对话</h3>
        <p className="text-sm text-muted-foreground m-0">
          输入消息或选择下方示例开始
        </p>
      </div>
      <div className="grid gap-2 text-left w-full max-w-[400px]" role="list">
        {examples.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onExampleClick?.(text)}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-xs text-text hover:bg-surface-3 hover:border-accent/40 transition-colors text-left group"
            role="listitem"
          >
            <MessageSquareIcon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-accent shrink-0" />
            <span className="flex-1">{text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
