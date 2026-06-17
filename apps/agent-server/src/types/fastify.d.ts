import 'fastify'
import type { EventBus } from '@repo/shared/events'
import type { PiAgUiAgent } from '../core/agent/pi-agui-agent.js'
import type { PiSessionStore } from '../core/agent/session-store.js'

// Pi SDK 类型通过 any 声明，避免编译时依赖具体 SDK 类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAuthStorage = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiModelRegistry = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiSessionManager = any

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
  }

  interface FastifyInstance {
    authToken?: string
    authStorage: PiAuthStorage
    modelRegistry: PiModelRegistry
    sessionManager: PiSessionManager
    getApiKey: (provider: string) => Promise<string | undefined>
    eventBus: EventBus
    piAgUiAgent: PiAgUiAgent
    piSessionStore: PiSessionStore
  }
}
