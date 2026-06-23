/**
 * 记忆系统 API 路由
 *
 * 端点：
 * - GET    /api/memory/facts        — 列出事实（支持 ?tag=xxx&limit=10&offset=0）
 * - GET    /api/memory/facts/:id    — 获取单个事实
 * - POST   /api/memory/facts        — 添加事实
 * - DELETE /api/memory/facts/:id    — 删除事实
 * - POST   /api/memory/compile      — 触发记忆编译
 * - POST   /api/memory/reflect      — 记忆反思（shadow/write 双模式）
 * - GET    /api/memory/search       — 搜索事实（?q=xxx&tags=a,b）
 * - GET    /api/memory/summaries    — 列出会话摘要
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { executeMemorySearch, memorySearchSchema } from '../core/memory/memory-tools.js'
import { MemoryReflector } from '../core/memory/memory-reflection.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export const memoryRoute: FastifyPluginAsync = async (app) => {
  // 使用插件注册的单例存储实例
  const factStore = app.factStore
  const summaryStore = app.summaryStore
  // 记忆反思器（复用 FactStore 单例）
  const reflector = new MemoryReflector(factStore)

  // GET /api/memory/facts — 列出事实
  app.get('/api/memory/facts', async (request) => {
    const { tag, limit, offset } = request.query as { tag?: string; limit?: string; offset?: string }
    const result = await factStore.listFacts({
      tag,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })
    return success(result, request.traceId)
  })

  // GET /api/memory/facts/:id — 获取单个事实
  app.get('/api/memory/facts/:id', async (request) => {
    const { id } = request.params as { id: string }
    const fact = await factStore.getFact(id)
    if (!fact) {
      throw new AppError(ErrorCode.NOT_FOUND, '事实不存在', 404)
    }
    return success(fact, request.traceId)
  })

  // POST /api/memory/facts — 添加事实
  const addFactSchema = z.object({
    content: z.string().min(1),
    tags: z.array(z.string()).default([]),
    source: z.string().default('api'),
    confidence: z.number().min(0).max(1).default(0.5),
  })

  app.post('/api/memory/facts', async (request, reply) => {
    const input = validateBody(addFactSchema, request, reply)
    if (!input) return reply

    const id = await factStore.addFact(input)
    const fact = await factStore.getFact(id)
    return success(fact, request.traceId)
  })

  // DELETE /api/memory/facts/:id — 删除事实
  app.delete('/api/memory/facts/:id', async (request) => {
    const { id } = request.params as { id: string }
    await factStore.deleteFact(id)
    return success({ deleted: true }, request.traceId)
  })

  // POST /api/memory/compile — 触发记忆编译
  // 通过 EventBus 发送 memory:compile:requested 事件，由会话层异步执行编译
  app.post('/api/memory/compile', async (request) => {
    app.eventBus.emit('memory:compile:requested', {
      phase: 'manual',
    })
    return success({ triggered: true }, request.traceId)
  })

  // POST /api/memory/reflect — 记忆反思（shadow/write 双模式）
  // 参考 ARCHITECTURE.md §22.9
  const reflectSchema = z.object({
    mode: z.enum(['shadow', 'write']).default('shadow').describe('反思模式：shadow 仅对比不写入，write 对比并写入'),
    candidateFacts: z.array(z.object({
      content: z.string().min(1),
      tags: z.array(z.string()).default([]),
      source: z.string().default('reflection'),
      confidence: z.number().min(0).max(1).default(0.5),
      updateId: z.string().optional().describe('指定要更新的现有事实 ID'),
    })).min(1).describe('编译产出的候选事实'),
    testQuestions: z.array(z.string()).optional().describe('shadow 模式下的测试问题，用于检测事实丢失'),
  })

  app.post('/api/memory/reflect', async (request, reply) => {
    const input = validateBody(reflectSchema, request, reply)
    if (!input) return reply

    const result = await reflector.reflect(input)
    return success(result, request.traceId)
  })

  // GET /api/memory/search — 搜索事实
  app.get('/api/memory/search', async (request) => {
    const { q, tags } = request.query as { q?: string; tags?: string }
    const input = {
      query: q ?? '',
      tags: tags ? tags.split(',') : undefined,
      limit: 10,
    }
    const parsed = memorySearchSchema.safeParse(input)
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '搜索参数校验失败', 400)
    }
    const result = await executeMemorySearch(parsed.data, factStore)
    return success(result, request.traceId)
  })

  // GET /api/memory/summaries — 列出会话摘要
  app.get('/api/memory/summaries', async (request) => {
    const summaries = await summaryStore.listSummaries()
    return success(summaries, request.traceId)
  })

  // GET /api/memory/summaries/:sessionId — 获取指定会话的摘要
  app.get('/api/memory/summaries/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const summary = await summaryStore.getSummary(sessionId)
    return success(summary, request.traceId)
  })
}
