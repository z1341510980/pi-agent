import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { GraduationCap, Home, MessageSquare, BookOpen, Settings, Keyboard, RotateCcw, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOnboardingStore } from './onboarding-store'
import type { TourId } from './types'

type AppView = 'home' | 'chat' | 'novel' | 'settings'

interface MenuItem {
  tourId: TourId
  label: string
  description: string
  icon: typeof Home
  view: AppView
}

const MENU_ITEMS: MenuItem[] = [
  {
    tourId: 'home-tour',
    label: '首页引导',
    description: '6 步概览欢迎页、入口与最近活动',
    icon: Home,
    view: 'home',
  },
  {
    tourId: 'novel-tour',
    label: '小说创作',
    description: '8 步走完项目 / 布局 / 画布 / 矩阵 / 编辑器 / 右栏',
    icon: BookOpen,
    view: 'novel',
  },
  {
    tourId: 'chat-tour',
    label: '对话工作台',
    description: '7 步熟悉会话、输入、模型与权限',
    icon: MessageSquare,
    view: 'chat',
  },
  {
    tourId: 'settings-tour',
    label: '设置页',
    description: '5 步配置 Provider / 模型 / Agent / 安全',
    icon: Settings,
    view: 'settings',
  },
  {
    tourId: 'shortcuts-tour',
    label: '快捷键教学',
    description: '8 个高频快捷键速记',
    icon: Keyboard,
    view: 'home',
  },
]

export interface OnboardingRailButtonProps {
  /** 由 App 传入的 view 切换器，tour 起步前先切到对应 view */
  setView: (view: AppView) => void
  /** 当前 view，用于高亮当前可用的引导 */
  currentView: AppView
  className?: string
}

/**
 * 新手引导 RailButton + 下拉菜单。
 *
 * 行为：
 * - 单击按钮 → 弹出 5 个 tour 选项
 * - 选中 → setView(对应 view) → 延迟 300ms 启动 tour（等视图渲染）
 * - 外部点击 / Esc → 关闭菜单
 *
 * 视觉：
 * - 与 RailButton 一致的尺寸/active 风格
 * - 菜单浮在 rail 右侧（bottom-aligned 与按钮底部对齐，向上展开，避开窗口底部）
 * - 已完成的 tour 在菜单里以 ✓ 标识
 */
export function OnboardingRailButton({
  setView,
  currentView,
  className,
}: OnboardingRailButtonProps): ReactElement {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const isCompleted = useOnboardingStore((s) => s.isCompleted())

  // 外部点击 & Esc 关闭
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const handleSelect = (item: MenuItem) => {
    setOpen(false)
    // 切换到对应 view 后再启动 tour
    if (item.view !== currentView) {
      setView(item.view)
    }
    setTimeout(() => {
      useOnboardingStore.getState().startTour(item.tourId)
    }, 300)
  }

  const handleReset = () => {
    setOpen(false)
    useOnboardingStore.getState().resetOnboarding()
  }

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label="新手引导"
        aria-haspopup="menu"
        aria-expanded={open}
        title="新手引导"
        className={`relative size-9 active:scale-[0.96] transition-[background-color,color,transform] ${
          open
            ? 'text-primary'
            : 'text-subtle hover:text-text hover:bg-surface-3'
        }`}
      >
        <GraduationCap className="size-4" aria-hidden="true" />
      </Button>

      {open && (
        <div
          role="menu"
          aria-label="选择引导内容"
          // bottom-0：菜单底部对齐按钮底部，向上展开。
          // 因为 OnboardingRailButton 带 mt-auto 被推到导航栏底部，
          // top-0 会向下展开导致超出窗口；bottom-0 让用户能看到完整菜单。
          // max-h + overflow-y-auto 作为窗口极矮时的兜底。
          className="absolute bottom-0 left-full ml-2 z-[60] w-64 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border border-border bg-surface-1 p-1.5 shadow-overlay"
        >
          <div className="px-2.5 py-1.5 mb-1 flex items-center justify-between">
            <span className="text-[11px] font-[760] text-subtle uppercase tracking-wider">
              新手引导
            </span>
            {isCompleted && (
              <span className="inline-flex items-center gap-1 text-[10px] text-success">
                <Check className="size-3" />
                已完成
              </span>
            )}
          </div>

          <ul className="m-0 p-0 list-none">
            {MENU_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <li key={item.tourId}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleSelect(item)}
                    className="group w-full flex items-start gap-2.5 px-2.5 py-2 rounded-md text-left hover:bg-surface-3 transition-colors"
                  >
                    <Icon className="size-3.5 text-muted-foreground shrink-0 mt-0.5 group-hover:text-text" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-[600] text-text">{item.label}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">{item.description}</div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="mt-1 pt-1.5 border-t border-border">
            <button
              type="button"
              role="menuitem"
              onClick={handleReset}
              className="group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left hover:bg-surface-3 transition-colors"
            >
              <RotateCcw className="size-3.5 text-muted-foreground shrink-0 group-hover:text-text" aria-hidden="true" />
              <span className="text-xs text-muted-foreground group-hover:text-text">重置引导进度</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
