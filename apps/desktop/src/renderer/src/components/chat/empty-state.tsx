import { MessageSquare, Sparkles } from 'lucide-react'

/**
 * EmptyState：空状态
 *
 * 无消息时显示引导语和示例问题
 */
export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Sparkles className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-medium">开始与 PI Agent 对话</h3>
        <p className="text-sm text-muted-foreground">
          输入消息或选择下方示例开始
        </p>
      </div>
      <div className="grid gap-2 text-left">
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          <MessageSquare className="h-3.5 w-3.5" />
          帮我列出当前目录的文件
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          <MessageSquare className="h-3.5 w-3.5" />
          解释这段代码的作用
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          <MessageSquare className="h-3.5 w-3.5" />
          帮我重构这个函数
        </div>
      </div>
    </div>
  )
}
