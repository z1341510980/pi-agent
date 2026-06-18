import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import type { AuthStorage, ModelRegistry, SessionManager, AgentSession } from '@earendil-works/pi-coding-agent'
import type { NodeConfig } from '@repo/config/shared'
import type { Gate } from '../tool/gate.js'
import type { EventBus } from '@repo/shared/events'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { CredentialBridge } from '../config/credential-bridge.js'
import type { ConfirmationManager } from '../tool/confirmation-manager.js'
import { EvidenceLedger, summarizeArgs, summarizeResult } from '../tool/evidence-ledger.js'
import { createBeforeToolCall } from '../tool/confirmation-tools.js'
import { StormBreaker } from '../tool/storm-breaker.js'
import { truncateOutput, shouldTruncate } from '../tool/output-truncator.js'
import { InstructionLoader } from './instruction-loader.js'

export interface PiSessionDeps {
  threadId: string
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
  sessionManager: SessionManager
  credentialBridge: CredentialBridge
  gate: Gate
  confirmationManager: ConfirmationManager
  eventBus: EventBus
  config: {
    cwd: string
    dataDir: string
    llm: NodeConfig['llm']
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
    if (provider === deps.config.llm.provider && deps.config.llm.apiKey) {
      return deps.config.llm.apiKey
    }
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

  // 4. 解析默认模型：严格遵守项目配置，避免历史临时 Provider 泄漏为默认值
  const defaultModel = deps.modelRegistry.find(deps.config.llm.provider, deps.config.llm.model)

  if (!defaultModel) {
    throw new AppError(
      ErrorCode.CONFIG_ERROR,
      `模型配置不可用：${deps.config.llm.provider}/${deps.config.llm.model}`,
      500,
      'Configured LLM model was not found in the Pi SDK model registry',
    )
  }

  // 5. 创建 Agent Session
  const { session } = await createAgentSession({
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    sessionManager: deps.sessionManager,
    resourceLoader,
    cwd: deps.config.cwd,
    model: defaultModel,
    ...(gateDeniedTools.length > 0 ? { excludeTools: gateDeniedTools } : {}),
  })

  // 6. 注入 beforeToolCall 钩子：Gate 权限检查 + 用户确认
  // 使用 Pi SDK 原生钩子，统一拦截所有工具调用（内置 + 扩展 + customTools）
  session.agent.beforeToolCall = createBeforeToolCall({
    threadId: deps.threadId,
    gate: deps.gate,
    confirmationManager: deps.confirmationManager,
  })

  // 7. 注入 afterToolCall 钩子：Evidence Ledger 记录 + EventBus 事件转发
  const evidenceLedger = new EvidenceLedger({
    threadId: deps.threadId,
    dataDir: deps.config.dataDir,
  })

  session.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
    // Evidence Ledger：记录工具调用证据
    evidenceLedger.record({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      argsSummary: summarizeArgs(
        (args && typeof args === 'object' && !Array.isArray(args))
          ? args as Record<string, unknown>
          : {},
      ),
      resultSummary: summarizeResult(result),
      isError,
    })

    // EventBus：转发工具执行结束事件
    deps.eventBus.emit('tool:execution:end', {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
    })

    // OutputTruncator：截断超长工具输出（32KB head+tail）
    // 在 afterToolCall 中修改 content，SDK 会将修改后的结果发送给 LLM
    let wasTruncated = false
    const truncatedContent = result.content.map((item) => {
      if (item.type === 'text' && shouldTruncate(item.text)) {
        wasTruncated = true
        const originalBytes = Buffer.byteLength(item.text, 'utf8')
        const truncatedText = truncateOutput(item.text)
        deps.eventBus.emit('tool:output:truncated', {
          threadId: deps.threadId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          originalBytes,
        })
        return { ...item, text: truncatedText }
      }
      return item
    })

    return wasTruncated ? { content: truncatedContent } : undefined
  }

  // 8. EventBus 集成：监听 session 事件，转发工具执行开始事件 + Storm Breaker 检测
  const stormBreaker = new StormBreaker()
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      const toolName = (event as { toolName?: string }).toolName ?? 'unknown'
      const toolCallId = (event as { toolCallId?: string }).toolCallId
      const rawArgs = (event as { args?: unknown }).args

      deps.eventBus.emit('tool:execution:start', {
        toolName,
        toolCallId,
      })

      // Storm Breaker：检测工具调用死循环
      const argsRecord = toRecord(rawArgs)
      if (stormBreaker.recordAndCheck(toolName, argsRecord)) {
        deps.eventBus.emit('tool:storm:detected', {
          threadId: deps.threadId,
          toolName,
          toolCallId,
          stats: stormBreaker.getStats(deps.threadId),
        })
      }
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

/** 将未知值转换为 Record，非对象或数组返回空对象 */
function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}
