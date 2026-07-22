/**
 * MatrixHoverCard：矩阵全局悬浮卡（单例）
 *
 * 重设计"一套语言"原则：全矩阵（单元格/色带/节点/子轨道/标尺）统一使用
 * 本组件作为唯一的悬浮信息层，替代旧 MatrixTooltip（data-tip 黑底文本）
 * 与 SubtrackBubble（CSS group-hover）两套机制。
 *
 * 用法：元素上挂 data-hc-* 属性即可（事件委托，无需包裹组件）：
 * - data-hc-dim    标题（维度名 / 实体名，取 data-hc-color 着色）
 * - data-hc-ch     章节（"3" 或 "3 – 7"）
 * - data-hc-before 变化前值（红色删除线）
 * - data-hc-after  变化后值 / 当前语义（绿色加粗）
 * - data-hc-desc   补充描述（灰字）
 * - data-hc-color  标题颜色（实体色）
 *
 * 行为：hover 120ms 后显示，移开 80ms 后隐藏；锚定触发元素上方居中，
 * 顶部空间不足时翻到下方；横向视口边界内收敛。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

interface HoverCardData {
  dim: string
  ch: string
  before: string
  after: string
  desc: string
  color: string
  /** 触发元素锚点 */
  rect: { cx: number; top: number; bottom: number }
}

const SHOW_DELAY = 120
const HIDE_DELAY = 80
const CARD_MAX_W = 280

export function MatrixHoverCard(): ReactElement | null {
  const [data, setData] = useState<HoverCardData | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback(() => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null }
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
  }, [])

  useEffect(() => {
    const readTarget = (el: HTMLElement): HoverCardData | null => {
      const dim = el.dataset.hcDim ?? ''
      const after = el.dataset.hcAfter ?? ''
      const desc = el.dataset.hcDesc ?? ''
      // 三无元素不弹卡
      if (!dim && !after && !desc) return null
      const r = el.getBoundingClientRect()
      return {
        dim,
        ch: el.dataset.hcCh ?? '',
        before: el.dataset.hcBefore ?? '',
        after,
        desc,
        color: el.dataset.hcColor ?? 'var(--color-primary)',
        rect: { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom },
      }
    }

    const handleOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[data-hc-dim],[data-hc-after],[data-hc-desc]') as HTMLElement | null
      clearTimers()
      if (!el) {
        hideTimer.current = setTimeout(() => setData(null), HIDE_DELAY)
        return
      }
      const next = readTarget(el)
      if (!next) {
        hideTimer.current = setTimeout(() => setData(null), HIDE_DELAY)
        return
      }
      showTimer.current = setTimeout(() => setData(next), SHOW_DELAY)
    }
    const handleScroll = () => {
      clearTimers()
      setData(null)
    }

    document.addEventListener('mouseover', handleOver)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mouseover', handleOver)
      document.removeEventListener('scroll', handleScroll, true)
      clearTimers()
    }
  }, [clearTimers])

  if (!data) return null

  // 上方空间不足 120px 时翻到下方
  const above = data.rect.top > 120
  const x = Math.max(CARD_MAX_W / 2 + 8, Math.min(window.innerWidth - CARD_MAX_W / 2 - 8, data.rect.cx))

  const cardStyle: React.CSSProperties = {
    position: 'fixed',
    left: x,
    top: above ? data.rect.top : data.rect.bottom,
    transform: above ? 'translate(-50%, calc(-100% - 10px))' : 'translate(-50%, 10px)',
    zIndex: 9999,
    minWidth: 180,
    maxWidth: CARD_MAX_W,
    padding: '8px 10px',
    borderRadius: 8,
    background: 'var(--color-surface-1)',
    border: '1px solid var(--color-border-strong)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.05)',
    pointerEvents: 'none',
    animation: 'matrix-hc-in 120ms ease-out',
  }

  return createPortal(
    <>
      <style>{`@keyframes matrix-hc-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div role="tooltip" style={cardStyle}>
        {/* 箭头 */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            width: 8,
            height: 8,
            background: 'var(--color-surface-1)',
            borderRight: '1px solid var(--color-border-strong)',
            borderBottom: '1px solid var(--color-border-strong)',
            ...(above
              ? { bottom: -5, transform: 'translateX(-50%) rotate(45deg)' }
              : { top: -5, transform: 'translateX(-50%) rotate(225deg)' }),
          }}
        />
        {data.dim && (
          <div style={{ fontSize: 11, fontWeight: 700, color: data.color, marginBottom: 1 }}>{data.dim}</div>
        )}
        {data.ch && (
          <div style={{ fontSize: 10, color: 'var(--color-hint)', marginBottom: 4 }}>第 {data.ch} 章</div>
        )}
        {(data.before || data.after) && (
          <div style={{ fontSize: 11, lineHeight: 1.5, wordBreak: 'break-word' }}>
            {data.before && data.before !== data.after && (
              <span style={{ color: 'var(--color-danger)', textDecoration: 'line-through', opacity: 0.75 }}>
                {data.before}
              </span>
            )}
            {data.before && data.before !== data.after && (
              <span style={{ color: 'var(--color-hint)', margin: '0 4px' }}>→</span>
            )}
            {data.after && (
              <span style={{ color: data.before && data.before !== data.after ? 'var(--color-success)' : 'var(--color-text)', fontWeight: 600 }}>
                {data.after}
              </span>
            )}
          </div>
        )}
        {data.desc && (
          <div style={{ fontSize: 10, color: 'var(--color-subtle)', marginTop: 4, lineHeight: 1.5, wordBreak: 'break-word' }}>
            {data.desc}
          </div>
        )}
      </div>
    </>,
    document.body,
  )
}
