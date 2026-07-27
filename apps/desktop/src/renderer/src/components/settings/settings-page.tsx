import type { ReactElement } from 'react'
import { useState } from 'react'
import { XIcon, SettingsIcon, PlugIcon, LayersIcon, BotIcon, ShieldIcon, SlidersHorizontalIcon, InfoIcon, ClockIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProviderManager } from './provider-manager'
import { GeneralSettings } from './general-settings'
import { AboutPage } from './about-page'
import { SecurityPage } from './security-page'
import { AgentPage } from './agent-page'
import { ModelsPage } from './models-page'
import { CronPage } from './cron-page'

export type SettingsSection =
  | 'providers'
  | 'models'
  | 'agents'
  | 'security'
  | 'general'
  | 'cron'
  | 'about'

interface SettingsPageProps {
  onClose: () => void
}

interface NavItem {
  id: SettingsSection
  label: string
  icon: typeof SettingsIcon
}

const navItems: NavItem[] = [
  { id: 'providers', label: 'Provider 管理', icon: PlugIcon },
  { id: 'models', label: '模型管理', icon: LayersIcon },
  { id: 'agents', label: 'Agent 管理', icon: BotIcon },
  { id: 'security', label: '权限与安全', icon: ShieldIcon },
  { id: 'cron', label: '定时任务', icon: ClockIcon },
  { id: 'general', label: '通用设置', icon: SlidersHorizontalIcon },
  { id: 'about', label: '关于', icon: InfoIcon }
]

export function SettingsPage({ onClose }: SettingsPageProps): ReactElement {
  const [section, setSection] = useState<SettingsSection>('providers')

  return (
    <div
      className="grid grid-rows-[var(--titlebar-height)_minmax(0,1fr)] h-full overflow-hidden bg-app-bg text-text"
      aria-label="设置中心"
    >
      {/* ── 顶部标题栏 ── */}
      <header className="flex items-center justify-between min-w-0 bg-titlebar-bg border-b border-titlebar-border">
        <div className="flex items-center gap-3 h-full min-w-0 px-4 [webkit-app-region:drag]">
          <SettingsIcon className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold text-text">设置</h1>
        </div>
        <div className="flex h-full [webkit-app-region:no-drag]">
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭设置"
            onClick={onClose}
            className="h-full w-11 rounded-none border-0 border-l border-titlebar-border"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      {/* ── 主体：左侧导航 + 右侧内容 ── */}
      <div className="grid grid-cols-[240px_minmax(0,1fr)] min-h-0 max-md:grid-cols-1">
        {/* ── 左侧导航 ── */}
        <nav
          className="bg-surface-1 border-r border-border flex flex-col gap-1 p-3 overflow-auto"
          aria-label="设置导航"
        >
          <h2 className="px-3 pt-2 pb-3 text-base font-semibold text-text">设置</h2>
          {navItems.map((item) => {
            const Icon = item.icon
            const active = section === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                aria-current={active ? 'page' : undefined}
                data-tour={`nav-${item.id}`}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-left active:scale-[0.96] transition-[background-color,color,transform] ${
                  active
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-muted-foreground hover:bg-surface-2 hover:text-text'
                }`}
              >
                <Icon className={`size-4 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        {/* ── 右侧内容区 ── */}
        <main className="bg-app-bg overflow-auto min-w-0">
          {section === 'providers' && <ProviderManager />}
          {section === 'models' && <ModelsPage />}
          {section === 'agents' && <AgentPage />}
          {section === 'security' && <SecurityPage />}
          {section === 'cron' && <CronPage />}
          {section === 'general' && <GeneralSettings />}
          {section === 'about' && <AboutPage />}
        </main>
      </div>
    </div>
  )
}
