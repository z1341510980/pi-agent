import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { UsageLedger } from '../core/usage/usage-ledger.js'
import { createModuleLogger } from '../lib/logger.js'

/** LLM 调用完成事件的结构化类型 */
export interface LlmCallCompleteEvent {
  sessionId: string
  threadId: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  durationMs: number
  agentId?: string
}

/**
 * UsageLedger 插件
 * - 创建 UsageLedger 实例
 * - 监听 EventBus 的 llm:call_complete 事件，自动记录用量
 * - 挂载到 Fastify 实例
 */
export const usageLedgerPlugin: FastifyPluginAsync = fp(async (app) => {
  const log = createModuleLogger(app.log, 'usage-ledger')
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
  const ledger = new UsageLedger(dataDir)

  // 监听 LLM 调用完成事件
  app.eventBus.on('llm:call_complete', async (event: LlmCallCompleteEvent) => {
    try {
      await ledger.record({
        sessionId: event.sessionId,
        threadId: event.threadId,
        model: event.model,
        provider: event.provider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        costUsd: 0, // 由 ledger.record 内部计算
        durationMs: event.durationMs,
        agentId: event.agentId ?? 'default',
      })
    } catch (err) {
      log.error({ err }, '记录 LLM 用量失败')
    }
  })

  app.decorate('usageLedger', ledger)
  app.addHook('onClose', () => ledger.close())
})
