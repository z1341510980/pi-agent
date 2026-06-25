import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { browserConfig, initEmbeddedServerPort } from '@repo/config/browser'
import { I18nProvider } from './i18n'
import { ThemeProvider } from './components/theme-provider'
import { ChatWorkspace } from './components/chat/chat-workspace'
import { SettingsPage } from './components/settings/settings-page'
import { NovelWorkspace } from './components/novel/novel-workspace'
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

type AppView = 'chat' | 'settings' | 'novel'

export default function App(): ReactElement {
  const [view, setView] = useState<AppView>('chat')
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
            {view === 'settings' ? (
              <SettingsPage onClose={() => setView('chat')} />
            ) : view === 'novel' ? (
              <NovelWorkspace onClose={() => setView('chat')} />
            ) : (
              <ChatWorkspace
                appName={browserConfig.appName}
                config={browserConfig}
                onOpenSettings={() => setView('settings')}
                onOpenNovel={() => setView('novel')}
              />
            )}
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
