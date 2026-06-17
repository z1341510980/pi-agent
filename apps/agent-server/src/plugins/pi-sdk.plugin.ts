import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AuthStorage, ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent'
import { createModuleLogger } from '../lib/logger.js'

/**
 * Pi SDK 核心对象注册插件
 * 创建 AuthStorage、ModelRegistry、SessionManager 并挂载到 Fastify 实例
 *
 * 数据目录解析顺序：
 * 1. PI_DATA_DIR 环境变量（pi-agent 自定义）
 * 2. 默认 ~/.pi（与 Pi SDK 默认一致）
 *
 * 子目录结构：
 * - ${dataDir}/agent/auth.json     凭证存储
 * - ${dataDir}/agent/models.json   模型注册表
 * - ${dataDir}/agent/sessions/     会话持久化
 *
 * Provider 配置：
 * - DeepSeek：OpenAI 兼容 API，通过 PI_API_KEY_DEEPSEEK 或 PI_API_KEY 注入
 * - 其他 Provider：通过 PI_API_KEY_{PROVIDER} 或 PI_API_KEY 注入
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

  // 注册 DeepSeek Provider（OpenAI 兼容 API）
  // 通过环境变量 PI_API_KEY_DEEPSEEK 或 PI_API_KEY 注入 API Key
  const deepseekApiKey =
    process.env.PI_API_KEY_DEEPSEEK ?? process.env.PI_API_KEY
  const deepseekBaseUrl =
    process.env.PI_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  if (deepseekApiKey) {
    modelRegistry.registerProvider('deepseek', {
      name: 'DeepSeek',
      baseUrl: deepseekBaseUrl,
      apiKey: deepseekApiKey,
      api: 'openai-completions',
      authHeader: true,
      models: [
        {
          id: 'deepseek-chat',
          name: 'DeepSeek V3 Chat',
          reasoning: false,
          input: ['text'],
          cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
          contextWindow: 65536,
          maxTokens: 8192,
          compat: {
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
          },
        },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek R1 Reasoner',
          reasoning: true,
          input: ['text'],
          cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
          contextWindow: 65536,
          maxTokens: 8192,
          compat: {
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
            thinkingFormat: 'deepseek',
          },
        },
      ],
    })
    log.info('DeepSeek Provider 已注册（deepseek-chat, deepseek-reasoner）')
  } else {
    log.warn('PI_API_KEY_DEEPSEEK/PI_API_KEY 未设置，DeepSeek Provider 未注册')
  }

  // getApiKey 回调：从环境变量解析 API Key
  // 优先级：PI_API_KEY_${PROVIDER} > PI_API_KEY
  // 后续 P1 阶段会替换为 CredentialBridge（从 Electron safeStorage 获取）
  const getApiKey = async (provider: string): Promise<string | undefined> => {
    const envKey = `PI_API_KEY_${provider.toUpperCase().replace(/-/g, '_')}`
    const apiKey = process.env[envKey]
    if (apiKey) return apiKey
    return process.env.PI_API_KEY
  }
  app.decorate('getApiKey', getApiKey)

  log.info('Pi SDK 核心对象注册完成')
})
