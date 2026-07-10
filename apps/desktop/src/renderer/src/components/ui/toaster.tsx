import { useEffect, type ReactElement } from 'react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast, dismissToast, type Toast as ToastData } from '@/hooks/use-toast'

/**
 * Toaster：全局 Toast 渲染器
 *
 * 基于 Radix UI Toast 原语，挂载在 App 根节点。
 * 通过 useToast() 订阅全局 toast 队列，自动渲染与 dismiss。
 *
 * 用法：
 *   import { toastError } from '@/hooks/use-toast'
 *   toastError('保存失败', '网络错误')
 */
export function Toaster(): ReactElement {
  const { toasts } = useToast()

  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
      <ToastPrimitive.Viewport
        className="pointer-events-none fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-[400px]"
      />
    </ToastPrimitive.Provider>
  )
}

function ToastItem({ toast }: { toast: ToastData }): ReactElement {
  const duration = toast.duration ?? 5000

  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), duration)
    return () => clearTimeout(timer)
  }, [toast.id, duration])

  return (
    <ToastPrimitive.Root
      duration={duration}
      onOpenChange={(open) => {
        if (!open) dismissToast(toast.id)
      }}
      className={cn(
        'pointer-events-auto group relative flex w-full items-start gap-3 overflow-hidden rounded-lg border p-4 shadow-lg',
        'transition-all data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:slide-in-from-bottom-full data-[state=closed]:fade-out-80',
        'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]',
        'data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]',
        toast.variant === 'destructive'
          ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100'
          : toast.variant === 'success'
            ? 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100'
            : 'border-border bg-surface-1 text-text',
      )}
    >
      <div className="flex-1 space-y-1">
        {toast.title && (
          <ToastPrimitive.Title className="text-sm font-semibold">
            {toast.title}
          </ToastPrimitive.Title>
        )}
        {toast.description && (
          <ToastPrimitive.Description className="text-sm opacity-90">
            {toast.description}
          </ToastPrimitive.Description>
        )}
      </div>
      <ToastPrimitive.Close className="shrink-0 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
        <X className="size-3.5" aria-hidden="true" />
        <span className="sr-only">关闭</span>
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  )
}
