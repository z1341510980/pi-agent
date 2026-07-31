import type { ReactNode } from 'react'
import type { ReactElement } from 'react'

/**
 * SettingRow —— AionUi PreferenceRow 风格的统一设置行
 *
 * 左侧：标签（必填）+ 描述（可选）
 * 右侧：控件槽位（shrink-0）
 *
 * 用于通用设置、技能设置等卡片内每一条设置项。
 */
interface SettingRowProps {
  /** 主标签 */
  label: string
  /** 辅助描述（可选） */
  description?: string
  /** 右侧控件 */
  children: ReactNode
  /** 用于在分组中给本行加底部分隔线 */
  className?: string
}

export function SettingRow({
  label,
  description,
  children,
  className
}: SettingRowProps): ReactElement {
  return (
    <div className={`flex min-h-12 items-center justify-between gap-6 py-3 ${className ?? ''}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text">{label}</div>
        {description && (
          <div className="mt-1 text-xs text-hint leading-relaxed text-pretty">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/**
 * SettingsPageHeader —— AionUi 风格的设置页头部
 *
 * 上方：英文小标题 + 中文大标题 + 描述
 * 可选：右侧操作槽位
 */
interface SettingsPageHeaderProps {
  /** 英文小标题（如 "General"） */
  eyebrow?: string
  /** 主标题 */
  title: string
  /** 描述 */
  description?: string
  /** 右侧操作区 */
  actions?: ReactNode
}

export function SettingsPageHeader({
  eyebrow,
  title,
  description,
  actions
}: SettingsPageHeaderProps): ReactElement {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="m-0 text-xs font-[760] text-subtle">{eyebrow}</p>}
        <h2 className="m-0 mt-0.5 text-[22px] font-[780] leading-tight text-text text-balance">
          {title}
        </h2>
        {description && (
          <p className="m-0 mt-1.5 max-w-2xl text-xs text-hint leading-relaxed text-pretty">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * SettingsCard —— 统一的卡片容器
 *
 * AionUi 风格：bg-surface-1 圆角 + 内部分隔线
 */
interface SettingsCardProps {
  children: ReactNode
  className?: string
}

export function SettingsCard({ children, className }: SettingsCardProps): ReactElement {
  return (
    <section className={`pi-surface-card rounded-[18px] p-4 ${className ?? ''}`}>
      {children}
    </section>
  )
}
