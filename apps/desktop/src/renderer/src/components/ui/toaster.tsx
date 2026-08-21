import { useEffect, type ReactElement } from 'react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { AnimatePresence, motion } from 'framer-motion'
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  useToast,
  dismissToast,
  type Toast as ToastData,
  type ToastVariant,
} from '@/hooks/use-toast'

/**
 * Toaster：全局 Toast 渲染器
 *
 * 基于 Radix UI Toast Provider + framer-motion 实现轻量级 toast 通知。
 * 通过 useToast() 订阅全局 toast 队列，自动渲染与 dismiss。
 *
 * 支持 5 种类型：default / success / info / warning / destructive(error)
 * 自动消失时长：success/info 3s，warning 4s，error 5s，default 4s
 * 堆叠显示（最多 3 条，超出移除最早的），固定在右上角、从右侧滑入、向下堆叠。
 *
 * 用法：
 *   import { toast } from '@/hooks/use-toast'
 *   toast.success('已保存', '修改已生效')
 *   toast.error('保存失败', '网络错误')
 *   toast.info('提示', '这是一个信息')
 *   toast.warning('注意', '这是一条警告')
 *   // 或者底层调用：
 *   toast({ title: '标题', variant: 'info' })
 *   // 兼容旧 API：
 *   toastSuccess('已保存') / toastError('失败')
 */
const VARIANT_CONFIG: Record<
  ToastVariant,
  {
    icon: typeof Info
    iconColor: string
  }
> = {
  default: {
    icon: Info,
    iconColor: 'text-[var(--dsw-static-neutral-bluish-300)]',
  },
  success: {
    icon: CheckCircle2,
    iconColor: 'text-[var(--dsw-alias-state-success-secondary)]',
  },
  destructive: {
    icon: AlertCircle,
    iconColor: 'text-[var(--dsw-alias-state-error-secondary)]',
  },
  info: {
    icon: Info,
    iconColor: 'text-[var(--dsw-static-deepseek-300)]',
  },
  warning: {
    icon: AlertTriangle,
    iconColor: 'text-[var(--dsw-alias-state-warn-secondary)]',
  },
}

export function Toaster(): ReactElement {
  const { toasts } = useToast()

  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
      <div
        className="pointer-events-none fixed top-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:max-w-[400px]"
        role="region"
        aria-label="通知"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} />
          ))}
        </AnimatePresence>
      </div>
    </ToastPrimitive.Provider>
  )
}

function ToastItem({ toast }: { toast: ToastData }): ReactElement {
  const variant = toast.variant ?? 'default'
  const config = VARIANT_CONFIG[variant]
  const duration = toast.duration ?? 5000
  const Icon = config.icon

  // 自动消失计时器（与 use-toast 内部的移除 timer 协同）
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), duration)
    return () => clearTimeout(timer)
  }, [toast.id, duration])

  return (
    <motion.div
      layout
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      role="status"
      aria-live="polite"
      className={cn(
        // dsh Toast：contrast 深色底板 + 反色文字，r14、shadow-lv3
        'pointer-events-auto group relative flex w-full items-start gap-3 overflow-hidden rounded-[14px] border border-[var(--dsw-alias-border-inverted)] bg-toast p-3.5 text-toast-foreground shadow-[var(--dsw-shadow-lv3)]',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', config.iconColor)}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">
        {toast.title && (
          <p className="text-sm font-medium leading-[22px]">{toast.title}</p>
        )}
        {toast.description && (
          <p className="text-sm text-[var(--dsw-static-neutral-bluish-300)] text-pretty leading-snug">
            {toast.description}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        className="shrink-0 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
        aria-label="关闭通知"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </motion.div>
  )
}
