/** Entity maintenance routes: deduplication, similarity review and AI preview. */

import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { createNovelAgUiEmitter, createSseEmitterSink } from '../utils/sse-emitter.js'
import { modelSelectionSchema } from './model-selection-contract.js'

const deduplicateSchema = z.object({
  /** dryRun=true 只扫描返回报告，不实际合并；默认 false 实际执行 */
  dryRun: z.boolean().optional().default(false),
})

const mergeSimilaritySchema = z.object({
  groups: z.array(z.object({
    kind: z.enum(['character', 'conflict', 'foreshadow', 'faction', 'location', 'world_element']),
    reason: z.string().default(''),
    similarity: z.number().min(0).max(1).default(0),
    keptId: z.string(),
    removed: z.array(z.object({
      id: z.string(),
      name: z.string().default(''),
    })),
    fieldMerges: z.array(z.object({
      field: z.string(),
      fromId: z.string(),
      fromName: z.string().default(''),
      reason: z.string().default(''),
    })).optional().default([]),
  })),
})

const aiGenerateEntitySchema = z.object({
  entityType: z.enum(['character', 'conflict', 'foreshadow', 'faction', 'location', 'item', 'world_element']),
  coreStyle: z.string().min(1).max(500),
  modelId: modelSelectionSchema.optional(),
})

export function createEntityMaintenanceRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  return [
    {
      method: 'POST',
      path: '/projects/:projectId/entities/deduplicate',
      handler: async (request: any, reply: any) => {
        const input = validateBody(deduplicateSchema, request, reply)
        if (!input) return reply
        const report = store.deduplicateEntities(request.params.projectId, { dryRun: input.dryRun })
        return success(report, request.traceId)
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/entities/similarity-scan',
      handler: async (request: any, reply: any) => {
        const { projectId } = request.params
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': request.headers.origin || '*',
          'Access-Control-Allow-Credentials': 'true',
        })
        request.raw.socket?.setNoDelay?.(true)
        const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000)
        const emitter = createNovelAgUiEmitter(
          createSseEmitterSink((data) => reply.raw.write(data)),
          `novel:similarity:${projectId}`,
          randomUUID(),
        )
        try {
          const report = await services.similarityScanner.scan(projectId, (evt) => {
            emitter.progress({ type: 'phase_change', data: evt })
          })
          emitter.result({ status: 'completed', report })
        } catch (err) {
          emitter.error(String(err))
        } finally {
          clearInterval(heartbeat)
          reply.raw.end()
        }
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/entities/merge-similarity',
      handler: async (request: any, reply: any) => {
        const input = validateBody(mergeSimilaritySchema, request, reply)
        if (!input) return reply
        const result = store.mergeWithPlan(request.params.projectId, input.groups)
        return success({ totalMerged: result.totalMerged }, request.traceId)
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/entities/ai-generate',
      handler: async (request: any, reply: any) => {
        const input = validateBody(aiGenerateEntitySchema, request, reply)
        if (!input) return reply
        const stream = new PassThrough()
        reply.headers({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': request.headers.origin || '*',
          'Access-Control-Allow-Credentials': 'true',
        })
        const heartbeat = setInterval(() => stream.write(': keepalive\n\n'), 15000)
        const emitter = createNovelAgUiEmitter(
          createSseEmitterSink((data) => stream.write(data)),
          `novel:entity:${request.params.projectId}`,
          randomUUID(),
        )
        reply.send(stream)
        try {
          const generated = await services.entityGenerator.generate(
            request.params.projectId,
            input.entityType,
            input.coreStyle,
            (event) => emitter.progress(event),
            undefined,
            input.modelId,
          )
          emitter.result(generated)
        } catch (err) {
          emitter.error(String(err))
        } finally {
          clearInterval(heartbeat)
          stream.end()
        }
        return reply
      },
    },
  ]
}
