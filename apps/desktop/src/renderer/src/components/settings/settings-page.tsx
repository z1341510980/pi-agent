import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
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
  PuzzleIcon,
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
import { PluginPage } from './plugin-page'
import { PluginSettingsSection, usePluginSettingsEntries } from './plugin-settings-section'

/** 宿主固定分区；插件声明分区以 `plugin:<pluginId>` 动态加入 */
export type SettingsSection =
  | 'general'
  | 'assistants'
  | 'skills'
  | 'providers'
  | 'models'
  | 'plugins'
  | 'agents'
  | 'security'
  | 'cron'
  | 'about'
  | `plugin:${string}`

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
 *   （媒体生成随 infinite-canvas 插件迁入「插件设置」分区）
 * - 插件设置：由插件声明（registerSettings / plugin-settings slot）动态生成
 * - 应用：通用设置 / 关于
 */
const hostNavGroups: NavGroup[] = [
  {
    label: 'AI 核心',
    items: [
      { id: 'assistants', label: '助手', icon: UsersIcon },
      { id: 'skills', label: '技能', icon: SparklesIcon },
      { id: 'providers', label: '模型与 Provider', icon: PlugIcon },
      { id: 'models', label: '模型管理', icon: LayersIcon },
      { id: 'plugins', label: '插件', icon: PlugIcon },
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
  // 插件声明驱动的动态分区：有设置声明（schema 或自定义面板）的插件各占一项
  const { entries: pluginSettingEntries } = usePluginSettingsEntries()
  const navGroups: NavGroup[] = useMemo(() => {
    const pluginGroup: NavGroup | null =
      pluginSettingEntries.length > 0
        ? {
            label: '插件设置',
            items: pluginSettingEntries.map((entry) => ({
              id: `plugin:${entry.pluginId}` as SettingsSection,
              label: entry.label,
              icon: PuzzleIcon
            }))
          }
        : null
    return pluginGroup ? [hostNavGroups[0], pluginGroup, hostNavGroups[1]] : hostNavGroups
  }, [pluginSettingEntries])

  return (
    <div
      className="grid grid-rows-[var(--titlebar-height)_minmax(0,1fr)] h-full overflow-hidden bg-app-bg text-text"
      aria-label="设置中心"
    >
      {/* ── 顶部标题栏 ── */}
      <header className="pi-glass-header flex items-center justify-between min-w-0 bg-titlebar-bg">
        <div className="flex items-center gap-3 h-full min-w-0 px-4 [webkit-app-region:drag]">
          <span className="flex size-7 items-center justify-center rounded-lg text-subtle">
            <SettingsIcon className="size-4" />
          </span>
          <h1 className="text-sm font-medium text-text text-balance">设置</h1>
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
        {/* ── 左侧导航（对齐 dsh SettingsRoot nav：188px 轨、r12 单元格） ── */}
        <nav className="pi-nav-panel flex flex-col gap-4 overflow-auto p-3" aria-label="设置导航">
          {navGroups.map((group, groupIdx) => (
            <div key={group.label} className={groupIdx === 0 ? '' : 'mt-2'}>
              {/* 分组标题 */}
              <div className="px-3 pb-1.5 pt-1 text-xs leading-4 text-subtle select-none">
                {group.label}
              </div>
              <div className="flex flex-col gap-1">
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
                      className={`flex h-10 w-full items-center gap-2 rounded-xl px-3 text-sm leading-[22px] text-left transition-colors ${
                        active
                          ? 'bg-[var(--color-sidebar-nav-active)] font-medium text-text'
                          : 'text-text hover:bg-[var(--color-sidebar-nav-hover)]'
                      }`}
                    >
                      <Icon className="size-4 shrink-0 text-subtle" aria-hidden="true" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* ── 右侧内容区（统一卡片式布局） ── */}
        <main className="pi-settings-main overflow-auto min-w-0">
          {section.startsWith('plugin:') ? (
            (() => {
              const entry = pluginSettingEntries.find(
                (candidate) => `plugin:${candidate.pluginId}` === section
              )
              return entry ? (
                <PluginSettingsSection entry={entry} />
              ) : (
                <div className="p-6 text-sm text-subtle">该插件当前未提供设置。</div>
              )
            })()
          ) : (
            <>
              {section === 'general' && <GeneralSettings />}
              {section === 'assistants' && <AssistantSettings />}
              {section === 'skills' && <SkillsSettings />}
              {section === 'providers' && <ProviderSettings />}
              {section === 'models' && <ModelsPage />}
              {section === 'plugins' && <PluginPage />}
              {section === 'agents' && <AgentPage />}
              {section === 'security' && <SecurityPage />}
              {section === 'cron' && <CronPage />}
              {section === 'about' && <AboutPage />}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
