import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { createModuleLogger } from '../lib/logger.js'
import { ProviderConfigStore } from '../core/config/provider-config-store.js'
import { ProxyConfigStore } from '../core/config/proxy-config-store.js'
import { ProxyManager } from '../core/config/proxy-manager.js'
import { setRuntimeLlmTimeoutMs } from '../config/performance.js'
import { normalizeProviderBaseUrl } from '../core/config/provider-base-url.js'

/**
 * Pi SDK 核心对象注册插件
 * 创建 AuthStorage、ModelRegistry、SessionManager 并挂载到 Fastify 实例
 *
 * 数据目录解析顺序：
 * 1. PI_DATA_DIR 环境变量（wenlang-agent 自定义）
 * 2. 默认 ~/.pi（与 Pi SDK 默认一致）
 *
 * 子目录结构：
 * - ${dataDir}/agent/auth.json     凭证存储
 * - ${dataDir}/agent/models.json   模型注册表
 * - ${dataDir}/agent/sessions/     会话持久化
 * - ${dataDir}/wenlang-agent.db         SQLite 数据库（providers、proxy_config 等表）
 *
 * Provider 配置：
 * - 所有 LLM Provider 配置由前端用户在设置页面配置
 * - 通过 POST /api/providers 注册到 ProviderConfigStore 和 ModelRegistry
 * - 不从环境变量读取 LLM_PROVIDER/LLM_MODEL/LLM_API_KEY
 * - 持久化到 SQLite providers 表（由 database.plugin 初始化的 app.db）
 *
 * 代理配置：
 * - 由前端用户在设置页面配置
 * - 通过 PUT /api/settings/proxy 注册到 ProxyConfigStore 并应用到全局 HTTP 客户端
 * - 持久化到 SQLite proxy_config 表（单行 id=1）
 */
export const piSdkPlugin: FastifyPluginAsync = fp(async (app) => {
  const log = createModuleLogger(app.log, 'pi-sdk')

  // 数据目录：优先 PI_DATA_DIR，回退到 ~/.pi
  const dataDir = process.env.PI_DATA_DIR ?? join(homedir(), '.pi')
  // agent 子目录（与 Pi SDK getAgentDir() 默认结构对齐）
  const agentDir = join(dataDir, 'agent')
  const authPath = join(agentDir, 'auth.json')
  const modelsJsonPath = join(agentDir, 'models.json')
  const sessionDir = join(agentDir, 'sessions')
  // 工作目录：默认为当前进程 cwd
  const cwd = process.env.PI_CWD ?? process.cwd()

  log.info(`Pi SDK 数据目录：${dataDir}`)
  log.info(`Pi SDK 工作目录：${cwd}`)

  // AuthStorage：凭证存储（API Key、OAuth Token）
  // AuthStorage.create 会在目录不存在时自动创建，并初始化空 auth.json
  const authStorage = AuthStorage.create(authPath)
  app.decorate('authStorage', authStorage)

  // ModelRegistry：模型注册表（内置模型 + models.json 自定义模型）
  // 文件不存在时返回空自定义模型列表，仅加载内置模型
  const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath)
  app.decorate('modelRegistry', modelRegistry)

  // SessionManager：会话管理（JSONL 持久化、树结构、分支、Compaction）
  // SessionManager.create 会创建 sessionDir 并初始化新会话文件
  const sessionManager = SessionManager.create(cwd, sessionDir)
  app.decorate('sessionManager', sessionManager)

  // 共享 Pi 设置管理器：Provider 请求超时等配置由设置页持久化，所有新会话实时读取
  const settingsManager = SettingsManager.create(cwd, agentDir)
  app.decorate('settingsManager', settingsManager)
  setRuntimeLlmTimeoutMs(settingsManager.getHttpIdleTimeoutMs())

  // ProviderConfigStore：前端动态注册的 Provider 配置
  // 所有 LLM 配置由前端用户在设置页面配置，不读取环境变量
  // 持久化到 SQLite providers 表（app.db），进程重启后自动恢复
  const providerConfigStore = new ProviderConfigStore(app.db)
  app.decorate('providerConfigStore', providerConfigStore)

  // ProxyConfigStore：出站代理配置
  // 持久化到 SQLite proxy_config 表（app.db，单行 id=1），进程重启后自动恢复
  const proxyConfigStore = new ProxyConfigStore(app.db)
  app.decorate('proxyConfigStore', proxyConfigStore)

  // ProxyManager：代理管理器，应用到全局 HTTP 客户端（undici）
  const proxyManager = new ProxyManager()
  app.decorate('proxyManager', proxyManager)

  // 启动时从持久化存储恢复 Provider 配置到 ModelRegistry 和 AuthStorage
  // 这样进程重启后无需用户重新配置 Provider
  const restoredProviders = providerConfigStore.list()
  if (restoredProviders.length > 0) {
    for (const config of restoredProviders) {
      // 注册到 ModelRegistry
      modelRegistry.registerProvider(config.id, {
        name: config.name,
        baseUrl: normalizeProviderBaseUrl(config.api, config.baseUrl),
        apiKey: config.apiKey,
        api: config.api,
        authHeader: config.authHeader ?? true,
        models: config.models.map((m) => {
          const cost = m.cost ?? { input: 0, output: 0 }
          return {
            id: m.id,
            name: m.name,
            reasoning: m.reasoning ?? false,
            input: ['text'] as const,
            cost: {
              input: cost.input ?? 0,
              output: cost.output ?? 0,
              cacheRead: cost.cacheRead ?? 0,
              cacheWrite: cost.cacheWrite ?? 0,
            },
            contextWindow: m.contextWindow ?? 32768,
            maxTokens: m.maxTokens ?? 8192,
          }
        }),
      })
      // 注入 API Key 到 AuthStorage
      authStorage.setRuntimeApiKey(config.id, config.apiKey)
    }
    log.info(`已从 SQLite 恢复 ${restoredProviders.length} 个 Provider 配置`)
  }

  // 启动时恢复代理配置并应用到全局 HTTP 客户端
  const restoredProxy = proxyConfigStore.get()
  const proxyResult = proxyManager.apply(restoredProxy)
  if (proxyResult.applied) {
    log.info(
      { mode: restoredProxy.mode, effectiveProxyUrl: proxyResult.effectiveProxyUrl },
      '代理配置已从 SQLite 恢复并应用'
    )
  } else {
    log.warn(
      { mode: restoredProxy.mode, error: proxyResult.error },
      '代理配置恢复失败'
    )
  }

  // getApiKey 回调：仅从 ProviderConfigStore 读取 API Key
  // 不再从环境变量读取，LLM 配置完全由前端用户配置
  const getApiKey = async (provider: string): Promise<string | undefined> => {
    return providerConfigStore.getApiKey(provider)
  }
  app.decorate('getApiKey', getApiKey)

  log.info('Pi SDK 核心对象注册完成（LLM 配置由前端用户配置，不读取环境变量）')
})
