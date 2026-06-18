import type { ReactElement } from 'react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { browserConfig } from '@repo/config/browser'
import { ChatWorkspace } from './components/chat/chat-workspace'
import { SettingsPage } from './components/settings/settings-page'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000
    }
  }
})

type AppView = 'chat' | 'settings'

export default function App(): ReactElement {
  const [view, setView] = useState<AppView>('chat')

  return (
    <QueryClientProvider client={queryClient}>
      {view === 'settings' ? (
        <SettingsPage onClose={() => setView('chat')} />
      ) : (
        <ChatWorkspace
          appName={browserConfig.appName}
          config={browserConfig}
          onOpenSettings={() => setView('settings')}
        />
      )}
    </QueryClientProvider>
  )
}
