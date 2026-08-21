import type { ReactElement } from 'react'
import logoImage from '@/assets/logo.png'

// ── 类型定义 ──

interface EmptyStateProps {
  /** 点击示例问题回调（保留兼容，空态不再使用） */
  onExampleClick?: (text: string) => void
}

// ── 主组件 ──

/**
 * EmptyState：空状态
 *
 * 新会话时显示居左标题 "Wenlang Agent / 你的职场超能力"
 * 输入框和工作区选择由父组件渲染
 */
export function EmptyState(_props: EmptyStateProps): ReactElement {
  return (
    <div
      className="flex flex-col items-start justify-center gap-2 py-16 px-2"
      role="region"
      aria-label="空状态引导"
    >
      <img
        src={logoImage}
        alt="Wenlang Agent"
        className="mb-3 size-16 rounded-[20px] object-cover shadow-[var(--dsw-shadow-lv2)]"
      />
      <h1 className="text-4xl font-semibold text-text leading-tight text-balance">Wenlang Agent</h1>
      <p className="max-w-lg text-2xl font-medium text-subtle text-pretty">
        你的职场超能力
      </p>
    </div>
  )
}
