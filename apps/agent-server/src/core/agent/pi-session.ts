import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'
import type { AuthStorage, ModelRegistry, AgentSession, SettingsManager, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
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
import type { AgentManager, AgentConfig } from './subagent-tool.js'
import { createSubagentTool, createSubagentReplyTool, createSubagentCloseTool } from './subagent-tool.js'
import type { TeamManager } from './team-manager.js'
import { createTeamExecuteTool } from './team-tool.js'

/**
 * AsyncLocalStorage：传递 subagent 的 AgentConfig 到 session factory
 *
 * dispatchFn 在调用 piSessionStore.getOrCreate 时设置此上下文，
 * createPiSession 中的 buildSystemPrompt 读取此上下文，将 identity/personality/systemPrompt
 * 注入到 subagent session 的系统提示词中。
 */
const agentConfigStorage = new AsyncLocalStorage<AgentConfig>()

/**
 * 在指定 AgentConfig 上下文中执行函数。
 * 用于 subagent dispatchFn，使 createPiSession 能读取到 Agent 的身份/人格模板。
 */
export function withAgentConfig<T>(config: AgentConfig, fn: () => Promise<T>): Promise<T> {
  return agentConfigStorage.run(config, fn)
}

export interface PiSessionDeps {
  threadId: string
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
  sessionManager: SessionManager
  settingsManager: SettingsManager
  credentialBridge: CredentialBridge
  providerConfigStore: ProviderConfigStore
  gate: Gate
  confirmationManager: ConfirmationManager
  eventBus: EventBus
  /** 获取 Provider 的 API Key（用于检查 Provider 是否可用） */
  getApiKey: (provider: string) => Promise<string | undefined>
  /** 共享的 FactStore 单例（由 memoryStorePlugin 提供） */
  factStore?: FactStore
  /** 共享的 SQLite 数据库连接（由 databasePlugin 提供） */
  db: Database.Database
  /** Subagent 管理器（由 subagentPlugin 提供，用于注入 customTools） */
  subagentManager?: AgentManager
  /** Team 管理器（由 teamPlugin 提供，用于注入 team_execute 工具） */
  teamManager?: TeamManager
  /** 插件注入的 Pi Session 工具（由 PluginManager 提供，用于注入 novel_* 等插件工具） */
  pluginSessionTools?: ToolDefinition[]
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
  //    用户在设置页指定的默认 Provider 排在最前优先选中；未指定时按插入顺序
  let defaultModel = undefined
  const defaultProviderId = deps.providerConfigStore.getDefaultProviderId()
  const providers = deps.providerConfigStore.list()
  // 排序：默认 Provider 排第一，其余保持原序
  if (defaultProviderId) {
    providers.sort((a, b) => {
      if (a.id === defaultProviderId) return -1
      if (b.id === defaultProviderId) return 1
      return 0
    })
  }
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

  // 5. 构建 customTools：subagent 系列工具 + team_execute 工具 + 小说工具
  const customTools: ToolDefinition[] = []
  if (deps.subagentManager) {
    customTools.push(
      createSubagentTool(deps.subagentManager),
      createSubagentReplyTool(deps.subagentManager),
      createSubagentCloseTool(deps.subagentManager),
    )
  }
  if (deps.teamManager) {
    customTools.push(createTeamExecuteTool(deps.teamManager))
  }
  if (deps.pluginSessionTools && deps.pluginSessionTools.length > 0) {
    customTools.push(...deps.pluginSessionTools)
  }

  // 5.1 工具权限过滤：若当前在 subagent 上下文中且 AgentConfig 声明了 tools，
  //     仅保留 allowed 列表中的工具。
  //     - dispatchFn 已将 systemPromptBuilder / toolFilter 的结果合并进 effectiveConfig.tools
  //     - 这使 subagent / team_execute 路径与 NovelOrchestrator.runAgent 的工具过滤行为一致
  //     - 未声明 tools（undefined，如默认 Agent）不做过滤，保留全部 customTools
  //     - 声明 tools=[]（空数组）表示"明确无工具"，清空 customTools
  //       （Writer/Reviewer 等纯生成 Agent 不需要工具，状态已通过 SEMI 层注入）
  //     - 声明 tools=[...] 表示白名单，仅保留列出的工具
  //     ⚠️ 之前用 `length > 0` 判断导致 tools=[] 被误解为"不过滤"，customTools 保留全部，
  //     LLM 看到全部 18 个工具可能误调写工具导致 messages 不一致 → 网关报 400。
  const agentConfigForTools = agentConfigStorage.getStore()
  if (agentConfigForTools?.tools && Array.isArray(agentConfigForTools.tools)) {
    const allowedToolNames = new Set(agentConfigForTools.tools)
    for (let i = customTools.length - 1; i >= 0; i--) {
      if (!allowedToolNames.has(customTools[i].name)) {
        customTools.splice(i, 1)
      }
    }
  }

  // 6. 选择 SessionManager：
  //    - plugin:* 线程每次创建独立 SessionManager，避免不同 Agent 调用共享同一 Pi SDK 会话树，
  //      从而防止历史消息（含 tool 消息）跨 Agent 泄漏，导致网关报 400。
  //    - 其他线程（chat）复用共享 sessionManager，保持多轮对话状态。
  const isPluginSession = deps.threadId.startsWith('plugin:')
  const sessionManager = isPluginSession
    ? SessionManager.create(
        deps.config.cwd,
        typeof deps.sessionManager.getSessionDir === 'function'
          ? deps.sessionManager.getSessionDir()
          : join(deps.config.dataDir, 'agent', 'sessions'),
        { id: randomUUID() },
      )
    : deps.sessionManager

  // 7. 创建 Agent Session
  const { session } = await createAgentSession({
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    sessionManager,
    settingsManager: deps.settingsManager,
    resourceLoader,
    cwd: deps.config.cwd,
    model: defaultModel,
    ...(customTools.length > 0 ? { customTools } : {}),
    ...(gateDeniedTools.length > 0 ? { excludeTools: gateDeniedTools } : {}),
  })

  // 7. 注入 beforeToolCall 钩子：Gate 权限检查 + 用户确认
  // 使用 Pi SDK 原生钩子，统一拦截所有工具调用（内置 + 扩展 + customTools）
  session.agent.beforeToolCall = createBeforeToolCall({
    threadId: deps.threadId,
    gate: deps.gate,
    confirmationManager: deps.confirmationManager,
  })

  // 8. 注入 afterToolCall 钩子：Evidence Ledger 记录 + EventBus 事件转发
  const evidenceLedger = new EvidenceLedger({
    threadId: deps.threadId,
    db: deps.db,
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

  // 9. Memory 集成：使用共享的 FactStore 单例（如果提供）+ MemoryTicker
  const factStore = deps.factStore ?? null
  const memoryTicker = new MemoryTicker()

  // 10. EventBus 集成：监听 session 事件，转发工具执行开始事件 + Storm Breaker 检测 + Memory Ticker
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
        const inputTokens = (usage?.input as number) ?? 0
        const outputTokens = (usage?.output as number) ?? 0
        const totalTokens = (usage?.totalTokens as number) ?? 0

        deps.eventBus.emit('llm:call_complete', {
          sessionId: session.sessionId,
          threadId: deps.threadId,
          model: msg.model as string,
          provider: msg.provider as string,
          inputTokens,
          outputTokens,
          cacheReadTokens: (usage?.cacheRead as number) ?? undefined,
          cacheWriteTokens: (usage?.cacheWrite as number) ?? undefined,
          durationMs: 0, // Pi SDK 不提供单次调用耗时
          agentId: 'default',
        })

        // 推送上下文占用更新：totalTokens 是当前上下文窗口的实际 token 占用
        // 同时从 modelRegistry 获取当前模型的 contextWindow
        const modelInfo = deps.modelRegistry.find(msg.provider as string, msg.model as string)
        const contextWindow = modelInfo?.contextWindow ?? 0

        deps.eventBus.emit('context:update', {
          threadId: deps.threadId,
          tokensUsed: totalTokens,
          inputTokens,
          outputTokens,
          model: msg.model as string,
          provider: msg.provider as string,
          contextWindow,
        })

        deps.eventBus.emit('devlog:entry', {
          level: 'debug',
          message: `LLM 调用完成: ${msg.provider as string}/${msg.model as string} (上下文 ${totalTokens} tokens)`,
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

  // 注入 subagent 的身份/人格模板（如果当前在 subagent 上下文中）
  const agentConfig = agentConfigStorage.getStore()
  if (agentConfig) {
    if (agentConfig.systemPrompt) {
      parts.push(`\n## Agent 自定义指令\n${agentConfig.systemPrompt}`)
    }
    if (agentConfig.identity) {
      parts.push(`\n## 身份\n${agentConfig.identity}`)
    }
    if (agentConfig.personality) {
      parts.push(`\n## 人格\n${agentConfig.personality}`)
    }
    if (agentConfig.name) {
      parts.push(`\n## 当前角色\n你当前作为 "${agentConfig.name}" 运行。${agentConfig.description ? `职责：${agentConfig.description}` : ''}`)
    }
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
