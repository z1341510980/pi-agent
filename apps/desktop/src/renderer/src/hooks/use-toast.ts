// Based on shadcn/ui use-toast implementation
// 使用 React useSyncExternalStore 管理全局 toast 队列，
// 避免在矩阵等高频交互组件中引入 Context Provider 改动现有组件树结构。

import { useSyncExternalStore } from 'react'

export type ToastVariant = 'default' | 'destructive' | 'success' | 'info' | 'warning'

export interface Toast {
  id: string
  title?: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

type ToastInput = Omit<Toast, 'id'> & { id?: string }

// ── 各类型的默认时长（ms）──
// success/info: 3s，warning: 4s，error/destructive: 5s，default: 4s
const VARIANT_DURATION: Record<ToastVariant, number> = {
  default: 4000,
  success: 3000,
  info: 3000,
  warning: 4000,
  destructive: 5000,
}

// ── 全局 store（vanilla，不依赖 React Context）──

const listeners = new Set<() => void>()
let toasts: Toast[] = []
let memoryState: { toasts: Toast[] } = { toasts: [] }
/** 堆叠上限：最多 3 条，超出移除最早的 */
const TOAST_LIMIT = 3
const TOAST_REMOVE_DELAY = 5000 // 5s 后从内存移除（比 duration 长，留 dismiss 动画时间）

const timeouts = new Map<string, ReturnType<typeof setTimeout>>()

function emitChange() {
  memoryState = { toasts }
  listeners.forEach((l) => l())
}

function addToRemoveTimeout(id: string) {
  if (timeouts.has(id)) return
  const timer = setTimeout(() => {
    timeouts.delete(id)
    toasts = toasts.filter((t) => t.id !== id)
    emitChange()
  }, TOAST_REMOVE_DELAY)
  timeouts.set(id, timer)
}

/**
 * 底层 toast 入口：接受完整 ToastInput。
 * 返回 { id, dismiss } 便于调用方手动关闭。
 */
function pushToast(input: ToastInput) {
  const id = input.id ?? Math.random().toString(36).slice(2)
  const variant = input.variant ?? 'default'
  const newToast: Toast = {
    id,
    duration: VARIANT_DURATION[variant],
    variant,
    ...input,
  }
  // 堆叠：保留最新 3 条，移除最早的
  toasts = [newToast, ...toasts].slice(0, TOAST_LIMIT)
  emitChange()
  addToRemoveTimeout(id)
  return {
    id,
    dismiss: () => dismissToast(id),
  }
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id)
  // 清理对应的移除 timer（手动 dismiss 后不需要再延迟移除）
  const timer = timeouts.get(id)
  if (timer) {
    clearTimeout(timer)
    timeouts.delete(id)
  }
  emitChange()
}

// ── 顶层便捷函数（保持向后兼容）──

export function toastError(title: string, description?: string) {
  return pushToast({ title, description, variant: 'destructive' })
}

export function toastSuccess(title: string, description?: string) {
  return pushToast({ title, description, variant: 'success' })
}

export function toastInfo(title: string, description?: string) {
  return pushToast({ title, description, variant: 'info' })
}

export function toastWarning(title: string, description?: string) {
  return pushToast({ title, description, variant: 'warning' })
}

// ── 链式 API：toast({...}) / toast.success(...) / toast.error(...) / toast.info(...) / toast.warning(...) ──
// 既是函数（保留对 `import { toast } from '@/hooks/use-toast'` + `toast({...})` 的兼容），
// 又挂载 success/error/info/warning 便捷方法。
type ToastFn = {
  (input: ToastInput): ReturnType<typeof pushToast>
  success: (title: string, description?: string) => ReturnType<typeof pushToast>
  error: (title: string, description?: string) => ReturnType<typeof pushToast>
  info: (title: string, description?: string) => ReturnType<typeof pushToast>
  warning: (title: string, description?: string) => ReturnType<typeof pushToast>
}

export const toast: ToastFn = Object.assign(
  (input: ToastInput) => pushToast(input),
  {
    success: (title: string, description?: string) => toastSuccess(title, description),
    error: (title: string, description?: string) => toastError(title, description),
    info: (title: string, description?: string) => toastInfo(title, description),
    warning: (title: string, description?: string) => toastWarning(title, description),
  },
) as ToastFn

// ── React 绑定 ──

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return memoryState
}

export function useToast() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
