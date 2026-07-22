import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

/**
 * 矩阵全局 Tooltip（dhtmlx-gantt 风格富浮窗）
 *
 * 用事件委托统一处理所有带 `data-tip` 属性的元素，避免给每个色带/单元格
 * 包裹 Popover/HoverCard 造成大量 DOM 节点和性能损耗。
 *
 * - mouseenter（200ms 延迟）显示；mouseleave 立即隐藏
 * - 浮窗定位：跟随鼠标，边界自动翻转
 * - 视觉：暗色玻璃底 + 阴影 + 圆角，比原生 title 更精致
 *
 * 使用方式：在矩阵容器内挂一次即可，所有 data-tip 元素自动生效。
 */
export function MatrixTooltip(): ReactElement | null {
  const [tip, setTip] = useState<string | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback(() => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null }
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
  }, [])

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const target = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null
      const text = target?.getAttribute('data-tip') || ''
      if (!text) {
        clearTimers()
        hideTimer.current = setTimeout(() => setTip(null), 80)
        return
      }
      // 已显示且文本相同：仅跟随位置
      if (tip === text) {
        setPos({ x: e.clientX, y: e.clientY })
        return
      }
      // 新目标：延迟显示（避免快速划过闪烁）
      clearTimers()
      showTimer.current = setTimeout(() => {
        setTip(text)
        setPos({ x: e.clientX, y: e.clientY })
      }, 200)
    }
    const handleLeave = () => {
      clearTimers()
      hideTimer.current = setTimeout(() => setTip(null), 80)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseleave', handleLeave)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseleave', handleLeave)
      clearTimers()
    }
  }, [tip, clearTimers])

  if (!tip) return null

  // 边界翻转：鼠标在右半屏时浮窗显示在左侧，下半屏时显示在上方
  const vw = window.innerWidth
  const vh = window.innerHeight
  const flipX = pos.x > vw - 280
  const flipY = pos.y > vh - 120
  const style: React.CSSProperties = {
    position: 'fixed',
    left: flipX ? pos.x - 12 : pos.x + 16,
    top: flipY ? pos.y - 12 : pos.y + 20,
    transform: flipX ? 'translateX(-100%)' : undefined,
    zIndex: 9999,
    maxWidth: 280,
    padding: '6px 10px',
    borderRadius: 6,
    background: 'rgba(17, 17, 18, 0.92)',
    backdropFilter: 'blur(8px)',
    color: '#fafafa',
    fontSize: 11.5,
    lineHeight: 1.5,
    boxShadow: '0 4px 16px rgba(0,0,0,0.22), 0 0 0 1px rgba(255,255,255,0.06)',
    pointerEvents: 'none',
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  }

  return createPortal(
    <div role="tooltip" style={style}>{tip}</div>,
    document.body,
  )
}
