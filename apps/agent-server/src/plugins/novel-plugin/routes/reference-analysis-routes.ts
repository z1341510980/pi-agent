import { z } from 'zod'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { MAX_REFERENCE_SOURCE_BYTES, sampleSectionIdsEvenly } from '../core/analysis/reference-analysis.js'
import { distillStyleExpertFromReference } from '../core/prompting/style-expert-distiller.js'
import { measureStyleMetrics } from '../core/analysis/style-measurement.js'

const REFERENCE_PREFLIGHT_BODY_LIMIT = Math.ceil((MAX_REFERENCE_SOURCE_BYTES * 4) / 3) + 64 * 1024
/** 蒸馏单次输入的章节数上限；超过时服务端按等距自动抽样，不再拒绝请求。 */
export const MAX_REFERENCE_STYLE_DISTILL_SECTIONS = 500

const preflightSchema = z.discriminatedUnion('inputKind', [
  z.object({
    inputKind: z.literal('paste'),
    displayName: z.string().min(1).max(200),
    text: z.string().min(1),
    fileFormat: z.enum(['txt', 'markdown']).optional()
  }),
  z.object({
    inputKind: z.literal('file'),
    displayName: z.string().min(1).max(200),
    fileName: z.string().min(1).max(500),
    bytesBase64: z.string().min(1),
    fileFormat: z.enum(['txt', 'markdown']).optional()
  })
])

const importOptionsSchema = z.object({
  encoding: z.enum(['utf-8', 'utf-8-bom', 'gbk', 'gb18030']),
  retentionPolicy: z.enum(['delete_after_activation', 'keep_local', 'manual_delete']),
  rightsConfirmed: z.boolean(),
  rightsStatement: z.string().max(1000).optional(),
  cloudAnalysisConfirmed: z.boolean().optional(),
  version: z.number().int().positive()
})

const parseSchema = z.object({ version: z.number().int().positive() })

const sectionUpdateSchema = z.object({
  title: z.string().max(300).optional(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().positive().optional(),
  included: z.boolean().optional(),
  exclusionReason: z.string().max(500).optional(),
  version: z.number().int().positive()
})

const batchOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('update'),
    sectionId: z.string().min(1),
    title: z.string().max(300).optional(),
    start: z.number().int().min(0).optional(),
    end: z.number().int().positive().optional(),
    included: z.boolean().optional(),
    exclusionReason: z.string().max(500).optional(),
    version: z.number().int().positive()
  }),
  z.object({
    type: z.literal('split'),
    sectionId: z.string().min(1),
    offset: z.number().int().positive(),
    leftTitle: z.string().max(300).optional(),
    rightTitle: z.string().max(300).optional(),
    version: z.number().int().positive()
  }),
  z.object({
    type: z.literal('merge'),
    sectionIds: z.array(z.string().min(1)).min(2),
    title: z.string().max(300).optional()
  })
])

const sectionBatchSchema = z.object({
  operations: z.array(batchOperationSchema).min(1).max(100),
  sourceVersion: z.number().int().positive()
})

const reparseSchema = z.object({
  encoding: z.enum(['utf-8', 'utf-8-bom', 'gbk', 'gb18030']).optional(),
  cleanupOptions: z.record(z.string(), z.boolean()).optional(),
  chapterPattern: z.string().max(500).optional(),
  sceneStrategy: z.string().max(100).optional()
})

const estimateSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  selectedSectionIds: z.array(z.string().min(1)).optional(),
  outputReserveTokens: z.number().int().min(512).optional(),
  safetyMarginTokens: z.number().int().min(0).optional()
})

export function createReferenceAnalysisRoutes(services: NovelServices): RouteDefinition[] {
  const service = services.referenceAnalysis
  if (!service) return []
  return [
    {
      method: 'GET',
      path: '/projects/:projectId/reference-sources',
      handler: async (request: any) =>
        withReferenceError(() =>
          success(service.listSources(request.params.projectId), request.traceId)
        )
    },
    {
      method: 'GET',
      path: '/reference-sources/:sourceId',
      handler: async (request: any) =>
        withReferenceError(() =>
          success(service.getSource(request.params.sourceId), request.traceId)
        )
    },
    {
      method: 'POST',
      path: '/projects/:projectId/reference-sources/preflight',
      bodyLimit: REFERENCE_PREFLIGHT_BODY_LIMIT,
      handler: async (request: any, reply: any) => {
        const input = validateBody(preflightSchema, request, reply)
        if (!input) return reply
        return withReferenceError(() => {
          const bytes = input.inputKind === 'file' ? decodeBase64(input.bytesBase64) : undefined
          const result = service.preflight(request.params.projectId, { ...input, bytes })
          return success(result, request.traceId)
        })
      }
    },
    {
      method: 'PATCH',
      path: '/reference-sources/:sourceId/import-options',
      handler: async (request: any, reply: any) => {
        const input = validateBody(importOptionsSchema, request, reply)
        if (!input) return reply
        return withReferenceError(() =>
          success(service.updateImportOptions(request.params.sourceId, input), request.traceId)
        )
      }
    },
    {
      method: 'POST',
      path: '/reference-sources/:sourceId/parse',
      handler: async (request: any, reply: any) => {
        const input = validateBody(parseSchema, request, reply)
        if (!input) return reply
        return withReferenceError(() =>
          success(service.parse(request.params.sourceId, input.version), request.traceId)
        )
      }
    },
    {
      method: 'GET',
      path: '/reference-sources/:sourceId/quality-report',
      handler: async (request: any) =>
        withReferenceError(() =>
          success(service.getQualityReport(request.params.sourceId), request.traceId)
        )
    },
    {
      method: 'GET',
      path: '/reference-sources/:sourceId/local-analysis-report',
      handler: async (request: any) =>
        withReferenceError(() =>
          success(service.getLocalReport(request.params.sourceId), request.traceId)
        )
    },
    {
      method: 'GET',
      path: '/reference-sources/:sourceId/sections',
      handler: async (request: any) =>
        withReferenceError(() =>
          success(service.listSections(request.params.sourceId), request.traceId)
        )
    },
    {
      method: 'POST',
      path: '/reference-sources/:sourceId/style-distill-input',
      bodyLimit: 2 * 1024 * 1024,
      handler: async (request: any, reply: any) => {
        const input = validateBody(
          z.object({
            sectionIds: z.array(z.string().min(1)).min(1)
          }),
          request,
          reply
        )
        if (!input) return reply
        return withReferenceError(() => {
          const sampled = sampleSectionIdsEvenly(
            input.sectionIds,
            MAX_REFERENCE_STYLE_DISTILL_SECTIONS
          )
          const sample = service.getSectionsText(request.params.sourceId, sampled)
          return success(
            { sourceId: sample.sourceId, sections: sample.sections, text: sample.text },
            request.traceId
          )
        })
      }
    },
    {
      method: 'POST',
      path: '/reference-sources/:sourceId/style-distill',
      bodyLimit: 2 * 1024 * 1024,
      handler: async (request: any, reply: any) => {
        const input = validateBody(
          z.object({
            sectionIds: z.array(z.string().min(1)).min(1),
            notes: z.string().max(2000).optional(),
            modelId: z.object({ provider: z.string(), modelId: z.string() }).optional()
          }),
          request,
          reply
        )
        if (!input) return reply
        return withReferenceError(async () => {
          const sampled = sampleSectionIdsEvenly(
            input.sectionIds,
            MAX_REFERENCE_STYLE_DISTILL_SECTIONS
          )
          const sample = service.getSectionsText(request.params.sourceId, sampled)
          const metrics = measureStyleMetrics(sample.text)
          const source = service.getSource(sample.sourceId)
          const startedAt = Date.now()
          let draftName = ''
          let failure = ''
          try {
            const draft = await distillStyleExpertFromReference(
              services.context,
              {
                sourceId: sample.sourceId,
                sections: sample.sections,
                text: sample.text,
                sectionTexts: sample.sectionTexts,
                metrics,
                notes: input.notes
              },
              input.modelId
            )
            draftName = draft.name
            return success(draft, request.traceId)
          } catch (error) {
            failure = error instanceof Error ? error.message : '文风蒸馏失败'
            throw error
          } finally {
            const durationMs = Date.now() - startedAt
            const taskInput = JSON.stringify({
              referenceSourceId: source.id,
              sectionIds: sample.sections.map((section) => section.id),
              notesProvided: Boolean(input.notes?.trim())
            })
            try {
              services.store.insertAgentLog({
                projectId: source.projectId,
                chapterNumber: 0,
                agentType: 'reference-style-distill',
                agentName: '参考文风蒸馏',
                displayAgentType: 'reference-style-distill',
                displayAgentName: '参考文风蒸馏',
                phase: 'reference-analysis',
                systemPrompt: '参考小说文风蒸馏（LLM 调用；原文不写入日志）',
                chapterContext: '',
                userMessage: '从参考文本分包样本中蒸馏写作手法。',
                taskInput,
                userInstructions: [],
                tools: [],
                toolNames: [],
                askStoryPolicy: 'allOffWithReferences',
                askStoryEnabled: false,
                result: draftName ? `已生成文风专家草稿：${draftName}` : '',
                resultLength: draftName.length,
                durationMs,
                status: failure ? 'error' : 'success',
                error: failure,
                sessionId: '',
                operation: 'style_distill',
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                llmProvider: input.modelId?.provider ?? '',
                llmModel: input.modelId?.modelId ?? '',
                payloadMessagesChars: 0,
                payloadToolsChars: 0,
                payloadToolCount: 0,
                payloadTotalChars: 0,
                llmRoundTrips: 1,
                dataQuality: 'no_data'
              })
            } catch (error) {
              services.context.logger.warn(
                { error, sourceId: source.id },
                '文风蒸馏项目日志写入失败'
              )
            }
            try {
              services.context.agentCallLogger?.record({
                agentId: 'reference-style-distill',
                agentName: '参考文风蒸馏',
                threadId: '',
                systemPrompt: '参考小说文风蒸馏（LLM 调用；原文不写入日志）',
                userMessage: '从参考文本分包样本中蒸馏写作手法。',
                taskInput,
                tools: '[]',
                toolNames: '[]',
                result: draftName ? `已生成文风专家草稿：${draftName}` : '',
                resultLength: draftName.length,
                durationMs,
                status: failure ? 'error' : 'success',
                error: failure,
                metadata: JSON.stringify({
                  projectId: source.projectId,
                  referenceSourceId: source.id,
                  operation: 'style_distill',
                  providerId: input.modelId?.provider ?? null,
                  modelId: input.modelId?.modelId ?? null
                })
              })
            } catch (error) {
              services.context.logger.warn(
                { error, sourceId: source.id },
                '文风蒸馏通用日志写入失败'
              )
            }
          }
        })
      }
    },
    {
      method: 'GET',
      path: '/reference-sources/:sourceId/text-preview',
      handler: async (request: any) =>
        withReferenceError(() =>
          success(
            service.getTextPreview(request.params.sourceId, {
              sectionId: optionalString(request.query?.sectionId),
              start: optionalInteger(request.query?.start),
              end: optionalInteger(request.query?.end),
              contextChars: optionalInteger(request.query?.contextChars)
            }),
            request.traceId
          )
        )
    },
    {
      method: 'PATCH',
      path: '/reference-sections/:sectionId',
      handler: async (request: any, reply: any) => {
        const input = validateBody(sectionUpdateSchema, request, reply)
        if (!input) return reply
        return withReferenceError(() =>
          success(service.updateSection(request.params.sectionId, input), request.traceId)
        )
      }
    },
    {
      method: 'POST',
      path: '/reference-sources/:sourceId/sections/batch',
      handler: async (request: any, reply: any) => {
        const input = validateBody(sectionBatchSchema, request, reply)
        if (!input) return reply
        return withReferenceError(() =>
          success(
            service.batchSections(request.params.sourceId, input.sourceVersion, input.operations),
            request.traceId
          )
        )
      }
    },
    {
      method: 'POST',
      path: '/reference-sources/:sourceId/reparse',
      handler: async (request: any, reply: any) => {
        const input = validateBody(reparseSchema, request, reply)
        if (!input) return reply
        return withReferenceError(() => {
          let source = service.getSource(request.params.sourceId)
          if (input.encoding && input.encoding !== source.encoding) {
            source = service.updateImportOptions(source.id, {
              version: source.version,
              encoding: input.encoding,
              retentionPolicy: source.retentionPolicy,
              rightsConfirmed: source.rights.confirmed,
              rightsStatement: source.rights.statement
            }).source
          }
          const result = service.parse(source.id, source.version)
          return success(
            {
              ...result,
              reparseWarnings: input.chapterPattern
                ? ['阶段 1 当前仅保存手工边界调整；自定义章节正则尚未启用。']
                : []
            },
            request.traceId
          )
        })
      }
    },
    {
      method: 'POST',
      path: '/reference-sources/:sourceId/analysis-estimate',
      handler: async (request: any, reply: any) => {
        const input = validateBody(estimateSchema, request, reply)
        if (!input) return reply
        return withReferenceError(() => {
          const provider = request.server.providerConfigStore.get(input.providerId)
          const model = provider?.models.find((candidate: any) => candidate.id === input.modelId)
          if (!provider || !model) throw new Error('所选 provider 或模型不存在')
          return success(
            service.estimateBudget(request.params.sourceId, { ...input, model }),
            request.traceId
          )
        })
      }
    }
  ]
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error('文件字节载荷不是有效 Base64')
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  return Number(value)
}

function toReferenceAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : '参考小说分析失败'
  if (message.includes('不存在') || message.includes('没有'))
    return new AppError(ErrorCode.NOT_FOUND, message, 404)
  if (message.includes('版本冲突') || message.includes('版本过期'))
    return new AppError(ErrorCode.CONFLICT, message, 409)
  return new AppError(ErrorCode.BAD_REQUEST, message, 400)
}

function withReferenceError<T>(operation: () => T): T {
  try {
    const result = operation()
    // 异步操作必须接管 rejection：否则异常绕过本映射，被 Fastify 兜底成无详情的 500
    if (result instanceof Promise) {
      return result.catch((error: unknown) => {
        throw toReferenceAppError(error)
      }) as T
    }
    return result
  } catch (error) {
    throw toReferenceAppError(error)
  }
}
