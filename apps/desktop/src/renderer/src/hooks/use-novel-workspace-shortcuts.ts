import { useRef } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useNovelWorkspaceLayoutStore } from '@/stores/novel-workspace-layout-store'

/**
 * 小说工作台快捷键
 *
 * Ctrl+B       — 切换左侧栏
 * Ctrl+J       — 切换右侧面板
 * Ctrl+1/2/3/4 — 切换主工作区布局（正文 / 正文+时间线 / 时间线 / 关系图）
 * Ctrl+Shift+F — 切换专注模式
 * Esc          — 退出专注模式（仅在专注模式下）
 *
 * 焦点冲突处理：所有快捷键在输入框聚焦时不触发（除 Esc）。
 * 输入区域包括 Tiptap 编辑器、文本框、搜索框和对话输入框。
 */

function isEditableTarget(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null
  if (!target) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

export interface UseNovelWorkspaceShortcutsOptions {
  /**
   * false 时忽略全部按键。
   *
   * App 外壳对小说工作区做 keep-alive（切页只隐藏不卸载），隐藏挂载时必须
   * 让出按键——尤其 Esc：聊天页按 Esc 中断运行，不能同时触发这里隐藏的
   * 专注模式退出；Ctrl+1~4 也不能悄悄改掉不可见工作区的布局。
   */
  enabled?: boolean
}

export function useNovelWorkspaceShortcuts(
  options: UseNovelWorkspaceShortcutsOptions = {}
): void {
  const { enabled = true } = options

  // ref 保持最新值，避免 useHotkeys 闭包陈旧
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // Ctrl+B — 切换左侧栏
  useHotkeys('mod+b', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    useNovelWorkspaceLayoutStore.getState().toggleSidebar()
  }, { preventDefault: false }, [])

  // Ctrl+J — 切换右侧面板
  useHotkeys('mod+j', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    useNovelWorkspaceLayoutStore.getState().toggleRightPanel()
  }, { preventDefault: false }, [])

  // Ctrl+1~4 — 主工作区布局，顺序与顶栏 Segmented 从左到右一致
  useHotkeys('mod+1', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    useNovelWorkspaceLayoutStore.getState().setLayoutMode('text')
  }, { preventDefault: false }, [])

  useHotkeys('mod+2', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    useNovelWorkspaceLayoutStore.getState().setLayoutMode('text-timeline')
  }, { preventDefault: false }, [])

  useHotkeys('mod+3', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    useNovelWorkspaceLayoutStore.getState().setLayoutMode('timeline')
  }, { preventDefault: false }, [])

  useHotkeys('mod+4', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    useNovelWorkspaceLayoutStore.getState().setLayoutMode('graph')
  }, { preventDefault: false }, [])

  // Ctrl+Shift+F — 切换专注模式
  useHotkeys('mod+shift+f', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    useNovelWorkspaceLayoutStore.getState().toggleFocusMode()
  }, { preventDefault: false }, [])

  // Esc — 退出专注模式（仅在专注模式下生效，不干扰其他 Esc 行为）
  useHotkeys('esc', (e) => {
    if (!enabledRef.current) return
    const { focusMode, setFocusMode } = useNovelWorkspaceLayoutStore.getState()
    if (focusMode) {
      e.preventDefault()
      e.stopPropagation()
      setFocusMode(false)
    }
  }, { preventDefault: false }, [])
}
