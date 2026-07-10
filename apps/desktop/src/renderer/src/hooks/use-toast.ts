// Based on shadcn/ui use-toast implementation
// 使用 React reducer + useSyncExternalStore 管理全局 toast 队列，
// 避免在矩阵等高频交互组件中引入 Context Provider 改动现有组件树结构。

import { useSyncExternalStore } from 'react'

export interface Toast {
  id: string
  title?: string
  description?: string
  variant?: 'default' | 'destructive' | 'success'
  duration?: number
}

type ToastInput = Omit<Toast, 'id'> & { id?: string }

// ── 全局 store（vanilla，不依赖 React Context）──

const listeners = new Set<() => void>()
let toasts: Toast[] = []
let memoryState: { toasts: Toast[] } = { toasts: [] }
const TOAST_LIMIT = 5
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

export function toast(input: ToastInput) {
  const id = input.id ?? Math.random().toString(36).slice(2)
  const newToast: Toast = {
    id,
    duration: 5000,
    variant: 'default',
    ...input,
  }
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

export function toastError(title: string, description?: string) {
  return toast({ title, description, variant: 'destructive', duration: 7000 })
}

export function toastSuccess(title: string, description?: string) {
  return toast({ title, description, variant: 'success', duration: 4000 })
}

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
