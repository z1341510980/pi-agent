import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { BookOpen, Home, MessageSquare, SettingsIcon } from 'lucide-react'
import { browserConfig, initEmbeddedServerPort } from '@repo/config/browser'
import { I18nProvider } from './i18n'
import { ThemeProvider } from './components/theme-provider'
import { Button } from '@/components/ui/button'
import { ChatWorkspace } from './components/chat/chat-workspace'
import { SettingsPage } from './components/settings/settings-page'
import { NovelWorkspace } from './components/novel/novel-workspace'
import { HomePage } from './components/home/home-page'
import { ErrorBoundary } from './components/overlays/error-boundary'
import { UpdateDialog, useUpdateStatus } from './components/overlays/update-dialog'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000
    }
  }
})

type AppView = 'home' | 'chat' | 'settings' | 'novel'

export default function App(): ReactElement {
  const [view, setView] = useState<AppView>('home')
  const [autoUpdateDialogOpen, setAutoUpdateDialogOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const { status, download, install } = useUpdateStatus()

  // 初始化：获取嵌入式服务器端口
  useEffect(() => {
    initEmbeddedServerPort().finally(() => setReady(true))
  }, [])

  // 监听更新状态：发现新版本时自动弹出更新对话框
  useEffect(() => {
    if (status.state === 'available') {
      setAutoUpdateDialogOpen(true)
    }
  }, [status.state])

  if (!ready) {
    return <div className="h-screen w-screen bg-app-bg" />
  }

  return (
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ThemeProvider>
              <div className="flex h-screen w-screen overflow-hidden bg-app-bg">
                {/* ── 底座左边栏（导航 rail） ── */}
                <nav
                  className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-1 py-2"
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
                    icon={BookOpen}
                    label="小说创作"
                    active={view === 'novel'}
                    onClick={() => setView('novel')}
                  />
                  <RailButton
                    icon={SettingsIcon}
                    label="设置"
                    active={view === 'settings'}
                    onClick={() => setView('settings')}
                    className="mt-auto"
                  />
                </nav>

                {/* ── 内容区 ── */}
                <div className="min-w-0 flex-1 overflow-hidden">
                  {view === 'settings' ? (
                    <SettingsPage onClose={() => setView('home')} />
                  ) : view === 'novel' ? (
                    <NovelWorkspace onClose={() => setView('home')} />
                  ) : view === 'chat' ? (
                    <ChatWorkspace
                      appName={browserConfig.appName}
                      config={browserConfig}
                      onOpenSettings={() => setView('settings')}
                    />
                  ) : (
                    <HomePage
                      onOpenChat={() => setView('chat')}
                      onOpenNovel={() => setView('novel')}
                      onOpenSettings={() => setView('settings')}
                    />
                  )}
                </div>
              </div>
            {/* 自动更新对话框：发现新版本时自动展示 */}
            <UpdateDialog
              status={status}
              open={autoUpdateDialogOpen}
              onOpenChange={setAutoUpdateDialogOpen}
              onDownload={() => void download()}
              onInstall={() => void install()}
            />
            </ThemeProvider>
          </I18nProvider>
        </QueryClientProvider>
      </MotionConfig>
    </ErrorBoundary>
  )
}

// ── 导航 rail 按钮 ──

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
  className,
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
      className={`size-9 ${className ?? ''} active:scale-[0.96] transition-[background-color,color,transform] ${
        active
          ? 'bg-surface-3 text-text'
          : 'text-subtle hover:text-text hover:bg-surface-3'
      }`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={label}
    >
      <Icon className="size-4" aria-hidden="true" />
    </Button>
  )
}
