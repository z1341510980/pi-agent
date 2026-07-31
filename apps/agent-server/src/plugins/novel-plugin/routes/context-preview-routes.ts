import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import { success } from '../../../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { NovelPromptBuilder } from '../core/prompt-builder.js'

/**
 * context-preview 路由（P1 可观测性）。
 *
 * 让开发者通过 GET /novel/projects/:projectId/context-preview 预览 prompt-builder
 * 实际注入的上下文结构（各 section 字符数、来源标记、前 200 字预览），
 * 无需触发完整创作流即可审计 prompt 组装。
 *
 * 路由风格与 story-ledger-routes 一致：handler 用 success() 返回，参数校验失败
 * 抛 AppError(ErrorCode.BAD_REQUEST)。
 */

const parseIntQuery = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function createContextPreviewRoutes(promptBuilder: NovelPromptBuilder): RouteDefinition[] {
  const routes: RouteDefinition[] = []

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/context-preview',
    handler: async (request: any) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>
      const chapterNumber = parseIntQuery(query.chapterNumber)
      if (chapterNumber === undefined || chapterNumber < 1) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'chapterNumber 必须为正整数', 400)
      }
      const agentType = query.agentType
      // mode 查询参数：full=全量故事状态（默认），diff=全局关键事实摘要 + 上一章变化 delta
      const mode = query.mode === 'diff' ? 'diff' : 'full'
      const result = promptBuilder.buildContextPreview(
        request.params.projectId,
        chapterNumber,
        agentType,
        mode,
      )
      return success(result, request.traceId)
    },
  })

  return routes
}
