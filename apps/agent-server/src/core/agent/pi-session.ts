import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import type { AuthStorage, ModelRegistry, SessionManager, AgentSession } from '@earendil-works/pi-coding-agent'
import type { Gate } from '../tool/gate.js'
import type { EventBus } from '@repo/shared/events'
import type { CredentialBridge } from '../config/credential-bridge.js'
import { InstructionLoader } from './instruction-loader.js'

export interface PiSessionDeps {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
  sessionManager: SessionManager
  credentialBridge: CredentialBridge
  gate: Gate
  eventBus: EventBus
  config: {
    cwd: string
    dataDir: string
  }
}

/**
 * createPiSession：创建 Pi SDK Agent Session
 *
 * API Key 注入：通过 authStorage.setFallbackResolver 桥接 CredentialBridge
 * Gate 集成：通过 excludeTools 参数排除被禁止的工具
 * EventBus 集成：通过 session.subscribe 监听工具执行事件
 */
export async function createPiSession(deps: PiSessionDeps): Promise<AgentSession> {
  // 1. 注入 API Key 桥接：CredentialBridge → AuthStorage fallback resolver
  deps.authStorage.setFallbackResolver((provider: string) => {
    // 同步获取（setFallbackResolver 要求同步返回）
    // CredentialBridge.getApiKey 是异步的，但 fallback resolver 是同步的
    // 因此这里直接从环境变量读取（CredentialBridge 的环境变量逻辑）
    const envKey = `PI_API_KEY_${provider.toUpperCase().replace(/-/g, '_')}`
    const providerKey = process.env[envKey]
    if (providerKey) return providerKey
    return process.env.PI_API_KEY
  })

  // 2. 资源加载器
  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.config.cwd,
    agentDir: deps.config.dataDir,
    systemPromptOverride: () => buildSystemPrompt(deps),
  })
  await resourceLoader.reload()

  // 3. Gate 集成：获取被禁止的工具列表
  const gateDeniedTools = deps.gate.getDeniedTools()

  // 4. 创建 Agent Session
  const { session } = await createAgentSession({
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    sessionManager: deps.sessionManager,
    resourceLoader,
    cwd: deps.config.cwd,
    ...(gateDeniedTools.length > 0 ? { excludeTools: gateDeniedTools } : {}),
  })

  // 5. EventBus 集成：监听 session 事件，转发工具执行事件
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      deps.eventBus.emit('tool:execution:start', {
        toolName: (event as { toolName?: string }).toolName,
        toolCallId: (event as { toolCallId?: string }).toolCallId,
      })
    } else if (event.type === 'tool_execution_end') {
      deps.eventBus.emit('tool:execution:end', {
        toolName: (event as { toolName?: string }).toolName,
        toolCallId: (event as { toolCallId?: string }).toolCallId,
      })
    }
  })

  return session
}

function buildSystemPrompt(deps: PiSessionDeps): string {
  const parts: string[] = []

  parts.push('你是 Pi Agent，一个智能编程助手。')

  const loader = new InstructionLoader(deps.config.cwd)
  const instructions = loader.loadInstructions()
  if (instructions) {
    parts.push('\n## 项目指令\n')
    parts.push(instructions)
  }

  return parts.join('\n')
}
