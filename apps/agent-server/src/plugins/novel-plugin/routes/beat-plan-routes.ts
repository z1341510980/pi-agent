import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { modelSelectionSchema } from './model-selection-contract.js'

const generateBeatPlanSchema = z.object({
  count: z.number().int().min(3).max(100).optional(),
  instruction: z.string().trim().max(2000).optional(),
  modelId: modelSelectionSchema.optional()
})

const updateBeatPlanSchema = z.object({
  dramaticFunction: z
    .enum([
      'setup',
      'escalation',
      'false_victory',
      'false_defeat',
      'midpoint_turn',
      'low_point',
      'climax',
      'payoff',
      'aftermath',
      'breather'
    ])
    .optional(),
  emotionalDebt: z.string().trim().max(2000).optional(),
  payoff: z.string().trim().max(2000).optional(),
  arcPosition: z.string().trim().max(500).optional(),
  summary: z.string().trim().max(4000).optional(),
  status: z.enum(['planned', 'confirmed', 'superseded']).optional()
})

function mapBeatPlanError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err)
  if (/尚未填写卷纲|少于 \d+ 字/.test(message)) {
    return new AppError(ErrorCode.BAD_REQUEST, message, 400)
  }
  if (/均已发布|无需规划节拍/.test(message)) {
    return new AppError(ErrorCode.CONFLICT, message, 409)
  }
  if (/不存在/.test(message)) {
    return new AppError(ErrorCode.NOT_FOUND, message, 404)
  }
  return new AppError(ErrorCode.AGENT_RUN_FAILED, `节拍表生成失败：${message}`, 502, message)
}

export function createBeatPlanRoutes(services: NovelServices): RouteDefinition[] {
  const { store, beatPlanner } = services

  return [
    {
      method: 'POST',
      path: '/projects/:projectId/volumes/:volumeNumber/beat-plan/generate',
      handler: async (request: any, reply: any) => {
        const input = validateBody(generateBeatPlanSchema, request, reply)
        if (!input) return reply
        const volumeNumber = Number.parseInt(request.params.volumeNumber, 10)
        if (!Number.isInteger(volumeNumber) || volumeNumber < 1) {
          throw new AppError(
            ErrorCode.BAD_REQUEST,
            `无效的卷号: ${request.params.volumeNumber}`,
            400
          )
        }

        const controller = new AbortController()
        const abortOnDisconnect = (): void => {
          if (!reply.raw.writableEnded && !controller.signal.aborted) {
            controller.abort(new Error('客户端已取消节拍表生成'))
          }
        }
        reply.raw.once('close', abortOnDisconnect)

        try {
          const result = await beatPlanner.generate({
            projectId: request.params.projectId,
            volumeNumber,
            count: input.count,
            instruction: input.instruction,
            modelId: input.modelId,
            signal: controller.signal
          })
          return success(result, request.traceId)
        } catch (err) {
          if (controller.signal.aborted) {
            throw new AppError(ErrorCode.AGENT_CANCELLED, '节拍表生成已取消', 499)
          }
          services.context.logger.error(
            { err, projectId: request.params.projectId, volumeNumber },
            '卷级节拍表生成失败'
          )
          throw mapBeatPlanError(err)
        } finally {
          reply.raw.off('close', abortOnDisconnect)
        }
      }
    },
    {
      method: 'GET',
      path: '/projects/:projectId/beat-plans',
      handler: async (request: any) => {
        const volumeQuery = request.query?.volumeNumber
        const beats =
          volumeQuery !== undefined
            ? store.listBeatsByVolume(request.params.projectId, Number.parseInt(volumeQuery, 10))
            : store.listBeatsByProject(request.params.projectId)
        return success({ beats }, request.traceId)
      }
    },
    {
      method: 'GET',
      path: '/projects/:projectId/chapters/:chapterNumber/beat-plan',
      handler: async (request: any) => {
        const chapterNumber = Number.parseInt(request.params.chapterNumber, 10)
        if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
          throw new AppError(
            ErrorCode.BAD_REQUEST,
            `无效的章节号: ${request.params.chapterNumber}`,
            400
          )
        }
        const beat = store.getBeatByChapter(request.params.projectId, chapterNumber) ?? null
        return success({ beat }, request.traceId)
      }
    },
    {
      method: 'PATCH',
      path: '/beat-plans/:id',
      handler: async (request: any, reply: any) => {
        const input = validateBody(updateBeatPlanSchema, request, reply)
        if (!input) return reply
        const updated = store.updateBeat(request.params.id, input)
        if (!updated) {
          throw new AppError(ErrorCode.NOT_FOUND, `节拍不存在: ${request.params.id}`, 404)
        }
        return success(updated, request.traceId)
      }
    }
  ]
}
