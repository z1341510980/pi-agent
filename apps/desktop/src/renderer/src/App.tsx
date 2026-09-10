import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { Home, MessageSquare, SettingsIcon, PlugIcon } from 'lucide-react'
import { browserConfig, initEmbeddedServerPort } from '@repo/config/browser'
import { I18nProvider } from './i18n'
import { ThemeProvider } from './components/theme-provider'
import { TooltipProvider } from './components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { ChatWorkspace } from './components/chat/chat-workspace'
import { SettingsPage, type SettingsSection } from './components/settings/settings-page'
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
  // ── 常驻保活视图（chat / 插件工作区）──
  //
  // 进行中的流式 run、小说创作 SSE、相似度扫描、WebSocket 推送全部活在这两类
  // 工作区的组件树里；一旦卸载，状态即丢失，且后端对 SSE 断连的处理是直接取消
  // 流程（create-flow 等路由的 abortOnDisconnect）。因此访问过一次后就保持挂载，
  // 切换页面只隐藏不卸载。home/settings/plugins 无长连接状态，离开即卸载。
  const [persistentViews, setPersistentViews] = useState<AppView[]>([])
  // 设置页关闭时的回跳目标：进入 settings 前的视图。chat / plugin:* 都在
  // 保活数组里，回跳即恢复；重启后为 null，关闭设置默认回 home。
  const [returnTo, setReturnTo] = useState<AppView | null>(null)
  // 设置页初始分区种子：画布「打开设置」直达「插件设置 → 媒体生成」。
  // 仅作为 SettingsPage 挂载时的 initialSection，挂载后立即清除（见下方 effect）。
  const [settingsSeed, setSettingsSeed] = useState<SettingsSection | null>(null)
  const [autoUpdateDialogOpen, setAutoUpdateDialogOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const { status, download, install } = useUpdateStatus()
  // navigate 保持稳定引用（deps []），用 ref 追踪当前视图供 returnTo 记录来源
  const viewRef = useRef<AppView>('home')

  /** 带保活登记的导航：chat 与插件工作区进过一次就常驻 */
  const navigate = useCallback((next: AppView): void => {
    // 进设置时记下来源视图供关闭时回跳；已在 settings 内不覆盖（理论不可达）
    if (next === 'settings' && viewRef.current !== 'settings') {
      setReturnTo(viewRef.current)
    }
    viewRef.current = next
    setView(next)
    if (next === 'chat' || next.startsWith('plugin:')) {
      setPersistentViews((prev) => (prev.includes(next) ? prev : [...prev, next]))
    }
  }, [])

  // settingsSeed 消费即清：只在 SettingsPage 首次挂载的渲染里生效（useState 初值），
  // 避免后续从侧栏 / 首页等入口进设置时误落插件分区
  useEffect(() => {
    if (view === 'settings') setSettingsSeed(null)
  }, [view])

  const onboardingSetView = (next: 'home' | 'chat' | 'novel' | 'settings'): void => {
    navigate(next === 'novel' ? 'plugin:novel' : next)
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
                          onClick={() => navigate('home')}
                        />
                        <RailButton
                          icon={MessageSquare}
                          label="对话工作台"
                          active={view === 'chat'}
                          onClick={() => navigate('chat')}
                        />
                        <RailButton
                          icon={PlugIcon}
                          label="插件"
                          active={view === 'plugins'}
                          onClick={() => navigate('plugins')}
                        />
                        <SlotRenderer
                          name="sidebar.navigation"
                          fallback={null}
                          // 插件导航按钮统一走 navigate：plugin:* 视图需要登记保活
                          extraProps={{ onNavigate: navigate, currentView: view }}
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
                          onClick={() => navigate('settings')}
                        />
                      </nav>

                      <div className="min-w-0 flex-1 overflow-hidden">
                        {/*
                          常驻保活视图：已访问过的 chat / 插件工作区只隐藏不卸载。
                          hidden 属性让内容退出布局与可访问性树（测试里的 role 查询
                          也据此判定「不可见」），active prop 让隐藏的工作台让出全局按键。
                        */}
                        {persistentViews.map((persistentView) => (
                          <div
                            key={persistentView}
                            hidden={persistentView !== view}
                            className="h-full w-full"
                          >
                            {persistentView === 'chat' ? (
                              <ChatWorkspace
                                appName={browserConfig.appName}
                                config={browserConfig}
                                onOpenSettings={() => navigate('settings')}
                                active={view === 'chat'}
                              />
                            ) : (
                              // 插件贡献的工作区：workspace.main 是 keyed slot，
                              // entryKey 就是保活视图里的贡献标识。
                              <SlotRenderer
                                name="workspace.main"
                                entryKey={persistentView.slice('plugin:'.length)}
                                extraProps={{
                                  onClose: () => navigate('home'),
                                  // 「打开设置」直达设置页；画布入口额外带媒体生成
                                  // 分区种子（其余插件工作区不带 seed，落默认分区）
                                  onOpenSettings: () => {
                                    if (persistentView === 'plugin:infinite-canvas') {
                                      setSettingsSeed('plugin:infinite-canvas')
                                    }
                                    navigate('settings')
                                  },
                                  active: view === persistentView
                                }}
                                fallback={
                                  <div className="flex h-full items-center justify-center text-sm text-subtle">
                                    该插件页面已不可用（插件可能已被禁用）
                                  </div>
                                }
                              />
                            )}
                          </div>
                        ))}

                        {/* 轻量视图：无长连接状态，离开即卸载 */}
                        {view === 'home' && (
                          <HomePage
                            onOpenChat={() => navigate('chat')}
                            onOpenNovel={() => navigate('plugin:novel')}
                            onOpenSettings={() => navigate('settings')}
                          />
                        )}
                        {view === 'settings' && (
                          <SettingsPage
                            initialSection={settingsSeed ?? undefined}
                            onClose={() => navigate(returnTo ?? 'home')}
                          />
                        )}
                        {view === 'plugins' && <PluginPage />}
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
