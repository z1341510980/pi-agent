import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'
import type { ModelRuntime, AgentSession, SettingsManager, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { Gate } from '../tool/gate.js'
import type { EventBus } from '@repo/shared/events'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { ProviderConfigStore } from '../config/provider-config-store.js'
import type { ConfirmationManager } from '../tool/confirmation-manager.js'
import type { ThreadSettingsStore } from './thread-settings-store.js'
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
 * pi-coding-agent 的 7 个内置工具。
 *
 * 插件会话（小说创作）不需要读写文件或跑 shell —— 它只需要把提示词变成文本。
 * 这些工具的 schema 与使用说明会无条件进入每次请求，实测占 messages 的一半以上。
 *
 * 名单来自 `@earendil-works/pi-coding-agent/dist/core/tools/`：
 * bash / edit / find / grep / ls / read / write。
 * SDK 升级新增内置工具时这里需要同步 —— 漏掉只会少省一点，不会出错。
 */
const CODING_AGENT_BUILTIN_TOOLS = ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']

/**
 * 在指定 AgentConfig 上下文中执行函数。
 * 用于 subagent dispatchFn，使 createPiSession 能读取到 Agent 的身份/人格模板。
 */
export function withAgentConfig<T>(config: AgentConfig, fn: () => Promise<T>): Promise<T> {
  return agentConfigStorage.run(config, fn)
}

/**
 * 选择本次会话使用的 SessionManager（纯函数，便于单测）。
 *
 * - plugin:* 线程：每次新建独立 SessionManager（避免跨 Agent 历史泄漏）；
 * - chat 线程 + resumePath：SessionManager.open 恢复既有 JSONL（方案 §9.4）；
 * - 其余 chat 线程：复用共享 sessionManager。
 */
export function selectSessionManager(input: {
  isPluginThread: boolean
  resumePath?: string
  cwd: string
  sessionDir: string
  sharedSessionManager: SessionManager
  newId: () => string
  createManager: (cwd: string, sessionDir: string, meta: { id: string }) => SessionManager
  openManager: (path: string, sessionDir: string, cwdOverride: string) => SessionManager
}): SessionManager {
  if (input.isPluginThread) {
    return input.createManager(input.cwd, input.sessionDir, { id: input.newId() })
  }
  if (input.resumePath) {
    return input.openManager(input.resumePath, input.sessionDir, input.cwd)
  }
  return input.sharedSessionManager
}

export interface PiSessionDeps {
  threadId: string
  /**
   * SDK 0.84 的模型/凭证运行时（取代 AuthStorage + ModelRegistry）。
   *
   * Provider 的 API Key 在 provider.route / pi-sdk.plugin 注册点通过
   * modelRuntime.setRuntimeApiKey 注入；会话创建直接消费该运行时。
   */
  modelRuntime: ModelRuntime
  sessionManager: SessionManager
  settingsManager: SettingsManager
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
  /**
   * 每个 thread 独立的设置存储（用于读取当前 thread 的 thinkingLevel）。
   * 若提供：createPiSession 会按 threadId 读取并透传给 createAgentSession。
   * 若未提供：thinkingLevel 留空，由 SDK 走自身默认（SettingsManager.defaultThinkingLevel）。
   */
  threadSettingsStore?: ThreadSettingsStore
  /**
   * 恢复路径（方案 §9.4 会话身份索引 P0）。
   *
   * chat 线程在注册表命中历史会话路径时，由 PiSessionStore 传入；
   * createPiSession 据此用 SessionManager.open 打开既有 JSONL，恢复原会话历史。
   * plugin:* 线程永远不传（每次新建）。
   */
  resumePath?: string
  config: {
    cwd: string
    dataDir: string
  }
}

/**
 * createPiSession：创建 Pi SDK Agent Session
 *
 * API Key 注入：Provider 注册点在 modelRuntime.setRuntimeApiKey 注入（SDK 0.84）
 * Gate 集成：通过 excludeTools 参数排除被禁止的工具
 * EventBus 集成：通过 session.subscribe 监听工具执行事件
 */
export async function createPiSession(deps: PiSessionDeps): Promise<AgentSession> {
  // SDK 0.84：API Key 由 modelRuntime 承载（provider.route / pi-sdk.plugin 在
  // 注册点 setRuntimeApiKey），会话创建不再需要 fallback resolver。

  /**
   * 插件会话（小说创作等）与 chat 会话的能力需求完全不同。
   *
   * `plugin:*` 线程是「让 LLM 按提示词产出文本」的一次性调用，不需要编码 agent 的
   * 那套底座：内置文件/shell 工具、skills 清单、项目上下文文件、扩展、提示词模板。
   * 而 chat 线程恰恰要靠这些干活。
   *
   * 之前两者共用同一份 ResourceLoader 与工具集，代价实测出来了：小说的每一次
   * LLM 往返都固定附带约 1.3–1.7 万字符与自身提示词无关的内容，占 messages 的
   * 63%（第 3 章 11 次往返 ≈ 16 万字符白付）。这些内容对写小说不产生任何作用。
   *
   * 判断依据沿用文件下方已有的同一条：threadId 前缀。
   */
  const isPluginThread = deps.threadId.startsWith('plugin:')

  // 2. 资源加载器
  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.config.cwd,
    agentDir: deps.config.dataDir,
    systemPromptOverride: () => buildSystemPrompt(deps),
    // 插件会话不扫描环境中的这些资源：它们只会进系统提示词，不会被用到。
    // Skill 是例外：仍保持 noSkills=true，但允许通过 AgentConfig.skillPaths
    // 定向加载本次调用显式授权的 SKILL.md，避免暴露用户/项目的全部 Skills。
    ...(isPluginThread
      ? {
          noSkills: true,
          noContextFiles: true,
          noExtensions: true,
          noPromptTemplates: true,
          additionalSkillPaths: agentConfigStorage.getStore()?.skillPaths ?? [],
        }
      : {}),
  })
  await resourceLoader.reload()

  // 3. Gate 集成：获取被禁止的工具列表
  const gateDeniedTools = deps.gate.getDeniedTools()

  /**
   * 插件会话额外排除 pi-coding-agent 的 7 个内置工具。
   *
   * 排除的不只是 schema，还有 SDK 为它们生成的使用说明 —— 后者是上面那 1.3–1.7 万
   * 字符里的主要部分（实测：挂 4 个工具的 Agent 每往返 1.35 万字符，挂 6 个的 1.73 万，
   * 正相关）。
   *
   * ⚠️ 前提：插件侧的 Agent 只用 `novel_*` 业务工具。这一点在 novel-agents.ts 的
   * 工具白名单里成立（5 个 Agent 挂的全是 novel_*）。若将来有插件 Agent 需要读文件，
   * 应该给它一个业务工具，而不是把整套编码工具放回来。
   */
  const excludeTools = isPluginThread
    ? [...gateDeniedTools, ...CODING_AGENT_BUILTIN_TOOLS]
    : gateDeniedTools

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
      const candidateModel = deps.modelRuntime.getModel(provider.id, firstModel.id)
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

  // ⚠️ 工具化方案：从当前 AgentConfig 上下文读取 per-call 注入的 extraTools。
  // extraTools 携带 execute 实现（闭包绑定 draft），直接加入 customTools，
  // 让 LLM 能看到并调用 novel_submit_narrative_task / novel_apply_revision / novel_submit_review。
  // 这些工具不进入全局 pluginSessionTools（避免闭包状态污染跨 session），
  // 而是通过 withAgentConfig 在本次 session 创建期间临时注入。
  //
  // 去重：extraTools 可能同时包含
  //   - 闭包工具（如 novel_submit_narrative_task，不在 pluginSessionTools 中，需新增）
  //   - 已注册工具的副本（如 novel_save_chapter，已存在于 pluginSessionTools 中）
  // 后者是因为 NovelOrchestrator.runAgent 把 finalTools = [...filteredTools, ...闭包工具]
  // 整体作为 options.tools 传入 createSession，plugin-manager.ts 把 options.tools 整体作为
  // extraTools 透传，导致 filteredTools 的副本同时出现在 pluginSessionTools 和 extraTools 中。
  // 保留 pluginSessionTools 中的原始实例（稳定注册、跨 session 复用），跳过 extraTools 中的同名副本。
  // 注意：必须在白名单过滤之前加入，否则会被 tools 白名单过滤掉。
  const agentConfigForExtra = agentConfigStorage.getStore()
  if (agentConfigForExtra?.extraTools && agentConfigForExtra.extraTools.length > 0) {
    const existingNames = new Set(customTools.map(t => t.name))
    for (const tool of agentConfigForExtra.extraTools) {
      if (!existingNames.has(tool.name)) {
        customTools.push(tool)
        existingNames.add(tool.name)
      }
    }
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
  //
  //     ⚠️ 工具化方案豁免：extraTools 中的工具不被白名单过滤。
  //     extraTools 是 orchestrator 显式注入的 per-call 闭包工具（如 novel_submit_narrative_task
  //     绑定 draft 对象），其实例不在 AgentConfig.tools 白名单中（白名单只覆盖静态注册的
  //     pluginSessionTools）。若把 extraTools 也按白名单过滤，会移除闭包工具，导致
  //     Director LLM 看不到 novel_submit_narrative_task，只能输出文本"已通过工具提交"
  //     但实际没调用工具（fallback 到 narrative_task_missing 错误）。
  //     做法：先记录 extraTools 的名字集合，过滤时跳过这些工具。
  const agentConfigForTools = agentConfigStorage.getStore()
  if (agentConfigForTools?.tools && Array.isArray(agentConfigForTools.tools)) {
    const allowedToolNames = new Set(agentConfigForTools.tools)
    const extraToolNames = new Set((agentConfigForTools.extraTools ?? []).map(t => t.name))
    for (let i = customTools.length - 1; i >= 0; i--) {
      const toolName = customTools[i].name
      // extraTools 豁免：orchestrator 显式注入的闭包工具不被白名单过滤
      if (extraToolNames.has(toolName)) continue
      if (!allowedToolNames.has(toolName)) {
        customTools.splice(i, 1)
      }
    }
  }

  // 6. 选择 SessionManager：
  //    - plugin:* 线程每次创建独立 SessionManager，避免不同 Agent 调用共享同一 Pi SDK 会话树，
  //      从而防止历史消息（含 tool 消息）跨 Agent 泄漏，导致网关报 400。
  //    - chat 线程在提供 resumePath 时用 SessionManager.open 打开既有 JSONL
  //      （方案 §9.4：重启/LRU 淘汰后恢复原会话）；否则复用共享 sessionManager。
  const sessionManager = selectSessionManager({
    isPluginThread,
    resumePath: deps.resumePath,
    cwd: deps.config.cwd,
    sessionDir:
      typeof deps.sessionManager.getSessionDir === 'function'
        ? deps.sessionManager.getSessionDir()
        : join(deps.config.dataDir, 'agent', 'sessions'),
    sharedSessionManager: deps.sessionManager,
    newId: () => randomUUID(),
    createManager: (cwd, dir, meta) => SessionManager.create(cwd, dir, meta),
    openManager: (path, dir, cwdOverride) => SessionManager.open(path, dir, cwdOverride),
  })

  // 7. 创建 Agent Session
  const thinkingLevel: ThinkingLevel | undefined = deps.threadSettingsStore
    ? deps.threadSettingsStore.getThinkingLevel(deps.threadId)
    : undefined

  const { session } = await createAgentSession({
    modelRuntime: deps.modelRuntime,
    sessionManager,
    settingsManager: deps.settingsManager,
    resourceLoader,
    cwd: deps.config.cwd,
    model: defaultModel,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(customTools.length > 0 ? { customTools } : {}),
    ...(excludeTools.length > 0 ? { excludeTools } : {}),
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
        const modelInfo = deps.modelRuntime.getModel(msg.provider as string, msg.model as string)
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

  parts.push('你是 Wenlang Agent，一个智能编程助手。')

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
