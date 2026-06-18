import { Loader2 } from 'lucide-react'

/**
 * StreamingIndicator：流式占位指示器
 *
 * 流式输出时显示在消息列表底部，三点动画 + "正在生成"
 */
export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>正在生成...</span>
    </div>
  )
}
