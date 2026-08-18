import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { hashChapterOutline } from '../core/chapters/chapter-outline.js'
import { modelSelectionSchema } from './model-selection-contract.js'

const generateChapterOutlineSchema = z.object({
  mode: z.enum(['create', 'rewrite', 'expand']),
  currentOutline: z.string().max(20000),
  expectedOutline: z.string().max(20000),
  instruction: z.string().trim().max(2000).optional(),
  modelId: modelSelectionSchema.optional()
})

function mapGenerationError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err)
  if (/已经发生变化|已发布章节/.test(message)) {
    return new AppError(ErrorCode.CONFLICT, message, 409)
  }
  if (/需要已有章纲/.test(message)) {
    return new AppError(ErrorCode.BAD_REQUEST, message, 400)
  }
  if (/不存在/.test(message)) {
    return new AppError(ErrorCode.NOT_FOUND, message, 404)
  }
  return new AppError(ErrorCode.AGENT_RUN_FAILED, `章纲生成失败：${message}`, 502, message)
}

export function createChapterOutlineRoutes(services: NovelServices): RouteDefinition[] {
  const { store, outlineGenerator } = services

  return [
    {
      method: 'POST',
      path: '/projects/:projectId/chapters/:chapterNumber/outline/generate',
      handler: async (request: any, reply: any) => {
        const input = validateBody(generateChapterOutlineSchema, request, reply)
        if (!input) return reply
        const chapterNumber = Number.parseInt(request.params.chapterNumber, 10)
        if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
          throw new AppError(
            ErrorCode.BAD_REQUEST,
            `无效的章节号: ${request.params.chapterNumber}`,
            400
          )
        }

        const chapter = store.getChapter(request.params.projectId, chapterNumber)
        if (!chapter) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `章节不存在或不属于当前项目: ${chapterNumber}`,
            404
          )
        }
        if (chapter.status === 'published') {
          throw new AppError(ErrorCode.CONFLICT, '已发布章节不能生成新章纲', 409)
        }
        if (hashChapterOutline(chapter.outline) !== hashChapterOutline(input.expectedOutline)) {
          throw new AppError(ErrorCode.CONFLICT, '章纲已经发生变化，请刷新章节后重试', 409)
        }

        const controller = new AbortController()
        const abortOnDisconnect = (): void => {
          if (!reply.raw.writableEnded && !controller.signal.aborted) {
            controller.abort(new Error('客户端已取消章纲生成'))
          }
        }
        reply.raw.once('close', abortOnDisconnect)

        try {
          const result = await outlineGenerator.generate({
            projectId: request.params.projectId,
            chapterNumber,
            mode: input.mode,
            currentOutline: input.currentOutline,
            expectedOutline: input.expectedOutline,
            instruction: input.instruction,
            modelId: input.modelId,
            signal: controller.signal
          })
          return success(result, request.traceId)
        } catch (err) {
          if (controller.signal.aborted) {
            throw new AppError(ErrorCode.AGENT_CANCELLED, '章纲生成已取消', 499)
          }
          services.context.logger.error(
            { err, projectId: request.params.projectId, chapterNumber },
            '章纲生成失败'
          )
          throw mapGenerationError(err)
        } finally {
          reply.raw.off('close', abortOnDisconnect)
        }
      }
    }
  ]
}
