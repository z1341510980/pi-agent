import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { browserConfig } from '@repo/config/browser'
import { ChatWorkspace } from './components/chat/chat-workspace'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000
    }
  }
})

export default function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatWorkspace appName={browserConfig.appName} config={browserConfig} />
    </QueryClientProvider>
  )
}
