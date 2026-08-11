import 'fastify'
import type { EventBus } from '@repo/shared/events'
import type { PiAgUiAgent } from '../core/agent/pi-agui-agent.js'
import type { PiSessionStore } from '../core/agent/session-store.js'
import type { AgentManager } from '../core/agent/subagent-tool.js'
import type { AgentCallLogger } from '../core/agent/agent-call-logger.js'
import type { TeamManager } from '../core/agent/team-manager.js'
import type { ConfirmationManager } from '../core/tool/confirmation-manager.js'
import type { Gate } from '../core/tool/gate.js'
import type { UsageLedger } from '../core/usage/usage-ledger.js'
import type { FactStore } from '../core/memory/fact-store.js'
import type { SessionSummaryStore } from '../core/memory/session-summary.js'
import type { ProviderConfigStore } from '../core/config/provider-config-store.js'
import type { ProxyConfigStore } from '../core/config/proxy-config-store.js'
import type { ProxyManager } from '../core/config/proxy-manager.js'
import type { ThreadSettingsStore } from '../core/agent/thread-settings-store.js'
import type { SettingsManager } from '@earendil-works/pi-coding-agent'
import type { PluginManager } from '../core/plugin/plugin-manager.js'
import type { CronScheduler } from '../core/cron/cron-scheduler.js'
import type Database from 'better-sqlite3'

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
    authStorage: PiAuthStorage
    modelRegistry: PiModelRegistry
    sessionManager: PiSessionManager
    settingsManager: SettingsManager
    getApiKey: (provider: string) => Promise<string | undefined>
    eventBus: EventBus
    confirmationManager: ConfirmationManager
    piAgUiAgent: PiAgUiAgent
    piSessionStore: PiSessionStore
    gate: Gate
    usageLedger: UsageLedger
    factStore: FactStore
    summaryStore: SessionSummaryStore
    providerConfigStore: ProviderConfigStore
    proxyConfigStore: ProxyConfigStore
    proxyManager: ProxyManager
    threadSettingsStore: ThreadSettingsStore
    subagentManager: AgentManager
    teamManager: TeamManager
    agentCallLogger: AgentCallLogger
    pluginManager: PluginManager
    cronScheduler: CronScheduler
    db: Database.Database
  }
}
