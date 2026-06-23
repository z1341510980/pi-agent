import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import type { AuthStorage, ModelRegistry, SessionManager, AgentSession } from '@earendil-works/pi-coding-agent'
import type { Gate } from '../tool/gate.js'
import type { EventBus } from '@repo/shared/events'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { CredentialBridge } from '../config/credential-bridge.js'
import type { ProviderConfigStore } from '../config/provider-config-store.js'
import type { ConfirmationManager } from '../tool/confirmation-manager.js'
import { EvidenceLedger, summarizeArgs, summarizeResult } from '../tool/evidence-ledger.js'
import { createBeforeToolCall } from '../tool/confirmation-tools.js'
import { StormBreaker } from '../tool/storm-breaker.js'
import { truncateOutput, shouldTruncate } from '../tool/output-truncator.js'
import { InstructionLoader } from './instruction-loader.js'
import type { FactStore } from '../memory/fact-store.js'
import { MemoryTicker } from '../memory/memory-ticker.js'

export interface PiSessionDeps {
  threadId: string
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
  sessionManager: SessionManager
  credentialBridge: CredentialBridge
  providerConfigStore: ProviderConfigStore
  gate: Gate
  confirmationManager: ConfirmationManager
  eventBus: EventBus
  /** 获取 Provider 的 API Key（用于检查 Provider 是否可用） */
  getApiKey: (provider: string) => Promise<string | undefined>
  /** 共享的 FactStore 单例（由 memoryStorePlugin 提供） */
  factStore?: FactStore
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
  // 1. 注入 API Key 桥接：ProviderConfigStore → AuthStorage fallback resolver
  //    LLM 配置完全由前端用户配置，不读取任何环境变量
  deps.authStorage.setFallbackResolver((provider: string) => {
    return deps.providerConfigStore.getApiKey(provider)
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

  // 4. 解析默认模型：完全从 ProviderConfigStore（前端用户配置）获取
  //    不再从环境变量读取 LLM_PROVIDER/LLM_MODEL
  let defaultModel = undefined
  const providers = deps.providerConfigStore.list()
  for (const provider of providers) {
    const firstModel = provider.models[0]
    if (firstModel) {
      const candidateModel = deps.modelRegistry.find(provider.id, firstModel.id)
      const candidateApiKey = await deps.getApiKey(provider.id)
      if (candidateModel && candidateApiKey) {
        defaultModel = candidateModel
        break
      }
    }
  }

  if (!defaultModel) {
    throw new AppError(
      ErrorCode.CONFIG_ERROR,
      '未找到已配置的 Provider。请在设置中配置 Provider（含 API Key 和模型）后再开始对话。',
      500,
      'No provider is configured. Please configure a provider in Settings before starting a conversation.',
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
    deps.eventBus.emit('devlog:entry', {
      level: 'debug',
      message: `工具调用结束: ${toolCall.name}`,
      source: 'agent',
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
        deps.eventBus.emit('notification:push', {
          level: 'warning',
          title: '工具输出已截断',
          message: `${toolCall.name} 输出从 ${originalBytes} 字节截断`,
          category: 'tool',
          threadId: deps.threadId,
        })
        return { ...item, text: truncatedText }
      }
      return item
    })

    return wasTruncated ? { content: truncatedContent } : undefined
  }

  // 8. Memory 集成：使用共享的 FactStore 单例（如果提供）+ MemoryTicker
  const factStore = deps.factStore ?? null
  const memoryTicker = new MemoryTicker()

  // 9. EventBus 集成：监听 session 事件，转发工具执行开始事件 + Storm Breaker 检测 + Memory Ticker
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
      deps.eventBus.emit('devlog:entry', {
        level: 'debug',
        message: `工具调用开始: ${toolName}`,
        source: 'agent',
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
        deps.eventBus.emit('notification:push', {
          level: 'error',
          title: '检测到工具调用死循环',
          message: `${toolName} 已被 Storm Breaker 中止`,
          category: 'tool',
          threadId: deps.threadId,
        })
      }
    }

    // LLM 响应完成事件：发射 llm:call_complete 供 UsageLedger 记录
    if (event.type === 'message_end') {
      const msg = (event as unknown as { message?: Record<string, unknown> }).message
      if (msg && msg.role === 'assistant') {
        const usage = msg.usage as Record<string, unknown> | undefined
        deps.eventBus.emit('llm:call_complete', {
          sessionId: session.sessionId,
          threadId: deps.threadId,
          model: msg.model as string,
          provider: msg.provider as string,
          inputTokens: (usage?.input as number) ?? 0,
          outputTokens: (usage?.output as number) ?? 0,
          cacheReadTokens: (usage?.cacheRead as number) ?? undefined,
          cacheWriteTokens: (usage?.cacheWrite as number) ?? undefined,
          durationMs: 0, // Pi SDK 不提供单次调用耗时
          agentId: 'default',
        })
        deps.eventBus.emit('devlog:entry', {
          level: 'debug',
          message: `LLM 调用完成: ${msg.provider as string}/${msg.model as string}`,
          source: 'llm',
        })
      }
    }

    // 对话轮次结束事件：记录 MemoryTicker
    if (event.type === 'turn_end') {
      if (memoryTicker.recordTurn()) {
        deps.eventBus.emit('memory:compile:requested', {
          threadId: deps.threadId,
          phase: 'turn_threshold',
        })
        deps.eventBus.emit('devlog:entry', {
          level: 'info',
          message: `记忆编译已触发（阶段：turn_threshold）`,
          source: 'memory',
        })
        // 标记已编译，重置计数器
        memoryTicker.markCompiled()
      }
    }
  })

  return session
}

function buildSystemPrompt(deps: PiSessionDeps): string {
  const parts: string[] = []

  parts.push('你是 Pi Agent，一个智能编程助手。')

  // 注入运行环境信息，避免 LLM 在 Windows 上生成 bash 不兼容的 PowerShell 命令
  const platform = process.platform
  const isWindows = platform === 'win32'
  const shellInfo = isWindows
    ? '当前运行在 Windows 系统上。bash 工具使用 Git Bash（/usr/bin/bash），请使用 Unix/bash 语法（如 ls、cat、grep），不要使用 PowerShell 语法（如 Get-ChildItem、Select-Object、Get-Content）。如需 Windows 特定操作，使用 cmd 语法（如 dir、type）。'
    : `当前运行在 ${platform === 'darwin' ? 'macOS' : 'Linux'} 系统上，bash 工具使用标准 Unix shell。`
  parts.push(`\n## 运行环境\n${shellInfo}`)

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
