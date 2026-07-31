import type { ReactElement } from 'react'
import { useState } from 'react'
import {
  XIcon,
  SettingsIcon,
  PlugIcon,
  LayersIcon,
  BotIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  InfoIcon,
  ClockIcon,
  SparklesIcon,
  UsersIcon,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GeneralSettings } from './general-settings'
import { AboutPage } from './about-page'
import { SecurityPage } from './security-page'
import { AgentPage } from './agent-page'
import { ModelsPage } from './models-page'
import { CronPage } from './cron-page'
import { AssistantSettings } from './assistant-settings'
import { SkillsSettings } from './skills-settings'
import { ProviderSettings } from './provider-settings'

export type SettingsSection =
  | 'general'
  | 'assistants'
  | 'skills'
  | 'providers'
  | 'models'
  | 'agents'
  | 'security'
  | 'cron'
  | 'about'

interface SettingsPageProps {
  onClose: () => void
}

interface NavItem {
  id: SettingsSection
  label: string
  icon: LucideIcon
}

interface NavGroup {
  /** 分组标题（i18n key 留待后续；当前直接展示中文） */
  label: string
  items: NavItem[]
}

/**
 * 左侧导航分组（对齐 AionUi SettingsSider 的 GROUP_HEADER_BEFORE 风格）
 * - AI 核心：助手 / 技能 / 模型与 Provider / Agent / 权限与安全 / 定时任务
 * - 应用：通用设置 / 关于
 */
const navGroups: NavGroup[] = [
  {
    label: 'AI 核心',
    items: [
      { id: 'assistants', label: '助手', icon: UsersIcon },
      { id: 'skills', label: '技能', icon: SparklesIcon },
      { id: 'providers', label: '模型与 Provider', icon: PlugIcon },
      { id: 'models', label: '模型管理', icon: LayersIcon },
      { id: 'agents', label: 'Agent 管理', icon: BotIcon },
      { id: 'security', label: '权限与安全', icon: ShieldIcon },
      { id: 'cron', label: '定时任务', icon: ClockIcon }
    ]
  },
  {
    label: '应用',
    items: [
      { id: 'general', label: '通用设置', icon: SlidersHorizontalIcon },
      { id: 'about', label: '关于', icon: InfoIcon }
    ]
  }
]

export function SettingsPage({ onClose }: SettingsPageProps): ReactElement {
  // 默认落在"通用设置"，对齐 AionUi 首屏聚焦应用偏好的体验
  const [section, setSection] = useState<SettingsSection>('general')

  return (
    <div
      className="grid grid-rows-[var(--titlebar-height)_minmax(0,1fr)] h-full overflow-hidden bg-app-bg text-text"
      aria-label="设置中心"
    >
      {/* ── 顶部标题栏 ── */}
      <header className="pi-glass-header flex items-center justify-between min-w-0 bg-titlebar-bg">
        <div className="flex items-center gap-3 h-full min-w-0 px-4 [webkit-app-region:drag]">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <SettingsIcon className="size-4" />
          </span>
          <h1 className="text-sm font-semibold text-text text-balance">设置</h1>
        </div>
        <div className="flex h-full [webkit-app-region:no-drag]">
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭设置"
            onClick={onClose}
            className="h-full w-11 rounded-none border-0 border-l border-titlebar-border hover:bg-surface-3/70"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      {/* ── 主体：左侧导航 + 右侧内容 ── */}
      <div className="grid grid-cols-[236px_minmax(0,1fr)] min-h-0 max-md:grid-cols-1">
        {/* ── 左侧导航（对齐 AionUi SettingsSider 风格） ── */}
        <nav className="pi-nav-panel flex flex-col gap-1 overflow-auto p-3" aria-label="设置导航">
          {navGroups.map((group, groupIdx) => (
            <div key={group.label} className={groupIdx === 0 ? '' : 'mt-4'}>
              {/* 分组标题：对齐 AionUi settings-sider__group-header */}
              <div className="px-3 pb-2 pt-1 text-xs font-[600] text-hint select-none">
                {group.label}
              </div>
              {group.items.map((item) => {
                const Icon = item.icon
                const active = section === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    aria-current={active ? 'page' : undefined}
                    data-tour={`nav-${item.id}`}
                    className={`group flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm text-left transition-[background-color,color,box-shadow,transform] active:scale-[0.97] ${
                      active
                        ? 'bg-primary/10 text-primary font-[650] shadow-[inset_3px_0_0_var(--color-primary)]'
                        : 'text-muted-foreground hover:bg-surface-2 hover:text-text'
                    }`}
                  >
                    <span
                      className={`flex size-7 shrink-0 items-center justify-center rounded-lg transition-[background-color,color] ${
                        active
                          ? 'bg-primary/10 text-primary'
                          : 'bg-surface-2 text-muted-foreground group-hover:text-text'
                      }`}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="truncate">{item.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        {/* ── 右侧内容区（统一卡片式布局） ── */}
        <main className="pi-settings-main overflow-auto min-w-0">
          {section === 'general' && <GeneralSettings />}
          {section === 'assistants' && <AssistantSettings />}
          {section === 'skills' && <SkillsSettings />}
          {section === 'providers' && <ProviderSettings />}
          {section === 'models' && <ModelsPage />}
          {section === 'agents' && <AgentPage />}
          {section === 'security' && <SecurityPage />}
          {section === 'cron' && <CronPage />}
          {section === 'about' && <AboutPage />}
        </main>
      </div>
    </div>
  )
}
