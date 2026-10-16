/**
 * P6/P7 路由：应用预览、模板草稿与版本修订、同场景验证 run（方案 §9）。
 *
 * P6：application-preview（确定性计算，候选不落库）、template-drafts
 *     （阻断时 422）、模板列表/详情、版本修订（不可变版本 409）。
 * P7：validation-runs（原创场景校验、费用确认、固定 facts hash）、详情、
 *     SSE 事件、feedback（整改规则 → 新草稿版本）、regenerate（复用 facts hash）、
 *     decision（accepted 后 publishable=true）。
 */
import { z } from 'zod'
import { Type } from 'typebox'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { closeSse, sendSseComment, sendSseEvent, setupSse } from '../../../lib/sse.js'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { buildApplicationPreview } from '../core/analysis/reference-application-preview.js'
import { validateScenarioSafety } from '../core/analysis/reference-validation-run-worker.js'
import { ReferenceTemplateBindingConflictError } from '../core/analysis/reference-template-binding-store.js'
import { emptyQuerySchema, standardResponseSchema } from './route-contracts.js'

const previewSchema = z.object({
  findingKeys: z.array(z.string().min(1)).max(200).optional(),
  ownerProjectId: z.string().uuid().optional(),
})

const templateDraftSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(''),
  findingKeys: z.array(z.string().min(1)).max(200).optional(),
  defaultAgentScopes: z.array(z.enum(['Director', 'Writer', 'Reviser', 'Reviewer'])).max(4).optional(),
  chapterRuleSets: z.array(z.object({
    chapterClassification: z.string().min(1).max(100),
    ruleKeys: z.array(z.string().min(1)).max(100),
  })).max(20).optional(),
  previewHash: z.string().length(64).optional(),
  ownerProjectId: z.string().uuid().optional(),
})

const versionRevisionSchema = z.object({
  ruleOverrides: z.array(z.object({
    findingKey: z.string().min(1).max(100),
    rule: z.string().max(1000).optional(),
    strength: z.enum(['hard', 'soft', 'reference']).optional(),
    agentScopes: z.array(z.enum(['Director', 'Writer', 'Reviser', 'Reviewer'])).max(4).optional(),
    chapterScope: z.array(z.string().max(50)).max(50).optional(),
  })).max(200).optional(),
  defaultAgentScopes: z.array(z.enum(['Director', 'Writer', 'Reviser', 'Reviewer'])).max(4).optional(),
  chapterRuleSets: z.array(z.object({
    chapterClassification: z.string().min(1).max(100),
    ruleKeys: z.array(z.string().min(1)).max(100),
  })).max(20).optional(),
  changeSummary: z.string().max(500).optional(),
})

const validationRunSchema = z.object({
  scenarioSource: z.enum(['system_original', 'user_input', 'project_facts']),
  scenarioType: z.string().max(100).optional(),
  scenarioFacts: z.string().min(1).max(20_000),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  highCostConfirmed: z.boolean(),
})

const feedbackSchema = z.object({
  feedback: z.string().min(1).max(5000),
  targetFindingKeys: z.array(z.string().min(1)).max(50).optional(),
  version: z.number().int().positive().optional(),
})

const regenerateSchema = z.object({
  templateVersionId: z.string().uuid().optional(),
  reuseFixedScenario: z.literal(true).default(true),
  highCostConfirmed: z.boolean(),
})

const decisionSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  note: z.string().max(1000).optional().default(''),
  version: z.number().int().positive().optional(),
})

const projectParamsSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) })
const bindingParamsSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  templateId: Type.String({ minLength: 1 }),
})
const uuidSchema = Type.String({ format: 'uuid' })
const agentScopeSchema = Type.Union([
  Type.Literal('Director'),
  Type.Literal('Writer'),
  Type.Literal('Reviser'),
  Type.Literal('Reviewer'),
])
const bindingUpsertRouteSchema = Type.Object({
  templateVersionId: uuidSchema,
  bound: Type.Optional(Type.Boolean()),
  defaultEnabled: Type.Optional(Type.Boolean()),
  agentScopes: Type.Optional(Type.Array(agentScopeSchema, { maxItems: 4 })),
  chapterScopes: Type.Optional(Type.Array(Type.String({ maxLength: 50 }), { maxItems: 50 })),
  projectOverrides: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  lockVersion: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: true })
const bindingResolveRouteSchema = Type.Object({
  enabled: Type.Boolean(),
  templateId: Type.Optional(uuidSchema),
  templateVersionId: Type.Optional(uuidSchema),
  chapterClassification: Type.Optional(Type.String({ maxLength: 100 })),
  chapterNumber: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: true })

export function createReferenceTemplateRoutes(services: NovelServices): RouteDefinition[] {
  const reference = services.referenceAnalysis
  if (!reference) return []
  const profileStore = services.referenceProfiles
  const templateStore = services.referenceTemplates
  const bindingStore = services.referenceTemplateBindings
  const validationStore = services.referenceValidationRuns
  const validationWorker = services.referenceValidationWorker

  const requireProfile = (profileId: string) => {
    const profile = profileStore.getProfile(profileId)
    if (!profile) throw new AppError(ErrorCode.NOT_FOUND, '参考档案不存在', 404)
    return profile
  }

  const requireVersion = (versionId: string) => {
    const version = templateStore.getVersion(versionId)
    if (!version) throw new AppError(ErrorCode.NOT_FOUND, '模板版本不存在', 404)
    return version
  }

  const requireValidationRun = (runId: string) => {
    const run = validationStore.getRun(runId)
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '验证任务不存在', 404)
    return run
  }

  const mapBindingError = (error: unknown): AppError => {
    if (error instanceof ReferenceTemplateBindingConflictError) {
      return new AppError(ErrorCode.CONFLICT, error.message, 409)
    }
    const message = error instanceof Error ? error.message : String(error)
    if (/模板不存在|模板版本不存在|绑定不存在/.test(message)) {
      return new AppError(ErrorCode.NOT_FOUND, message, 404)
    }
    if (/属于指定模板/.test(message)) {
      return new AppError(ErrorCode.BAD_REQUEST, message, 400)
    }
    return new AppError(ErrorCode.CONFLICT, message, 409)
  }

  return [
    // ── P6 ──
    {
      method: 'POST',
      path: '/reference-profiles/:profileId/application-preview',
      handler: async (request: any, reply: any) => {
        const input = validateBody(previewSchema, request, reply)
        if (!input) return reply
        const profile = requireProfile(request.params.profileId)
        return success(buildApplicationPreview(services.store, profile, {
          findingKeys: input.findingKeys,
          ownerProjectId: input.ownerProjectId,
        }), request.traceId)
      },
    },
    {
      method: 'POST',
      path: '/reference-profiles/:profileId/template-drafts',
      handler: async (request: any, reply: any) => {
        const input = validateBody(templateDraftSchema, request, reply)
        if (!input) return reply
        const profile = requireProfile(request.params.profileId)
        const preview = buildApplicationPreview(services.store, profile, {
          findingKeys: input.findingKeys,
          ownerProjectId: input.ownerProjectId,
        })
        if (preview.blocking) {
          return reply.code(422).send({
            ok: false,
            error: '应用预览存在阻断项，不能创建模板草稿',
            data: { safetyBlockers: preview.safetyBlockers, sourceSpecificMatches: preview.sourceSpecificMatches },
            traceId: request.traceId,
          })
        }
        if (input.previewHash && input.previewHash !== preview.previewHash) {
          throw new AppError(ErrorCode.CONFLICT, '预览已变化，请重新获取应用预览后确认', 409)
        }
        try {
          const created = templateStore.createTemplateFromProfile({
            profileId: profile.id,
            name: input.name,
            description: input.description,
            ownerProjectId: input.ownerProjectId ?? null,
            findingKeys: input.findingKeys,
            defaultAgentScopes: input.defaultAgentScopes,
            chapterRuleSets: input.chapterRuleSets,
            previewHash: preview.previewHash,
          })
          return success(created, request.traceId)
        } catch (error) {
          throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '创建模板草稿失败', 409)
        }
      },
    },
    {
      method: 'GET',
      path: '/reference-templates',
      handler: async (request: any) => {
        const query = (request.query ?? {}) as Record<string, string | undefined>
        return success(templateStore.listTemplates({
          status: query.status,
          ownerProjectId: query.projectId,
        }), request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-templates/:templateId',
      handler: async (request: any) => {
        const template = templateStore.getTemplate(request.params.templateId)
        if (!template) throw new AppError(ErrorCode.NOT_FOUND, '模板不存在', 404)
        const versions = templateStore.listVersions(template.id)
        return success({
          template,
          currentVersion: template.currentVersionId ? templateStore.getVersion(template.currentVersionId) : null,
          versions: versions.map((version) => ({
            id: version.id, version: version.version, status: version.status,
            ruleCount: version.spiritRules.length + version.techniqueRules.length + version.powerRules.length + version.pacingRules.length,
            changeSummary: version.changeSummary, createdAt: version.createdAt, publishedAt: version.publishedAt,
          })),
        }, request.traceId)
      },
    },
    {
      method: 'POST',
      path: '/reference-template-versions/:versionId/revisions',
      handler: async (request: any, reply: any) => {
        const input = validateBody(versionRevisionSchema, request, reply)
        if (!input) return reply
        requireVersion(request.params.versionId)
        try {
          const next = templateStore.createVersionRevision({
            versionId: request.params.versionId,
            ruleOverrides: input.ruleOverrides,
            defaultAgentScopes: input.defaultAgentScopes,
            chapterRuleSets: input.chapterRuleSets,
            changeSummary: input.changeSummary,
          })
          return success({
            version: next,
            diff: { ruleCount: next.spiritRules.length + next.techniqueRules.length + next.powerRules.length + next.pacingRules.length },
            hash: next.templateHash,
            safetyResult: next.safetyResult,
          }, request.traceId)
        } catch (error) {
          throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '版本修订失败', 409)
        }
      },
    },

    // ── P7 ──
    {
      method: 'POST',
      path: '/reference-template-versions/:versionId/validation-runs',
      handler: async (request: any, reply: any) => {
        const input = validateBody(validationRunSchema, request, reply)
        if (!input) return reply
        const version = requireVersion(request.params.versionId)
        const provider = request.server.providerConfigStore?.get(input.providerId)
        const model = provider?.models.find((candidate: any) => candidate.id === input.modelId)
        if (!provider || !model) throw new AppError(ErrorCode.BAD_REQUEST, '所选 provider 或模型不存在', 400)
        if (!input.highCostConfirmed) {
          throw new AppError(ErrorCode.CONFLICT, '双路验证将产生费用，需先确认 highCostConfirmed', 409)
        }
        // 场景原创性校验（拒绝含参考特有内容的场景）
        const template = templateStore.getTemplate(version.templateId)
        if (template?.sourceProfileId) {
          const violations = validateScenarioSafety(profileStore, template.sourceProfileId, input.scenarioFacts)
          if (violations.length > 0) {
            return reply.code(422).send({
              ok: false,
              error: `场景包含参考作品特有内容：${violations.slice(0, 3).map((item) => `${item.kind}:${item.match}`).join('、')}`,
              traceId: request.traceId,
            })
          }
        }
        const run = validationStore.createRun({
          templateVersionId: version.id,
          scenarioSource: input.scenarioSource,
          scenarioType: input.scenarioType,
          scenarioFacts: input.scenarioFacts,
          providerId: input.providerId,
          modelId: input.modelId,
          estimate: { llmCalls: 3, provider: input.providerId, model: input.modelId },
        })
        void validationWorker.run(run.id, input.scenarioFacts).catch((error: unknown) => {
          services.context.logger.error({ err: error, runId: run.id }, '验证执行器异常退出')
        })
        return success({
          ...run,
          eventsUrl: `/reference-validation-runs/${run.id}/events`,
        }, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-validation-runs/:runId',
      handler: async (request: any) => {
        const run = requireValidationRun(request.params.runId)
        const version = templateStore.getVersion(run.templateVersionId)
        return success({
          ...run,
          workerRunning: validationWorker.isRunning(run.id),
          publishable: run.decision === 'accepted' && !(Array.isArray(run.safetyReport.blockers) && run.safetyReport.blockers.length > 0),
          templateVersionStatus: version?.status ?? null,
        }, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/reference-validation-runs/:runId/events',
      handler: async (request: any, reply: any) => {
        requireValidationRun(request.params.runId)
        const header = request.headers['last-event-id']
        const afterSequence = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : 0
        const events = validationStore.listEvents(request.params.runId, afterSequence)
        setupSse(reply)
        for (const event of events) {
          reply.raw.write(`id: ${event.sequence}\n`)
          sendSseEvent(reply, { validationRunEvent: event })
        }
        sendSseComment(reply, 'end-of-buffer')
        closeSse(reply)
        return reply
      },
    },
    {
      method: 'POST',
      path: '/reference-validation-runs/:runId/feedback',
      handler: async (request: any, reply: any) => {
        const input = validateBody(feedbackSchema, request, reply)
        if (!input) return reply
        const run = requireValidationRun(request.params.runId)
        if (run.status !== 'completed') {
          throw new AppError(ErrorCode.CONFLICT, '验证尚未完成，无法提交整改', 409)
        }
        validationStore.saveFeedback(run.id, input.feedback)
        try {
          const result = await validationWorker.suggestRuleRevisions({
            runId: run.id,
            feedback: input.feedback,
            targetFindingKeys: input.targetFindingKeys,
          })
          return success({
            feedback: input.feedback,
            ruleSuggestions: result.ruleSuggestions,
            newVersionId: result.newVersionId,
            note: result.newVersionId ? '整改已生成新草稿版本（修改的是规则而非正文），请用 regenerate 重新验证' : '没有可整改的规则',
          }, request.traceId)
        } catch (error) {
          throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '整改失败', 409)
        }
      },
    },
    {
      method: 'POST',
      path: '/reference-validation-runs/:runId/regenerate',
      handler: async (request: any, reply: any) => {
        const input = validateBody(regenerateSchema, request, reply)
        if (!input) return reply
        const run = requireValidationRun(request.params.runId)
        if (run.status !== 'completed') {
          throw new AppError(ErrorCode.CONFLICT, '验证尚未完成，无法重新生成', 409)
        }
        if (!input.highCostConfirmed) {
          throw new AppError(ErrorCode.CONFLICT, '重新生成将再次产生费用，需先确认 highCostConfirmed', 409)
        }
        const templateVersionId = input.templateVersionId ?? run.templateVersionId
        requireVersion(templateVersionId)
        // 复用同一 fixedScenarioVersion、fixedFactsHash 与固定场景事实文本
        // （store 层从 reuseFromRunId 继承；§9：必须复用同一 facts hash，验收记录保存固定输入）
        const next = validationStore.createRun({
          templateVersionId,
          scenarioSource: run.scenarioSource,
          scenarioType: run.scenarioType ?? undefined,
          scenarioFacts: run.scenarioFacts,
          providerId: run.providerId ?? 'unknown',
          modelId: run.modelId ?? 'unknown',
          reuseFromRunId: run.id,
        })
        void validationWorker.run(next.id, next.scenarioFacts).catch((error: unknown) => {
          services.context.logger.error({ err: error, runId: next.id }, '验证执行器异常退出')
        })
        return success({ ...next, eventsUrl: `/reference-validation-runs/${next.id}/events` }, request.traceId)
      },
    },
    {
      method: 'POST',
      path: '/reference-validation-runs/:runId/decision',
      handler: async (request: any, reply: any) => {
        const input = validateBody(decisionSchema, request, reply)
        if (!input) return reply
        const run = requireValidationRun(request.params.runId)
        if (run.status !== 'completed') {
          throw new AppError(ErrorCode.CONFLICT, '验证尚未完成，无法做出决定', 409)
        }
        if (input.decision === 'accepted') {
          const blockers = Array.isArray(run.safetyReport.blockers) ? run.safetyReport.blockers : []
          if (blockers.length > 0) {
            throw new AppError(ErrorCode.CONFLICT, `安全报告存在阻断项（${blockers[0]}），不能接受`, 409)
          }
        }
        const decided = validationStore.decide(run.id, input.decision, input.note)
        return success({
          ...decided,
          publishable: decided.decision === 'accepted',
        }, request.traceId)
      },
    },
  
    // ── P8：模板库管理（发布、复制、回滚、删除） ──
    {
      method: 'POST',
      path: '/reference-template-versions/:versionId/publish',
      handler: async (request: any, reply: any) => {
        const input = validateBody(z.object({ validationRunId: z.string().uuid() }), request, reply);
        if (!input) return reply;
        const version = requireVersion(request.params.versionId);
        const run = validationStore.getRun(input.validationRunId);
        if (!run) throw new AppError(ErrorCode.NOT_FOUND, '验证任务不存在', 404);
        if (run.decision !== 'accepted') {
          throw new AppError(ErrorCode.CONFLICT, '只有已验证且决定为 accepted 的版本才能发布', 409);
        }
        const blockers = Array.isArray(run.safetyReport.blockers) ? run.safetyReport.blockers : [];
        if (blockers.length > 0) {
          throw new AppError(ErrorCode.CONFLICT, `安全报告存在阻断项（${blockers[0]}），不能发布`, 409);
        }
        const published = templateStore.publishVersion(version.id, input.validationRunId);
        return success({ version: published }, request.traceId);
      },
    },
    {
      method: 'POST',
      path: '/reference-templates/:templateId/copy',
      handler: async (request: any, reply: any) => {
        const input = validateBody(z.object({
          newName: z.string().max(200).optional(),
          ownerProjectId: z.string().uuid().nullable().optional(),
        }), request, reply);
        if (!input) return reply;
        const template = templateStore.getTemplate(request.params.templateId);
        if (!template) throw new AppError(ErrorCode.NOT_FOUND, '模板不存在', 404);
        const copied = templateStore.copyTemplate(template.id, input.newName, input.ownerProjectId);
        return success({ template: copied }, request.traceId);
      },
    },
    {
      method: 'POST',
      path: '/reference-templates/:templateId/rollback',
      handler: async (request: any, reply: any) => {
        const input = validateBody(z.object({
          targetVersionId: z.string().uuid(),
          changeSummary: z.string().max(500).optional(),
        }), request, reply);
        if (!input) return reply;
        const template = templateStore.getTemplate(request.params.templateId);
        if (!template) throw new AppError(ErrorCode.NOT_FOUND, '模板不存在', 404);
        const target = templateStore.getVersion(input.targetVersionId);
        if (!target) throw new AppError(ErrorCode.NOT_FOUND, '目标版本不存在', 404);
        const rolledBack = templateStore.rollbackTemplate(template.id, input.targetVersionId, input.changeSummary);
        return success({ template: rolledBack }, request.traceId);
      },
    },
    {
      method: 'GET',
      path: '/reference-templates/:templateId/deletion-impact',
      handler: async (request: any) => {
        const template = templateStore.getTemplate(request.params.templateId);
        if (!template) throw new AppError(ErrorCode.NOT_FOUND, '模板不存在', 404);
        const impact = templateStore.getDeletionImpact(template.id);
        return success(impact, request.traceId);
      },
    },
    {
      method: 'DELETE',
      path: '/reference-templates/:templateId',
      handler: async (request: any, reply: any) => {
        const input = validateBody(z.object({
          mode: z.enum(['archive', 'purge']).default('archive'),
        }), request, reply);
        if (!input) return reply;
        const template = templateStore.getTemplate(request.params.templateId);
        if (!template) throw new AppError(ErrorCode.NOT_FOUND, '模板不存在', 404);
        try {
          templateStore.deleteTemplate(template.id, input.mode);
          return success({ deleted: true, mode: input.mode }, request.traceId);
        } catch (error) {
          throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : '删除模板失败', 409);
        }
      },
    },

    // ── P8：项目绑定 ──
    {
      method: 'GET',
      path: '/projects/:projectId/reference-template-bindings',
      schema: {
        params: projectParamsSchema,
        querystring: emptyQuerySchema,
        response: standardResponseSchema,
      },
      handler: async (request: any) => {
        return success(bindingStore.listByProject(request.params.projectId), request.traceId);
      },
    },
    {
      method: 'PUT',
      path: '/projects/:projectId/reference-template-bindings/:templateId',
      schema: {
        params: bindingParamsSchema,
        querystring: emptyQuerySchema,
        body: bindingUpsertRouteSchema,
        response: standardResponseSchema,
      },
      handler: async (request: any, reply: any) => {
        const input = validateBody(z.object({
          templateVersionId: z.string().uuid(),
          bound: z.boolean().optional(),
          defaultEnabled: z.boolean().optional(),
          agentScopes: z.array(z.enum(['Director', 'Writer', 'Reviser', 'Reviewer'])).max(4).optional(),
          chapterScopes: z.array(z.string().max(50)).max(50).optional(),
          projectOverrides: z.record(z.string(), z.unknown()).optional(),
          lockVersion: z.number().int().positive().optional(),
        }), request, reply);
        if (!input) return reply;
        const { projectId, templateId } = request.params;
        try {
          const binding = bindingStore.upsert({ projectId, templateId, ...input });
          return success({ id: binding.id, lockVersion: binding.lockVersion }, request.traceId);
        } catch (error) {
          throw mapBindingError(error);
        }
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:projectId/reference-template-bindings/:templateId',
      schema: {
        params: bindingParamsSchema,
        querystring: emptyQuerySchema,
        response: standardResponseSchema,
      },
      handler: async (request: any) => {
        const { projectId, templateId } = request.params;
        try {
          bindingStore.remove(projectId, templateId);
          return success({ deleted: true }, request.traceId);
        } catch (error) {
          throw mapBindingError(error);
        }
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/reference-template-bindings/resolve',
      schema: {
        params: projectParamsSchema,
        querystring: emptyQuerySchema,
        body: bindingResolveRouteSchema,
        response: standardResponseSchema,
      },
      handler: async (request: any, reply: any) => {
        const input = validateBody(z.object({
          enabled: z.boolean(),
          templateId: z.string().uuid().optional(),
          templateVersionId: z.string().uuid().optional(),
          chapterClassification: z.string().max(100).optional(),
          chapterNumber: z.number().int().positive().optional(),
        }), request, reply);
        if (!input) return reply;
        return success(bindingStore.resolve(request.params.projectId, input), request.traceId);
      },
    },
]
}
