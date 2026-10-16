import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { evaluateProseQuality } from '../core/quality/prose-quality-evaluator.js'

/**
 * 参考章节 → 文风基线样本：句界截断（单条 ≤2800 字，避免样本以半句话收尾）。
 *
 * append-reference-samples（手动选章）与 auto-baseline（分析完成后分层取样）
 * 共用同一截断逻辑，保证两条路径产出的样本形态一致。
 */
function truncateReferenceSample(sectionText: string, title: string): string {
  const body = sectionText.trim()
  const capped =
    body.length <= 2800
      ? body
      : (() => {
          const head = body.slice(0, 2800)
          const lastStop = Math.max(
            head.lastIndexOf('。'),
            head.lastIndexOf('！'),
            head.lastIndexOf('？'),
            head.lastIndexOf('"')
          )
          return lastStop > 1400 ? head.slice(0, lastStop + 1) : head.trim()
        })()
  return `## 参考样本：${title}\n\n${capped}`
}

/**
 * 基线分层取样位置：首章 + 约 10%/35%/60%/85%，覆盖头/中/尾。
 * 只学开头的文风会让基线带偏全书，分层是低成本的对冲。
 */
const BASELINE_SAMPLE_POSITIONS = [0, 0.1, 0.35, 0.6, 0.85]

/** Routes for project writing-style profiles, style experts, and prose quality. */
export function createWritingStyleRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  const routes: RouteDefinition[] = []

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-experts/:expertId/versions',
    handler: async (request: any) => success(store.listStyleExpertVersions(request.params.projectId, request.params.expertId), request.traceId),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/writing-style-experts/:expertId/rollback',
    handler: async (request: any, reply: any) => {
      const input = z.object({ version: z.number().int().positive() }).parse(request.body ?? {})
      const expert = store.rollbackStyleExpert(request.params.projectId, request.params.expertId, input.version)
      if (!expert) return reply.code(404).send({ ok: false, error: '文风专家版本不存在' })
      return success(expert, request.traceId)
    },
  })

  // ═══════════════════════════════════════════════════════════════
  // 项目级叙事文风档案
  // ═══════════════════════════════════════════════════════════════

  const writingStyleProfileSchema = z.object({
    name: z.string().trim().min(1).max(80),
    preset: z.string().trim().min(1).max(40).default('custom'),
    narrativePerson: z.enum(['first', 'third', 'mixed']).default('third'),
    narrativeDistance: z.enum(['intimate', 'limited', 'omniscient']).default('limited'),
    sentenceRhythm: z.enum(['short', 'balanced', 'long']).default('balanced'),
    dialogueRatio: z.number().min(10).max(90).default(45),
    emotionalTemperature: z.number().min(0).max(10).default(5),
    imageryDensity: z.number().min(0).max(10).default(3),
    vocabularyRegister: z.enum(['colloquial', 'plain', 'literary', 'classical']).default('plain'),
    hardRules: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    softRules: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    positiveExamples: z.array(z.string().trim().min(20).max(3000)).max(5).default([]),
    negativeExamples: z.array(z.string().trim().min(20).max(3000)).max(5).default([]),
    notes: z.string().max(2000).default(''),
    styleExperts: z.array(z.object({
      id: z.string().trim().min(1).max(80),
      name: z.string().trim().min(1).max(40),
      sourceTitle: z.string().trim().min(1).max(160),
      sourceAuthor: z.string().trim().max(100).optional(),
      description: z.string().trim().min(1).max(400),
      distilledPrompt: z.string().trim().min(1).max(3000).optional(),
      prompt: z.string().trim().min(1).max(3000).optional(),
      customPrompt: z.string().trim().max(3000).nullable().optional(),
      metrics: z.record(z.string(), z.unknown()).optional(),
      techniques: z.array(z.unknown()).optional(),
      exclusions: z.array(z.string()).optional(),
      exemplarPassages: z.array(z.unknown()).optional(),
      expressionDna: z.record(z.string(), z.unknown()).optional(),
      tensions: z.array(z.unknown()).optional(),
      antiPatterns: z.array(z.string()).optional(),
      boundaries: z.array(z.string()).optional(),
      distillMeta: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().default(true),
    }).refine((expert) => Boolean(expert.distilledPrompt ?? expert.prompt), {
      message: '文风专家必须提供 distilledPrompt 或 prompt',
      path: ['distilledPrompt'],
    })).max(8).default([]),
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-profile',
    handler: async (request: any) => {
      return success(store.getWritingStyleProfile(request.params.projectId) ?? null, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-experts',
    handler: async (request: any) => success(store.listStyleExperts(request.params.projectId), request.traceId),
  })

  routes.push({
    method: 'POST',
    path: '/projects/:projectId/writing-style-experts',
    handler: async (request: any, _reply: any) => {
      const input = z.object({
        name: z.string().trim().min(1).max(80), sourceTitle: z.string().trim().min(1).max(160),
        sourceAuthor: z.string().trim().max(100).optional(), description: z.string().trim().min(1).max(400),
        distilledPrompt: z.string().trim().min(1).max(3000), customPrompt: z.string().trim().max(3000).optional(),
        enabled: z.boolean().default(true), sortOrder: z.number().int().min(0).max(1000).default(0),
        distillMeta: z.record(z.string(), z.unknown()).optional(),
        metrics: z.record(z.string(), z.unknown()).optional(),
        techniques: z.array(z.unknown()).optional(),
        exclusions: z.array(z.string()).optional(),
        exemplarPassages: z.array(z.unknown()).optional(),
        // 蒸馏契约 v2：语言指纹 / 内在张力 / 反模式 / 诚实边界
        expressionDna: z.record(z.string(), z.unknown()).optional(),
        tensions: z.array(z.unknown()).optional(),
        antiPatterns: z.array(z.string()).optional(),
        boundaries: z.array(z.string()).optional(),
      }).parse(request.body ?? {})
      const expert = store.createStyleExpert({
        id: randomUUID(), projectId: request.params.projectId, ...input, version: 1,
        createdAt: Date.now(), updatedAt: Date.now(),
      })
      return success(expert, request.traceId)
    },
  })

  routes.push({
    method: 'PATCH',
    path: '/projects/:projectId/writing-style-experts/:expertId',
    handler: async (request: any, reply: any) => {
      const input = z.object({
        name: z.string().trim().min(1).max(80).optional(),
        sourceTitle: z.string().trim().min(1).max(160).optional(),
        sourceAuthor: z.string().trim().max(100).optional(),
        description: z.string().trim().min(1).max(400).optional(),
        customPrompt: z.string().trim().min(1).max(3000).nullable().optional(),
        enabled: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
        reviewStatus: z.enum(['draft', 'approved']).optional(),
      }).parse(request.body ?? {})
      // 启用即视为审核通过：草稿专家经用户显式开启后脱离待审核态，
      // 与文风面板的"审核启用"操作共用同一语义。
      const patch = input.enabled === true
        ? { ...input, reviewStatus: 'approved' as const }
        : input
      const expert = store.updateStyleExpert(request.params.projectId, request.params.expertId, patch)
      if (!expert) return reply.code(404).send({ ok: false, error: '文风专家不存在' })
      return success(expert, request.traceId)
    },
  })

  routes.push({
    method: 'DELETE',
    path: '/projects/:projectId/writing-style-experts/:expertId',
    handler: async (request: any, reply: any) => {
      const deleted = store.deleteStyleExpert(request.params.projectId, request.params.expertId)
      if (!deleted) return reply.code(404).send({ ok: false, error: '文风专家不存在' })
      return success({ id: request.params.expertId, deleted: true }, request.traceId)
    },
  })

  routes.push({
    method: 'PUT',
    path: '/projects/:projectId/writing-style-profile',
    handler: async (request: any, reply: any) => {
      const input = validateBody(writingStyleProfileSchema, request, reply)
      if (!input) return reply
      const normalizedStyleExperts = input.styleExperts?.map((expert: any, index: number) => ({
        id: expert.id,
        projectId: request.params.projectId,
        name: expert.name,
        sourceTitle: expert.sourceTitle,
        sourceAuthor: expert.sourceAuthor,
        description: expert.description,
        distilledPrompt: expert.distilledPrompt ?? expert.prompt,
        customPrompt: expert.customPrompt,
        metrics: expert.metrics,
        techniques: expert.techniques,
        exclusions: expert.exclusions,
        exemplarPassages: expert.exemplarPassages,
        expressionDna: expert.expressionDna,
        tensions: expert.tensions,
        antiPatterns: expert.antiPatterns,
        boundaries: expert.boundaries,
        distillMeta: expert.distillMeta,
        enabled: expert.enabled,
        sortOrder: expert.sortOrder ?? index,
        version: expert.version ?? 1,
        createdAt: expert.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }))
      const { styleExperts: rawStyleExperts, ...profileInput } = input
      void rawStyleExperts
      const profile = store.upsertWritingStyleProfile(request.params.projectId, {
        ...profileInput,
        ...(normalizedStyleExperts ? { styleExperts: normalizedStyleExperts } : {}),
      } as any)
      return success(profile, request.traceId)
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/writing-style-profile/preview',
    handler: async (request: any) => {
      const target = request.query?.target
      const normalizedTarget = target === 'reviser' || target === 'reviewer' ? target : 'writer'
      return success(services.promptBuilder.buildWritingStylePrompt(request.params.projectId, normalizedTarget) ?? null, request.traceId)
    },
  })

  /**
   * 把参考小说的勾选章节截取为文风基线样本（正向或反向）。
   *
   * 解决"参考小说分析产出的文本进不了基线"的断点：蒸馏只产专家卡，
   * 而基线正/反样本此前只能手工粘贴。服务端一次完成取文、句界截断、
   * 上限校验与落库；正向样本第一条即锚定（每章必注入）。
   */
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/writing-style-profile/append-reference-samples',
    handler: async (request: any, reply: any) => {
      const input = validateBody(
        z.object({
          sourceId: z.string().min(1),
          sectionIds: z.array(z.string().min(1)).min(1).max(5),
          kind: z.enum(['positive', 'negative']).default('positive')
        }),
        request,
        reply
      )
      if (!input) return reply
      {
        const referenceAnalysis = services.referenceAnalysis
        if (!referenceAnalysis) throw new Error('参考分析服务未初始化')
        const { sections, sectionTexts } = referenceAnalysis.getSectionsText(input.sourceId, input.sectionIds)

        const existingProfile = store.getWritingStyleProfile(request.params.projectId)
        if (!existingProfile) throw new AppError(ErrorCode.BAD_REQUEST, '请先创建文风档案再加入样本')

        const samples = sections.map((section, index) =>
          truncateReferenceSample(sectionTexts[section.id] ?? '', section.title ?? `第 ${index + 1} 章`)
        )

        const key = input.kind === 'positive' ? 'positiveExamples' : 'negativeExamples'
        const current = (existingProfile[key] ?? []) as string[]
        const remaining = 5 - current.length
        if (remaining <= 0) {
          throw new AppError(
            ErrorCode.CONFLICT,
            `${input.kind === 'positive' ? '正向' : '反向'}样本已达上限（5 条），请先在文风样本编辑器中移除后再添加`
          )
        }
        const fitting = samples.slice(0, remaining).filter((sample) => sample.length >= 20)
        const skipped = samples.length - fitting.length

        const updated = store.upsertWritingStyleProfile(request.params.projectId, {
          name: existingProfile.name,
          preset: existingProfile.preset,
          narrativePerson: existingProfile.narrativePerson,
          narrativeDistance: existingProfile.narrativeDistance,
          sentenceRhythm: existingProfile.sentenceRhythm,
          dialogueRatio: existingProfile.dialogueRatio,
          emotionalTemperature: existingProfile.emotionalTemperature,
          imageryDensity: existingProfile.imageryDensity,
          vocabularyRegister: existingProfile.vocabularyRegister,
          hardRules: existingProfile.hardRules,
          softRules: existingProfile.softRules,
          positiveExamples:
            key === 'positiveExamples'
              ? [...existingProfile.positiveExamples, ...fitting]
              : existingProfile.positiveExamples,
          negativeExamples:
            key === 'negativeExamples'
              ? [...(existingProfile.negativeExamples ?? []), ...fitting]
              : existingProfile.negativeExamples,
          notes: existingProfile.notes,
        })

        return success(
          {
            profile: updated,
            added: fitting.length,
            skipped,
            anchorIsNew: key === 'positiveExamples' && current.length === 0 && fitting.length > 0
          },
          request.traceId
        )
      }
    },
  })

  /**
   * 分析完成后的一键文风基线：从分析范围章节分层取样正向样本（首章 + 10%/35%/60%/85%）。
   *
   * 与 append-reference-samples 的差别只在没有 kind（只产正向样本）与取样策略：
   * 手动路径按传入顺序截前 N 章，本路由按位置分层，避免基线只学开头的文风。
   * 样本位已满（5 条）时返回 reason: 'full' 且不改动档案。
   */
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/writing-style-profile/auto-baseline',
    handler: async (request: any, reply: any) => {
      const input = validateBody(
        z.object({
          sourceId: z.string().min(1),
          sectionIds: z.array(z.string().min(1)).min(1)
        }),
        request,
        reply
      )
      if (!input) return reply
      {
        const referenceAnalysis = services.referenceAnalysis
        if (!referenceAnalysis) throw new Error('参考分析服务未初始化')
        const { sections, sectionTexts } = referenceAnalysis.getSectionsText(input.sourceId, input.sectionIds)
        const ordered = [...sections].sort((a, b) => a.order - b.order)

        const existingProfile = store.getWritingStyleProfile(request.params.projectId)
        if (!existingProfile) throw new AppError(ErrorCode.BAD_REQUEST, '请先创建文风档案再加入样本')

        const current = existingProfile.positiveExamples ?? []
        const remaining = 5 - current.length
        if (remaining <= 0) {
          return success(
            {
              profile: existingProfile,
              added: 0,
              skipped: ordered.length,
              anchorIsNew: false,
              reason: 'full'
            },
            request.traceId
          )
        }

        const seen = new Set<number>()
        const pickedIndexes: number[] = []
        for (const ratio of BASELINE_SAMPLE_POSITIONS) {
          const index = Math.min(ordered.length - 1, Math.round((ordered.length - 1) * ratio))
          if (index < 0 || seen.has(index)) continue
          seen.add(index)
          pickedIndexes.push(index)
        }

        const fitting = pickedIndexes
          .slice(0, remaining)
          .map((index) => {
            const section = ordered[index]!
            return truncateReferenceSample(
              sectionTexts[section.id] ?? '',
              section.title ?? `第 ${section.order + 1} 章`
            )
          })
          .filter((sample) => sample.length >= 20)

        const updated = store.upsertWritingStyleProfile(request.params.projectId, {
          name: existingProfile.name,
          preset: existingProfile.preset,
          narrativePerson: existingProfile.narrativePerson,
          narrativeDistance: existingProfile.narrativeDistance,
          sentenceRhythm: existingProfile.sentenceRhythm,
          dialogueRatio: existingProfile.dialogueRatio,
          emotionalTemperature: existingProfile.emotionalTemperature,
          imageryDensity: existingProfile.imageryDensity,
          vocabularyRegister: existingProfile.vocabularyRegister,
          hardRules: existingProfile.hardRules,
          softRules: existingProfile.softRules,
          positiveExamples: [...current, ...fitting],
          negativeExamples: existingProfile.negativeExamples,
          notes: existingProfile.notes,
        })

        return success(
          {
            profile: updated,
            added: fitting.length,
            skipped: ordered.length - fitting.length,
            anchorIsNew: current.length === 0 && fitting.length > 0
          },
          request.traceId
        )
      }
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects/:projectId/chapters/:chapterNumber/prose-quality',
    handler: async (request: any) => {
      const chapterNumber = Number(request.params.chapterNumber)
      const chapter = Number.isInteger(chapterNumber)
        ? store.getChapter(request.params.projectId, chapterNumber)
        : undefined
      if (!chapter) {
        throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.chapterNumber}`, 404)
      }
      return success(evaluateProseQuality(chapter.content ?? ''), request.traceId)
    },
  })

  return routes
}
