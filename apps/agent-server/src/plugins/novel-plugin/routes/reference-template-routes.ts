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
import { AppError, ErrorCode } from '@repo/shared/errors'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { closeSse, sendSseComment, sendSseEvent, setupSse } from '../../../lib/sse.js'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { buildApplicationPreview } from '../core/analysis/reference-application-preview.js'
import { validateScenarioSafety } from '../core/analysis/reference-validation-run-worker.js'

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

export function createReferenceTemplateRoutes(services: NovelServices): RouteDefinition[] {
  const reference = services.referenceAnalysis
  if (!reference) return []
  const profileStore = services.referenceProfiles
  const templateStore = services.referenceTemplates
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
      handler: async (request: any) => {
        const projectId = request.params.projectId;
        const rows = services.context.db.prepare(`
          SELECT id, template_id, template_version_id, bound, default_enabled, agent_scopes, chapter_scopes, project_overrides, lock_version, last_used_at, created_at, updated_at
          FROM novel_project_reference_templates
          WHERE project_id = ?
          ORDER BY updated_at DESC
        `).all(projectId) as Array<{
          id: string; template_id: string; template_version_id: string; bound: number;
          default_enabled: number; agent_scopes: string; chapter_scopes: string;
          project_overrides: string; lock_version: number; last_used_at: number | null;
          created_at: number; updated_at: number;
        }>;
        const bindings = rows.map((row) => ({
          id: row.id,
          templateId: row.template_id,
          templateVersionId: row.template_version_id,
          bound: Boolean(row.bound),
          defaultEnabled: Boolean(row.default_enabled),
          agentScopes: JSON.parse(row.agent_scopes || '[]'),
          chapterScopes: JSON.parse(row.chapter_scopes || '[]'),
          projectOverrides: JSON.parse(row.project_overrides || '{}'),
          lockVersion: row.lock_version,
          lastUsedAt: row.last_used_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
        return success(bindings, request.traceId);
      },
    },
    {
      method: 'PUT',
      path: '/projects/:projectId/reference-template-bindings/:templateId',
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
        const version = templateStore.getVersion(input.templateVersionId);
        if (!version) throw new AppError(ErrorCode.NOT_FOUND, '模板版本不存在', 404);
        const template = templateStore.getTemplate(templateId);
        if (!template) throw new AppError(ErrorCode.NOT_FOUND, '模板不存在', 404);
        const now = Date.now();
        const existing = services.context.db.prepare(`
          SELECT id, lock_version FROM novel_project_reference_templates
          WHERE project_id = ? AND template_id = ?
        `).get(projectId, templateId) as { id: string; lock_version: number } | undefined;
        let result: any;
        if (existing) {
          const lockVersion = input.lockVersion ?? existing.lock_version;
          services.context.db.prepare(`
            UPDATE novel_project_reference_templates SET
              template_version_id = ?,
              bound = ?,
              default_enabled = ?,
              agent_scopes = ?,
              chapter_scopes = ?,
              project_overrides = ?,
              lock_version = lock_version + 1,
              updated_at = ?
            WHERE project_id = ? AND template_id = ? AND lock_version = ?
          `).run(
            input.templateVersionId,
            input.bound !== undefined ? (input.bound ? 1 : 0) : 1,
            input.defaultEnabled !== undefined ? (input.defaultEnabled ? 1 : 0) : 0,
            JSON.stringify(input.agentScopes ?? []),
            JSON.stringify(input.chapterScopes ?? []),
            JSON.stringify(input.projectOverrides ?? {}),
            now, projectId, templateId, lockVersion
          );
          const updated = services.context.db.prepare(`
            SELECT id, lock_version FROM novel_project_reference_templates
            WHERE project_id = ? AND template_id = ?
          `).get(projectId, templateId) as { id: string; lock_version: number };
          result = { id: updated.id, lockVersion: updated.lock_version };
        } else {
          const id = require('node:crypto').randomUUID();
          services.context.db.prepare(`
            INSERT INTO novel_project_reference_templates
              (id, project_id, template_id, template_version_id, bound, default_enabled,
               agent_scopes, chapter_scopes, project_overrides, lock_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          `).run(
            id, projectId, templateId, input.templateVersionId,
            input.bound !== undefined ? (input.bound ? 1 : 0) : 1,
            input.defaultEnabled !== undefined ? (input.defaultEnabled ? 1 : 0) : 0,
            JSON.stringify(input.agentScopes ?? []),
            JSON.stringify(input.chapterScopes ?? []),
            JSON.stringify(input.projectOverrides ?? {}),
            now, now
          );
          result = { id, lockVersion: 1 };
        }
        return success(result, request.traceId);
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:projectId/reference-template-bindings/:templateId',
      handler: async (request: any) => {
        const { projectId, templateId } = request.params;
        const existing = services.context.db.prepare(`
          SELECT id FROM novel_project_reference_templates
          WHERE project_id = ? AND template_id = ?
        `).get(projectId, templateId) as { id: string } | undefined;
        if (!existing) throw new AppError(ErrorCode.NOT_FOUND, '绑定不存在', 404);
        services.context.db.prepare(`
          DELETE FROM novel_project_reference_templates
          WHERE project_id = ? AND template_id = ?
        `).run(projectId, templateId);
        return success({ deleted: true }, request.traceId);
      },
    },
    {
      method: 'POST',
      path: '/projects/:projectId/reference-template-bindings/resolve',
      handler: async (request: any, reply: any) => {
        const input = validateBody(z.object({
          enabled: z.boolean(),
          templateId: z.string().uuid().optional(),
          templateVersionId: z.string().uuid().optional(),
          chapterClassification: z.string().max(100).optional(),
          chapterNumber: z.number().int().positive().optional(),
        }), request, reply);
        if (!input) return reply;
        const projectId = request.params.projectId;
        // 从项目绑定中查找已绑定的模板
        let bindings = services.context.db.prepare(`
          SELECT template_id, template_version_id, default_enabled, agent_scopes, chapter_scopes, project_overrides
          FROM novel_project_reference_templates
          WHERE project_id = ? AND bound = 1
        `).all(projectId) as Array<{
          template_id: string; template_version_id: string; default_enabled: number;
          agent_scopes: string; chapter_scopes: string; project_overrides: string;
        }>;
        if (!input.enabled || bindings.length === 0) {
          return success({ effective: false, rules: { spirit: [], technique: [], power: [], pacing: [] } }, request.traceId);
        }
        // 如果指定了 templateId，只使用该模板
        if (input.templateId) {
          bindings = bindings.filter((b) => b.template_id === input.templateId);
        }
        if (bindings.length === 0) {
          return success({ effective: false, reason: '未找到已绑定的模板' }, request.traceId);
        }
        // 使用第一个绑定的模板版本
        const binding = bindings[0];
        const version = templateStore.getVersion(binding.template_version_id);
        if (!version) {
          return success({ effective: false, reason: '模板版本不存在' }, request.traceId);
        }
        // 编译规则
        const allRules = [...version.spiritRules, ...version.techniqueRules, ...version.powerRules, ...version.pacingRules];
        // 如果指定了章节分类，过滤规则
        let filteredRules = allRules;
        if (input.chapterClassification) {
          filteredRules = allRules.filter((rule) =>
            rule.chapterScope.includes(input.chapterClassification!) || rule.chapterScope.length === 0
          );
        }
        const rules = {
          spirit: version.spiritRules.filter((rule) => filteredRules.includes(rule)),
          technique: version.techniqueRules.filter((rule) => filteredRules.includes(rule)),
          power: version.powerRules.filter((rule) => filteredRules.includes(rule)),
          pacing: version.pacingRules.filter((rule) => filteredRules.includes(rule)),
        };
        const agentScopes = JSON.parse(binding.agent_scopes || '[]') as string[];
        const chapterScopes = JSON.parse(binding.chapter_scopes || '[]') as string[];
        const projectOverrides = JSON.parse(binding.project_overrides || '{}') as Record<string, unknown>;
        return success({
          effective: true,
          templateId: binding.template_id,
          templateVersionId: binding.template_version_id,
          agentScopes,
          chapterScopes,
          projectOverrides,
          rules,
          ruleCount: rules.spirit.length + rules.technique.length + rules.power.length + rules.pacing.length,
        }, request.traceId);
      },
    },
]
}