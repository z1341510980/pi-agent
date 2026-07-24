import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

export type EmptyStateVariant = 'workflow' | 'chat' | 'reverse' | 'arrange' | 'discussion' | 'default'

export interface ConversationEmptyStateProps {
  /** 插图变体 */
  variant?: EmptyStateVariant
  /** 标题 */
  title: string
  /** 引导文案 */
  hint: string
  className?: string
}

/** 轻量 SVG 插图：写作流程 */
function WorkflowIllustration() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="text-primary">
      {/* 纸张 */}
      <rect x="16" y="10" width="32" height="44" rx="4" className="fill-current/8 stroke-current/30" strokeWidth="1.5" />
      {/* 文字行 */}
      <line x1="22" y1="20" x2="42" y2="20" className="stroke-current/25" strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="26" x2="38" y2="26" className="stroke-current/20" strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="32" x2="40" y2="32" className="stroke-current/15" strokeWidth="2" strokeLinecap="round" />
      {/* 笔 */}
      <path d="M40 38 L48 30 L52 34 L44 42 L39 43 Z" className="fill-current/20 stroke-current/40" strokeWidth="1.5" strokeLinejoin="round" />
      {/*  sparkle */}
      <circle cx="50" cy="18" r="2" className="fill-current/30" />
      <path d="M50 13v3M50 20v3M45 18h3M52 18h3" className="stroke-current/25" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** 轻量 SVG 插图：聊天对话 */
function ChatIllustration() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="text-primary">
      {/* 左侧气泡 */}
      <rect x="10" y="16" width="28" height="18" rx="9" className="fill-current/10 stroke-current/30" strokeWidth="1.5" />
      <circle cx="20" cy="25" r="1.5" className="fill-current/30" />
      <circle cx="25" cy="25" r="1.5" className="fill-current/25" />
      <circle cx="30" cy="25" r="1.5" className="fill-current/20" />
      {/* 右侧气泡 */}
      <rect x="28" y="32" width="26" height="16" rx="8" className="fill-current/15 stroke-current/35" strokeWidth="1.5" />
      <line x1="34" y1="38" x2="48" y2="38" className="stroke-current/25" strokeWidth="2" strokeLinecap="round" />
      <line x1="34" y1="43" x2="44" y2="43" className="stroke-current/20" strokeWidth="2" strokeLinecap="round" />
      {/* sparkle */}
      <path d="M52 14v4M52 22v4M48 18h4M54 18h4" className="stroke-current/25" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** 轻量 SVG 插图：反推 */
function ReverseIllustration() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="text-primary">
      {/* 文档 */}
      <rect x="12" y="14" width="24" height="36" rx="3" className="fill-current/8 stroke-current/25" strokeWidth="1.5" />
      <line x1="17" y1="22" x2="31" y2="22" className="stroke-current/20" strokeWidth="2" strokeLinecap="round" />
      <line x1="17" y1="28" x2="28" y2="28" className="stroke-current/15" strokeWidth="2" strokeLinecap="round" />
      {/* 反向箭头 */}
      <path d="M42 32 H54" className="stroke-current/35" strokeWidth="2" strokeLinecap="round" />
      <path d="M46 27 L41 32 L46 37" className="stroke-current/35" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* 实体节点 */}
      <circle cx="54" cy="22" r="4" className="fill-current/15 stroke-current/30" strokeWidth="1.5" />
      <circle cx="54" cy="32" r="4" className="fill-current/20 stroke-current/35" strokeWidth="1.5" />
      <circle cx="54" cy="42" r="4" className="fill-current/15 stroke-current/30" strokeWidth="1.5" />
    </svg>
  )
}

/** 轻量 SVG 插图：矩阵编排 */
function ArrangeIllustration() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="text-primary">
      {/* 网格 */}
      <rect x="12" y="14" width="40" height="36" rx="4" className="fill-current/5 stroke-current/20" strokeWidth="1.5" />
      {/* 行 */}
      <line x1="12" y1="26" x2="52" y2="26" className="stroke-current/15" strokeWidth="1" />
      <line x1="12" y1="38" x2="52" y2="38" className="stroke-current/15" strokeWidth="1" />
      {/* 列 */}
      <line x1="25" y1="14" x2="25" y2="50" className="stroke-current/15" strokeWidth="1" />
      <line x1="38" y1="14" x2="38" y2="50" className="stroke-current/15" strokeWidth="1" />
      {/* 高亮单元格 */}
      <rect x="26" y="27" width="11" height="10" rx="2" className="fill-current/20" />
      <rect x="13" y="15" width="11" height="10" rx="2" className="fill-current/12" />
      {/* sparkle */}
      <path d="M56 10v4M56 18v4M52 14h4M58 14h4" className="stroke-current/25" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** 轻量 SVG 插图：群聊讨论 */
function DiscussionIllustration() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="text-primary">
      {/* 多个头像 */}
      <circle cx="22" cy="22" r="7" className="fill-current/12 stroke-current/30" strokeWidth="1.5" />
      <circle cx="42" cy="22" r="7" className="fill-current/15 stroke-current/35" strokeWidth="1.5" />
      <circle cx="32" cy="38" r="7" className="fill-current/10 stroke-current/25" strokeWidth="1.5" />
      {/* 连接线 */}
      <line x1="27" y1="26" x2="30" y2="33" className="stroke-current/20" strokeWidth="1.2" />
      <line x1="37" y1="26" x2="34" y2="33" className="stroke-current/20" strokeWidth="1.2" />
      <line x1="28" y1="22" x2="36" y2="22" className="stroke-current/20" strokeWidth="1.2" />
      {/* 对话点 */}
      <circle cx="22" cy="22" r="2" className="fill-current/30" />
      <circle cx="42" cy="22" r="2" className="fill-current/35" />
      <circle cx="32" cy="38" r="2" className="fill-current/25" />
    </svg>
  )
}

/** 默认插图 */
function DefaultIllustration() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="text-primary">
      <rect x="14" y="12" width="36" height="40" rx="6" className="fill-current/6 stroke-current/20" strokeWidth="1.5" />
      <line x1="22" y1="24" x2="42" y2="24" className="stroke-current/20" strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="31" x2="38" y2="31" className="stroke-current/15" strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="38" x2="35" y2="38" className="stroke-current/12" strokeWidth="2" strokeLinecap="round" />
      <path d="M48 8v5M48 17v5M44 12.5h5M50 12.5h5" className="stroke-current/25" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="52" cy="44" r="3" className="fill-current/15" />
    </svg>
  )
}

const ILLUSTRATIONS: Record<EmptyStateVariant, () => ReactElement> = {
  workflow: WorkflowIllustration,
  chat: ChatIllustration,
  reverse: ReverseIllustration,
  arrange: ArrangeIllustration,
  discussion: DiscussionIllustration,
  default: DefaultIllustration,
}

/**
 * ConversationEmptyState：对话面板空状态
 *
 * 轻量 SVG 插图 + 标题 + 引导文案，替代纯文字空状态。
 */
export function ConversationEmptyState({
  variant = 'default',
  title,
  hint,
  className,
}: ConversationEmptyStateProps) {
  const Illustration = ILLUSTRATIONS[variant] ?? ILLUSTRATIONS.default

  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center p-6', className)}>
      <div className="mb-4 opacity-80">
        <Illustration />
      </div>
      <h4 className="text-sm font-semibold text-text mb-1.5">{title}</h4>
      <p className="max-w-[220px] text-center text-xs leading-relaxed text-subtle">{hint}</p>
    </div>
  )
}
