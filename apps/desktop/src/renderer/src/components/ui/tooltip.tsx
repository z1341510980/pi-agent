import * as React from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/**
 * Tooltip —— 悬浮提示
 *
 * 此前全靠原生 `title` 属性：延迟固定不可控、触屏与键盘焦点都不触发、
 * 无法放富文本、贴边不翻转。原生 title 仍适合"补充说明"的场合，
 * 这个 primitive 用于需要控制时机或需要结构化内容的地方。
 *
 * `TooltipProvider` 需要包在使用处的上层（或应用根），用于共享延迟计时器 ——
 * 这样连续 hover 多个目标时不会每个都重新等一遍延迟。
 */

function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // dsh Tooltip：深色底板（两主题一致偏暗）、r8、13/20、无箭头
        className={cn(
          'z-50 w-fit max-w-[50vw] origin-(--radix-tooltip-content-transform-origin) rounded-lg bg-tooltip px-[7px] py-[3px] text-[13px] leading-5 text-tooltip-foreground break-words',
          'data-open:animate-in data-open:fade-in-0 duration-150 data-closed:animate-out data-closed:fade-out-0',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
