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
 * - 每天自动清理 90 天前的记录
 * - 挂载到 Fastify 实例
 */
export const usageLedgerPlugin: FastifyPluginAsync = fp(async (app) => {
  const log = createModuleLogger(app.log, 'usage-ledger')
  const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`
  const ledger = new UsageLedger(dataDir)

  // 监听 LLM 调用完成事件（保存引用以便清理）
  const onLlmCallComplete = (event: LlmCallCompleteEvent) => {
    try {
      const cost = ledger.record({
        sessionId: event.sessionId,
        threadId: event.threadId,
        model: event.model,
        provider: event.provider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        durationMs: event.durationMs,
        agentId: event.agentId ?? 'default',
      })
      // 发射带 cost 的实时用量事件，供 websocket 推送
      app.eventBus.emit('usage:recorded', {
        ...event,
        cost,
      })
    } catch (err) {
      log.error({ err }, '记录 LLM 用量失败')
    }
  }

  app.eventBus.on('llm:call_complete', onLlmCallComplete)

  // 每天自动清理 90 天前的记录
  const pruneTimer = setInterval(() => {
    const removed = ledger.prune(90)
    if (removed > 0) {
      log.info({ removed }, '自动清理过期用量记录')
    }
  }, 24 * 60 * 60 * 1000)
  pruneTimer.unref() // 不阻止进程退出

  app.decorate('usageLedger', ledger)
  app.addHook('onClose', () => {
    clearInterval(pruneTimer)
    app.eventBus.off('llm:call_complete', onLlmCallComplete)
    ledger.close()
  })
})
