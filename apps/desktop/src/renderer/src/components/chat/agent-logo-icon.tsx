import { useMemo, type CSSProperties } from 'react'
import { DEFAULT_AGENT_ICON, type AgentIcon } from '@/config/preset-assistants'
import { cn } from '@/lib/utils'

/**
 * AgentLogoIcon：Agent 身份标识（对齐 AionUi AgentLogoIcon 设计）
 *
 * 设计：
 *   - 优先渲染传入的 lucide 图标（图标占主视觉，白色彩色背景）
 *   - 否则显示名字首字（中英文皆可）
 *   - 背景色由 agentId 哈希到 HSL 色相，确保同一 Agent 颜色稳定
 *   - 三档尺寸：sm（20px 行内）/ md（24px 默认）/ lg（32px 头像）
 *
 * 已移除 emoji 支持，统一使用 lucide 图标库方案。
 */

export type AgentLogoSize = 'sm' | 'md' | 'lg'

export interface AgentLogoIconProps {
  /** Agent ID（用于稳定配色） */
  agentId: string
  /** Agent 显示名（用于首字回退） */
  agentName: string
  /** lucide 图标组件（优先于首字渲染） */
  icon?: AgentIcon
  /** 尺寸 */
  size?: AgentLogoSize
  /** 自定义类名 */
  className?: string
  /** 自定义样式 */
  style?: CSSProperties
}

/** 将字符串哈希为 0-359 的色相值 */
function hashToHue(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0 // 转为 32 位整数
  }
  return Math.abs(hash) % 360
}

/** 从 agentName 提取首字（中文取第一个字，英文取首字母大写） */
function getInitial(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  // 取第一个 Unicode 字符（支持中文/英文）
  const firstChar = Array.from(trimmed)[0] ?? '?'
  // 英文字母转大写
  return /[a-z]/.test(firstChar) ? firstChar.toUpperCase() : firstChar
}

const SIZE_CLASSES: Record<AgentLogoSize, string> = {
  sm: 'size-5',
  md: 'size-6',
  lg: 'size-8',
}

const ICON_SIZE: Record<AgentLogoSize, string> = {
  sm: 'size-3',
  md: 'size-3.5',
  lg: 'size-4',
}

const TEXT_SIZE: Record<AgentLogoSize, string> = {
  sm: 'text-[10px]',
  md: 'text-[11px]',
  lg: 'text-sm',
}

export function AgentLogoIcon({
  agentId,
  agentName,
  icon: Icon,
  size = 'md',
  className,
  style,
}: AgentLogoIconProps) {
  const hue = useMemo(() => hashToHue(agentId || agentName || 'default'), [agentId, agentName])
  const initial = useMemo(() => getInitial(agentName), [agentName])

  // HSL 配色：60% 饱和度 + 50% 亮度，确保深浅模式下都可读
  const backgroundColor = `hsl(${hue}, 60%, 50%)`
  const textColor = '#ffffff' // 白字在彩色背景上始终可读

  const ResolvedIcon = Icon ?? DEFAULT_AGENT_ICON

  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none',
        SIZE_CLASSES[size],
        className,
      )}
      style={{
        backgroundColor,
        color: textColor,
        ...style,
      }}
      aria-label={`Agent: ${agentName}`}
      role="img"
    >
      {Icon ? <ResolvedIcon className={ICON_SIZE[size]} aria-hidden="true" /> : <span className={TEXT_SIZE[size]}>{initial}</span>}
    </div>
  )
}
