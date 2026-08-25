import { useEffect, useRef } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'

// ── 类型定义 ──

export interface ShortcutHandlers {
  /** Cmd/Ctrl+K — 打开命令面板 */
  onCommandPalette?: () => void
  /** Cmd/Ctrl+N — 新建会话 */
  onNewSession?: () => void
  /** Cmd/Ctrl+, — 打开设置 */
  onOpenSettings?: () => void
  /** Cmd/Ctrl+D — 切换 DevLog */
  onToggleDevLog?: () => void
  /** Cmd/Ctrl+\ — 切换左栏 */
  onToggleLeftPanel?: () => void
  /** Cmd/Ctrl+Shift+\ — 切换右栏 */
  onToggleRightPanel?: () => void
  /** Cmd/Ctrl+[ — 上一会话 */
  onPrevSession?: () => void
  /** Cmd/Ctrl+] — 下一会话 */
  onNextSession?: () => void
  /** Esc — 中断当前运行 / 关闭浮层 */
  onAbort?: () => void
  /** Cmd/Ctrl+L — 聚焦输入框 */
  onFocusInput?: () => void
  /** Cmd/Ctrl+M — 切换权限模式 */
  onTogglePermissionMode?: () => void
  /** Cmd/Ctrl+Z — 撤销 */
  onUndo?: () => void
  /** Cmd/Ctrl+Shift+Z 或 Cmd/Ctrl+Y — 重做 */
  onRedo?: () => void
}

// ── 辅助函数 ──

/**
 * 判断键盘事件目标是否为可编辑元素
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

export interface UseShortcutOptions {
  /**
   * false 时忽略全部按键。
   *
   * App 外壳对 chat / 插件工作区做 keep-alive（切页只隐藏不卸载），隐藏挂载的
   * 工作台必须让出按键，否则会和当前可见页面抢同一组快捷键（如 Esc 中断、
   * Ctrl+B 折叠面板），甚至误触发不可见页面的中断/撤销。
   */
  enabled?: boolean
}

/**
 * 全局快捷键 hook（基于 react-hotkeys-hook）
 *
 * 实现 FRONTEND_DESIGN_SYSTEM.md §9.3 快捷键全表：
 *   Cmd/Ctrl+K        — 命令面板（全局，输入框中也触发）
 *   Cmd/Ctrl+N        — 新建会话（全局）
 *   Cmd/Ctrl+,        — 打开设置（全局）
 *   Cmd/Ctrl+D        — 切换 DevLog（全局）
 *   Cmd/Ctrl+\        — 切换左栏（对话）
 *   Cmd/Ctrl+Shift+\  — 切换右栏（对话）
 *   Cmd/Ctrl+[ / ]    — 上/下一会话（对话）
 *   Esc               — 中断 / 关闭浮层（全局）
 *   Cmd/Ctrl+L        — 聚焦输入框（对话）
 *   Cmd/Ctrl+M        — 切换权限模式（对话）
 *
 * 大部分快捷键在可编辑元素中不触发（避免与文本输入冲突），
 * 仅 Cmd/Ctrl+K 和 Esc 例外。
 */
export function useShortcut(
  handlers: ShortcutHandlers,
  options: UseShortcutOptions = {}
): void {
  const { enabled = true } = options

  // 使用 ref 保存最新的 handlers/enabled，避免 useHotkeys 闭包陈旧
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // Cmd/Ctrl+K — 命令面板（即使在输入框中也触发）
  useHotkeys('mod+k', (e) => {
    if (!enabledRef.current) return
    e.preventDefault()
    handlersRef.current.onCommandPalette?.()
  }, { enableOnFormTags: true, preventDefault: true }, [])

  // Cmd/Ctrl+N — 新建会话
  useHotkeys('mod+n', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onNewSession?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+, — 打开设置
  useHotkeys('mod+comma', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onOpenSettings?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+D — 切换 DevLog
  useHotkeys('mod+d', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onToggleDevLog?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+\ — 切换左栏
  useHotkeys('mod+backslash', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onToggleLeftPanel?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+Shift+\ — 切换右栏
  useHotkeys('mod+shift+backslash', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onToggleRightPanel?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+[ — 上一会话
  useHotkeys('mod+bracketleft', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onPrevSession?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+] — 下一会话
  useHotkeys('mod+bracketright', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onNextSession?.()
  }, { preventDefault: false }, [])

  // Esc — 中断 / 关闭浮层（在非编辑区中断运行；编辑区由 React 组件处理）
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!enabledRef.current) return
      if (e.key === 'Escape' && !isEditableTarget(e)) {
        if (handlersRef.current.onAbort) {
          e.preventDefault()
          handlersRef.current.onAbort()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Cmd/Ctrl+L — 聚焦输入框
  useHotkeys('mod+l', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onFocusInput?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+M — 切换权限模式
  useHotkeys('mod+m', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onTogglePermissionMode?.()
  }, { preventDefault: false }, [])

  // Cmd/Ctrl+Z — 撤销（编辑器内由 Tiptap 自行处理）
  useHotkeys('mod+z', (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onUndo?.()
  }, { enableOnFormTags: false }, [])

  // Cmd/Ctrl+Shift+Z 或 Cmd/Ctrl+Y — 重做
  useHotkeys(['mod+shift+z', 'mod+y'], (e) => {
    if (!enabledRef.current) return
    if (isEditableTarget(e)) return
    e.preventDefault()
    handlersRef.current.onRedo?.()
  }, { enableOnFormTags: false }, [])
}
