import { useRef } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useShortcut, type ShortcutHandlers } from './use-shortcut'

// ── 类型定义 ──

export interface ChatShortcutHandlers extends ShortcutHandlers {
  /** Cmd/Ctrl+/ — 显示快捷键帮助（可选） */
  onShowShortcutHelp?: () => void
}

// ── 辅助函数 ──

/**
 * 判断键盘事件目标是否为可编辑元素。
 * 复制自 use-shortcut.ts 以避免修改既有模块导出。
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

// ── Hook ──

/**
 * useChatShortcuts：聊天工作台统一快捷键 hook
 *
 * 基于 useShortcut（覆盖 §9.3 快捷键全表），并追加聊天工作台专属绑定：
 *
 *   Cmd/Ctrl+B        — 切换左侧栏（与 Cmd/Ctrl+\ 等效，便于记忆）
 *   Cmd/Ctrl+Shift+B  — 切换右侧栏（与 Cmd/Ctrl+Shift+\ 等效）
 *   Cmd/Ctrl+/        — 显示快捷键帮助（可选）
 *
 * Escape 行为由调用方通过 onAbort 实现：
 *   - 若 CommandPalette 打开 → 关闭 palette
 *   - 否则若 DevLog 打开 → 关闭 devlog
 *   - 否则 → 中断当前流式运行
 *
 * macOS vs Windows 的键位差异由 react-hotkeys-hook 的 `mod` 前缀自动处理
 *（macOS 上 mod = Cmd，Windows/Linux 上 mod = Ctrl）。
 *
 * 与 useNovelWorkspaceShortcuts 不会冲突：聊天与小说工作台不会同时挂载。
 */
export function useChatShortcuts(handlers: ChatShortcutHandlers): void {
  // 剥离聊天专属 handler，剩余委托给底层 useShortcut
  const { onShowShortcutHelp, ...baseHandlers } = handlers
  useShortcut(baseHandlers)

  // 使用 ref 保存最新的 handlers，避免 useHotkeys 闭包陈旧
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  // Cmd/Ctrl+B — 切换左侧栏（与 Cmd/Ctrl+\ 等效的补充绑定）
  useHotkeys('mod+b', (e) => {
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onToggleLeftPanel?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+Shift+B — 切换右侧栏（与 Cmd/Ctrl+Shift+\ 等效的补充绑定）
  useHotkeys('mod+shift+b', (e) => {
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onToggleRightPanel?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+/ — 显示快捷键帮助（即使在输入框中也触发）
  useHotkeys('mod+/', (e) => {
    e.preventDefault()
    handlersRef.current.onShowShortcutHelp?.()
  }, { enableOnFormTags: true, preventDefault: true }, [])
}
