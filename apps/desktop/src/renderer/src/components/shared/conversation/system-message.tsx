import { Button } from '@/components/ui/button'
import type { ConversationMessage } from './types'

export interface SystemMessageProps {
  message: ConversationMessage
  onAction?: (action: string) => void
}

/**
 * SystemMessage：系统消息
 *
 * - 居中灰色小字显示 content
 * - 如有 systemActions，渲染操作按钮列表
 */
export function SystemMessage({ message, onAction }: SystemMessageProps) {
  const actions = message.systemActions ?? []

  return (
    <article className="flex flex-col items-center gap-2 py-1 text-center">
      {message.content ? (
        <p className="max-w-[90%] text-xs leading-relaxed text-hint">
          {message.content}
        </p>
      ) : null}

      {actions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {actions.map((act) => (
            <Button
              key={act.action}
              type="button"
              variant={act.variant}
              size="xs"
              onClick={() => onAction?.(act.action)}
            >
              {act.label}
            </Button>
          ))}
        </div>
      ) : null}
    </article>
  )
}
