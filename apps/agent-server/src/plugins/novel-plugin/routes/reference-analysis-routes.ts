import { z } from 'zod'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { MAX_REFERENCE_SOURCE_BYTES } from '../core/analysis/reference-analysis.js'

const REFERENCE_PREFLIGHT_BODY_LIMIT = Math.ceil((MAX_REFERENCE_SOURCE_BYTES * 4) / 3) + 64 * 1024

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

function withReferenceError<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof AppError) throw error
    const message = error instanceof Error ? error.message : '参考小说分析失败'
    if (message.includes('不存在') || message.includes('没有'))
      throw new AppError(ErrorCode.NOT_FOUND, message, 404)
    if (message.includes('版本冲突') || message.includes('版本过期'))
      throw new AppError(ErrorCode.CONFLICT, message, 409)
    throw new AppError(ErrorCode.BAD_REQUEST, message, 400)
  }
}
