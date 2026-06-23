import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface ThinkingBlockProps {
  content: string
  isStreaming: boolean
}

/**
 * ThinkingBlock：思考状态卡片（可折叠）
 *
 * 显示 REASONING_/THINKING_ 事件的内容
 * 流式时默认展开，完成后默认折叠
 * 白色卡片 + 紫色圆点，符合 Craft 设计稿
 */
export function ThinkingBlock({ content, isStreaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming)

  // 标题根据流式状态切换
  const title = isStreaming ? '正在分析你的需求' : '分析完成'
  // 描述优先展示内容首行，无内容时显示默认提示
  const description = content.trim().split('\n')[0] || (isStreaming ? '正在整理推理步骤…' : '已生成思考过程')

  return (
    <div className={cn(
      'rounded-lg border border-border bg-background',
      'dark:bg-surface-1',
    )}>
      <motion.button
        type="button"
        onClick={() => setExpanded(!expanded)}
        whileTap={{ scale: 0.98 }}
        transition={{ duration: 0.1 }}
        className={cn(
          'flex w-full items-start gap-3 px-3.5 py-2.5 text-left',
          'hover:bg-muted/50 dark:hover:bg-surface-2/50',
        )}
      >
        {/* 紫色状态圆点 */}
        <span className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full bg-purple-500',
          isStreaming && 'animate-pulse',
        )} />

        {/* 标题与描述 */}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">
            {title}
          </div>
          <div className={cn(
            'mt-0.5 text-[11px] text-muted-foreground',
            'line-clamp-1',
          )}>
            {expanded ? '点击折叠详情' : description}
          </div>
        </div>

        <ChevronDown
          className={cn(
            'mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </motion.button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="thinking-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-border/60"
          >
            <div className="px-3.5 py-2.5">
              <pre className="whitespace-pre-wrap text-xs text-foreground/90">
                {content}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
