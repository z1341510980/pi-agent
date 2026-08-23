import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { Home, MessageSquare, SettingsIcon, PlugIcon } from 'lucide-react'
import { browserConfig, initEmbeddedServerPort } from '@repo/config/browser'
import { I18nProvider } from './i18n'
import { ThemeProvider } from './components/theme-provider'
import { TooltipProvider } from './components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { ChatWorkspace } from './components/chat/chat-workspace'
import { SettingsPage } from './components/settings/settings-page'
import { PluginPage } from './components/settings/plugin-page'
import { HomePage } from './components/home/home-page'
import { ErrorBoundary } from './components/overlays/error-boundary'
import { UpdateDialog, useUpdateStatus } from './components/overlays/update-dialog'
import { Toaster } from '@/components/ui/toaster'
import { OnboardingProvider, OnboardingRailButton, useOnboardingStore } from './onboarding'
import { SlotProvider } from './core'
import { SlotRenderer } from './components/slot'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000
    }
  }
})

/**
 * 顶级视图。
 *
 * 宿主固定页是封闭集合；`plugin:<contributionId>` 形态的视图由 workspace.main
 * slot 的插件贡献提供（研究文档 §10.13：导航与主工作区交给注册表投影，
 * home/chat/settings 仍是宿主固定页）。
 */
type AppView = 'home' | 'chat' | 'settings' | 'plugins' | `plugin:${string}`

/** 引导只认识四个宿主页面；插件页与插件管理页都归到 home。 */
function onboardingView(view: AppView): 'home' | 'chat' | 'novel' | 'settings' {
  if (view === 'chat' || view === 'settings') return view
  if (view === 'plugin:novel') return 'novel'
  return 'home'
}

export default function App(): ReactElement {
  const [view, setView] = useState<AppView>('home')
  const [autoUpdateDialogOpen, setAutoUpdateDialogOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const { status, download, install } = useUpdateStatus()
  const onboardingSetView = (next: 'home' | 'chat' | 'novel' | 'settings'): void => {
    setView(next === 'novel' ? 'plugin:novel' : next)
  }

  useEffect(() => {
    initEmbeddedServerPort().finally(() => setReady(true))
  }, [])

  useEffect(() => {
    if (status.state === 'available') {
      setAutoUpdateDialogOpen(true)
    }
  }, [status.state])

  useEffect(() => {
    if (!ready || !useOnboardingStore.getState().shouldAutoStart()) return
    const timer = setTimeout(() => useOnboardingStore.getState().startTour('home-tour'), 500)
    return () => clearTimeout(timer)
  }, [ready])

  if (!ready) {
    return <div className="h-screen w-screen bg-app-bg" />
  }

  return (
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ThemeProvider>
              <TooltipProvider>
                <SlotProvider>
                  <OnboardingProvider setView={onboardingSetView}>
                    <div className="flex h-screen w-screen overflow-hidden bg-app-bg">
                      <nav
                        className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--dsw-alias-border-l1)] bg-sidebar-fill py-2"
                        aria-label="主导航"
                      >
                        <RailButton
                          icon={Home}
                          label="首页"
                          active={view === 'home'}
                          onClick={() => setView('home')}
                        />
                        <RailButton
                          icon={MessageSquare}
                          label="对话工作台"
                          active={view === 'chat'}
                          onClick={() => setView('chat')}
                        />
                        <RailButton
                          icon={PlugIcon}
                          label="插件"
                          active={view === 'plugins'}
                          onClick={() => setView('plugins')}
                        />
                        <SlotRenderer
                          name="sidebar.navigation"
                          fallback={null}
                          extraProps={{ onNavigate: setView, currentView: view }}
                        />
                        <OnboardingRailButton
                          setView={onboardingSetView}
                          currentView={onboardingView(view)}
                          className="mt-auto"
                        />
                        <RailButton
                          icon={SettingsIcon}
                          label="设置"
                          active={view === 'settings'}
                          onClick={() => setView('settings')}
                        />
                      </nav>

                      <div className="min-w-0 flex-1 overflow-hidden">
                        {view === 'settings' ? (
                          <SettingsPage onClose={() => setView('home')} />
                        ) : view === 'plugins' ? (
                          <PluginPage />
                        ) : view === 'chat' ? (
                          <ChatWorkspace
                            appName={browserConfig.appName}
                            config={browserConfig}
                            onOpenSettings={() => setView('settings')}
                          />
                        ) : view.startsWith('plugin:') ? (
                          // 插件贡献的工作区：workspace.main 是 keyed slot，
                          // entryKey 就是 view 里的贡献标识。宿主固定页（home/chat/
                          // settings/plugins remain host pages; plugin workspaces use the registry.
                          <SlotRenderer
                            name="workspace.main"
                            entryKey={view.slice('plugin:'.length)}
                            extraProps={{ onClose: () => setView('home') }}
                            fallback={
                              <div className="flex h-full items-center justify-center text-sm text-subtle">
                                该插件页面已不可用（插件可能已被禁用）
                              </div>
                            }
                          />
                        ) : (
                          <HomePage
                            onOpenChat={() => setView('chat')}
                            onOpenNovel={() => setView('plugin:novel')}
                            onOpenSettings={() => setView('settings')}
                          />
                        )}
                      </div>
                    </div>
                  </OnboardingProvider>
                </SlotProvider>
                <UpdateDialog
                  status={status}
                  open={autoUpdateDialogOpen}
                  onOpenChange={setAutoUpdateDialogOpen}
                  onDownload={() => void download()}
                  onInstall={() => void install()}
                />
                <Toaster />
              </TooltipProvider>
            </ThemeProvider>
          </I18nProvider>
        </QueryClientProvider>
      </MotionConfig>
    </ErrorBoundary>
  )
}

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
  className
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active: boolean
  onClick: () => void
  className?: string
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className={`relative size-9 ${className ?? ''} active:scale-[0.96] transition-[background-color,color,transform] ${
        active ? 'text-text' : 'text-subtle hover:text-text hover:bg-accent'
      }`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={label}
    >
      {active && (
        <span className="absolute left-0.5 top-1/2 -translate-y-1/2 size-1 rounded-full bg-info" />
      )}
      <Icon className="size-4" aria-hidden="true" />
    </Button>
  )
}
