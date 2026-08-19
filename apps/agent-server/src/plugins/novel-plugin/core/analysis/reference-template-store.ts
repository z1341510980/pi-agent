/**
 * ReferenceTemplateStore：P6 私人模板与不可变版本链（方案 §9-§10）。
 *
 * - templates 只存元数据（名称/说明/可见性/状态/来源 profile）；规则由
 *   template_versions 承载，版本号递增，published 后不可变。
 * - createTemplateFromProfile：把已审核 profile 的生效 findings 编译为四类规则，
 *   生成 draft 模板 + draft 版本 v1（previewHash 绑定生成时的预览快照）。
 * - createVersionRevision：对 draft 版本的规则/强度/Agent/章节范围修改产生新
 *   draft 版本（parent 指向被修改版本）；published/superseded 版本只读。
 * - publish 由 P8 路由调用（需 validationRunId）；本 store 只负责状态机落库。
 */
import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { ReferenceProfileStore, ReferenceProfile, ReferenceFinding } from './reference-profile-store.js'

export type TemplateStatus = 'draft' | 'published' | "archived"
export type TemplateVersionStatus = 'draft' | 'in_review' | 'published' | "superseded" | 'rolled_back'

export interface CompiledRule {
  findingKey: string
  category: 'spirit' | 'technique' | 'power' | 'pacing'
  rule: string
  strength: 'hard' | 'soft' | 'reference'
  agentScopes: string[]
  chapterScope: string[]
}

export interface ReferenceTemplateVersion {
  id: string
  templateId: string
  version: number
  status: TemplateVersionStatus
  parentVersionId: string | null
  templateHash: string
  profileHash: string | null
  spiritRules: CompiledRule[]
  techniqueRules: CompiledRule[]
  powerRules: CompiledRule[]
  pacingRules: CompiledRule[]
  chapterRuleSets: Array<{ chapterClassification: string; ruleKeys: string[] }>
  defaultAgentScopes: string[]
  projectOverrides: Record<string, unknown>
  validationRunId: string | null
  safetyResult: Record<string, unknown>
  changeSummary: string | null
  createdAt: number
  publishedAt: number | null
}

export interface ReferenceTemplate {
  id: string
  ownerProjectId: string | null
  name: string
  description: string
  visibility: 'private' | 'shared'
  status: TemplateStatus
  currentVersionId: string | null
  sourceProfileId: string | null
  sourceTextState: 'available' | 'deleted'
  bindingCount: number
  versionCount: number
  previewHash: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  deletedAt: number | null
}

interface TemplateRow {
  id: string; owner_project_id: string | null; name: string; description: string; visibility: string
  status: string; current_version_id: string | null; source_profile_id: string | null
  source_text_state: string; binding_count: number; version_count: number; preview_hash: string | null
  created_at: number; updated_at: number; archived_at: number | null; deleted_at: number | null
}

interface VersionRow {
  id: string; template_id: string; version: number; status: string; parent_version_id: string | null
  template_hash: string; profile_hash: string | null; spirit_rules: string; technique_rules: string
  power_rules: string; pacing_rules: string; chapter_rule_sets: string; default_agent_scopes: string
  project_overrides: string; validation_run_id: string | null; safety_result: string
  change_summary: string | null; created_at: number; published_at: number | null
}

/** Agent Prompt 字符预算（方案 §9 P6 建议值；超限必须告警或阻断） */
export const AGENT_PROMPT_BUDGETS: Record<string, number> = {
  Writer: 3500,
  Director: 2000,
  Reviser: 2000,
  Reviewer: 2000,
}

export class ReferenceTemplateStore {
  constructor(
    private readonly db: Database.Database,
    private readonly profileStore: ReferenceProfileStore,
  ) {}

  /** 从已审核档案创建 draft 模板 + 版本 v1（同一 profile 幂等）。 */
  createTemplateFromProfile(input: {
    profileId: string
    name: string
    description?: string
    ownerProjectId?: string | null
    findingKeys?: string[]
    defaultAgentScopes?: string[]
    chapterRuleSets?: Array<{ chapterClassification: string; ruleKeys: string[] }>
    previewHash?: string
  }): { template: ReferenceTemplate; version: ReferenceTemplateVersion } {
    const profile = this.profileStore.getProfile(input.profileId)
    if (!profile) throw new Error('参考档案不存在')

    // 检查是否所有 finding 都已审核
    const reviewRows = this.db.prepare(
      'SELECT DISTINCT finding_key FROM novel_reference_finding_reviews WHERE profile_id = ?'
    ).all(profile.id) as Array<{ finding_key: string }>
    const reviewedKeys = new Set(reviewRows.map(r => r.finding_key))
    const pendingFindings = profile.findings.filter(f => !reviewedKeys.has(f.key))
    if (pendingFindings.length > 0) {
      const pendingKeys = pendingFindings.map(f => f.key).join('、')
      throw new Error(`档案仍有 ${pendingFindings.length} 项 finding 未审核（reviewCount=${reviewRows.length}, totalFindings=${profile.findings.length}，未审核: ${pendingKeys}），完成审核后才能创建模板`)
    }

    const existing = this.db.prepare('SELECT id FROM novel_reference_templates WHERE source_profile_id = ?').get(profile.id) as { id: string } | undefined
    if (existing) {
      const template = this.getTemplate(existing.id)!
      return { template, version: this.getVersion(template.currentVersionId!)! }
    }

    console.log('[createTemplateFromProfile] calling compileRules with findingKeys:', input.findingKeys);
    const rules = compileRules(profile, input.findingKeys)
    console.log('[createTemplateFromProfile] compileRules result:', {
      spirit: rules.spirit.length,
      technique: rules.technique.length,
      power: rules.power.length,
      pacing: rules.pacing.length
    });
    const now = Date.now()
    const templateId = randomUUID()
    const versionId = randomUUID()
    const templateHash = hashRules(rules)
    console.log('[createTemplateFromProfile] templateHash:', templateHash);

    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO novel_reference_templates
            (id, owner_project_id, name, description, visibility, status, current_version_id,
             source_profile_id, source_text_state, version_count, preview_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'private', 'draft', ?, ?, 'available', 1, ?, ?, ?)
        `).run(templateId, input.ownerProjectId ?? null, input.name, input.description ?? '', versionId, profile.id, input.previewHash ?? null, now, now)

        this.db.prepare(`
          INSERT INTO novel_reference_template_versions
            (id, template_id, version, status, parent_version_id, template_hash, profile_hash,
             spirit_rules, technique_rules, power_rules, pacing_rules, chapter_rule_sets,
             default_agent_scopes, safety_result, change_summary, created_at)
          VALUES (?, ?, 1, 'draft', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          versionId, templateId, templateHash, profile.profileHash,
          JSON.stringify(rules.spirit), JSON.stringify(rules.technique), JSON.stringify(rules.power), JSON.stringify(rules.pacing),
          JSON.stringify(input.chapterRuleSets ?? []), JSON.stringify(input.defaultAgentScopes ?? ['Writer']),
          JSON.stringify({ blockers: profile.safetyReport.blockers, directQuotes: profile.safetyReport.directQuotes.length }),
          '从参考档案生成的初版草稿', now,
        )
      })()
    } catch (err) {
      console.error('[createTemplateFromProfile] 事务异常:', err)
      if (err instanceof Error) {
        console.error('错误消息:', err.message)
        console.error('错误堆栈:', err.stack)
      }
      console.error('profile.id:', profile.id)
      console.error('profile.profileHash:', profile.profileHash)
      console.error('templateId:', templateId)
      console.error('versionId:', versionId)
      console.error('templateHash:', templateHash)
      console.error('rules.spirit:', JSON.stringify(rules.spirit, null, 2))
      console.error('rules.technique:', JSON.stringify(rules.technique, null, 2))
      console.error('rules.power:', JSON.stringify(rules.power, null, 2))
      console.error('rules.pacing:', JSON.stringify(rules.pacing, null, 2))
      throw err
    }

    const resultTemplate = this.getTemplate(templateId)
    const resultVersion = this.getVersion(versionId)
    if (!resultTemplate || !resultVersion) {
      throw new Error('创建模板后无法读取模板或版本')
    }
    return { template: resultTemplate, version: resultVersion }
  }

  getTemplate(id: string): ReferenceTemplate | undefined {
    const row = this.db.prepare('SELECT * FROM novel_reference_templates WHERE id = ?').get(id) as TemplateRow | undefined
    return row ? toTemplate(row) : undefined
  }

  listTemplates(filter: { status?: string; ownerProjectId?: string } = {}): ReferenceTemplate[] {
    const conditions: string[] = ['deleted_at IS NULL']
    const params: Array<string> = []
    if (filter.status) { conditions.push('status = ?'); params.push(filter.status) }
    if (filter.ownerProjectId) { conditions.push('owner_project_id = ?'); params.push(filter.ownerProjectId) }
    return (this.db.prepare(`SELECT * FROM novel_reference_templates WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`).all(...params) as TemplateRow[]).map(toTemplate)
  }

  getVersion(id: string): ReferenceTemplateVersion | undefined {
    const row = this.db.prepare('SELECT * FROM novel_reference_template_versions WHERE id = ?').get(id) as VersionRow | undefined
    return row ? toVersion(row) : undefined
  }

  listVersions(templateId: string): ReferenceTemplateVersion[] {
    return (this.db.prepare('SELECT * FROM novel_reference_template_versions WHERE template_id = ? ORDER BY version ASC').all(templateId) as VersionRow[]).map(toVersion)
  }

  updateTemplateMeta(id: string, patch: { name?: string; description?: string }): ReferenceTemplate {
    const current = this.getTemplate(id)
    if (!current) throw new Error('模板不存在')
    this.db.prepare('UPDATE novel_reference_templates SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? current.name, patch.description ?? current.description, Date.now(), id)
    return this.getTemplate(id)!
  }

  /** 对 draft 版本的规则修改产生新 draft 版本；不可变版本抛错。 */
  createVersionRevision(input: {
    versionId: string
    ruleOverrides?: Array<{ findingKey: string; rule?: string; strength?: 'hard' | 'soft' | 'reference'; agentScopes?: string[]; chapterScope?: string[] }>
    defaultAgentScopes?: string[]
    chapterRuleSets?: Array<{ chapterClassification: string; ruleKeys: string[] }>
    changeSummary?: string
  }): ReferenceTemplateVersion {
    const base = this.getVersion(input.versionId)
    if (!base) throw new Error('模板版本不存在')
    if (base.status !== 'draft' && base.status !== 'rolled_back') {
      throw new Error('已发布或已取代的版本不可修改，请基于当前 draft 创建修订')
    }
    const overrideMap = new Map((input.ruleOverrides ?? []).map((item) => [item.findingKey, item]))
    const applyOverrides = (rules: CompiledRule[]): CompiledRule[] =>
      rules.map((rule) => {
        const override = overrideMap.get(rule.findingKey)
        if (!override) return rule
        return {
          ...rule,
          rule: override.rule ?? rule.rule,
          strength: override.strength ?? rule.strength,
          agentScopes: override.agentScopes ?? rule.agentScopes,
          chapterScope: override.chapterScope ?? rule.chapterScope,
        }
      })
    const spiritRules = applyOverrides(base.spiritRules)
    const techniqueRules = applyOverrides(base.techniqueRules)
    const powerRules = applyOverrides(base.powerRules)
    const pacingRules = applyOverrides(base.pacingRules)
    const allRules = [...spiritRules, ...techniqueRules, ...powerRules, ...pacingRules]

    const now = Date.now()
    const id = randomUUID()
    const versions = this.listVersions(base.templateId)
    const nextVersion = Math.max(...versions.map(v => v.version), 0) + 1
    const templateHash = hashRules({ spirit: spiritRules, technique: techniqueRules, power: powerRules, pacing: pacingRules })

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO novel_reference_template_versions
          (id, template_id, version, status, parent_version_id, template_hash, profile_hash,
           spirit_rules, technique_rules, power_rules, pacing_rules, chapter_rule_sets,
           default_agent_scopes, project_overrides, safety_result, change_summary, created_at)
        VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, base.templateId, nextVersion, base.id, templateHash, base.profileHash,
        JSON.stringify(spiritRules), JSON.stringify(techniqueRules), JSON.stringify(powerRules), JSON.stringify(pacingRules),
        JSON.stringify(input.chapterRuleSets ?? base.chapterRuleSets),
        JSON.stringify(input.defaultAgentScopes ?? base.defaultAgentScopes),
        JSON.stringify(base.projectOverrides),
        JSON.stringify({ ...base.safetyResult, ruleCount: allRules.length }),
        input.changeSummary?.slice(0, 500) ?? '规则修订产生的新草稿', now,
      )
      this.db.prepare('UPDATE novel_reference_templates SET current_version_id = ?, version_count = ?, updated_at = ? WHERE id = ?')
        .run(id, this.listVersions(base.templateId).length, now, base.templateId)
    })()
    return this.getVersion(id)!
  }

  /** P8 发布前置：记录验证 run 并置 published（不可变）。 */
  publishVersion(versionId: string, validationRunId: string): ReferenceTemplateVersion {
    const version = this.getVersion(versionId)
    if (!version) throw new Error('模板版本不存在')
    if (version.status === 'published') throw new Error('版本已发布（不可变）')
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE novel_reference_template_versions SET status = "superseded" WHERE template_id = ? AND status = 'published'`).run(version.templateId)
      this.db.prepare(`UPDATE novel_reference_template_versions SET status = 'published', validation_run_id = ?, published_at = ? WHERE id = ?`).run(validationRunId, now, versionId)
      this.db.prepare(`UPDATE novel_reference_templates SET status = 'published', current_version_id = ?, updated_at = ? WHERE id = ?`).run(versionId, now, version.templateId)
    })()
    return this.getVersion(versionId)!
  }

  copyTemplate(templateId: string, newName?: string, ownerProjectId?: string | null): ReferenceTemplate {
    const source = this.getTemplate(templateId)
    if (!source) throw new Error('源模板不存在')
    const base = source.currentVersionId ? this.getVersion(source.currentVersionId) : undefined
    if (!base) throw new Error('当前版本不存在')
    const nextTemplateId = randomUUID()
    const nextVersionId = randomUUID()
    const now = Date.now()
    const rules = { spirit: base.spiritRules, technique: base.techniqueRules, power: base.powerRules, pacing: base.pacingRules }
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO novel_reference_templates (id, owner_project_id, name, description, visibility, status, current_version_id, source_profile_id, source_text_state, version_count, preview_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'private', 'draft', ?, ?, ?, 1, ?, ?, ?)`).run(nextTemplateId, ownerProjectId ?? source.ownerProjectId, newName ?? source.name + ' (副本)', source.description, nextVersionId, source.sourceProfileId, source.sourceTextState, source.previewHash, now, now)
      this.db.prepare(`INSERT INTO novel_reference_template_versions (id, template_id, version, status, parent_version_id, template_hash, profile_hash, spirit_rules, technique_rules, power_rules, pacing_rules, chapter_rule_sets, default_agent_scopes, project_overrides, safety_result, change_summary, created_at) VALUES (?, ?, 1, 'draft', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nextVersionId, nextTemplateId, hashRules(rules), base.profileHash, JSON.stringify(rules.spirit), JSON.stringify(rules.technique), JSON.stringify(rules.power), JSON.stringify(rules.pacing), JSON.stringify(base.chapterRuleSets), JSON.stringify(base.defaultAgentScopes), JSON.stringify(base.projectOverrides), JSON.stringify(base.safetyResult), '模板副本', now)
    })()
    return this.getTemplate(nextTemplateId)!
  }

  rollbackTemplate(templateId: string, targetVersionId: string, changeSummary?: string): ReferenceTemplate {
    const template = this.getTemplate(templateId)
    const target = this.getVersion(targetVersionId)
    if (!template) throw new Error('模板不存在')
    if (!target || target.templateId !== templateId) throw new Error('目标版本不属于该模板')
    const versions = this.listVersions(templateId)
    const nextId = randomUUID()
    const now = Date.now()
    const rules = { spirit: target.spiritRules, technique: target.techniqueRules, power: target.powerRules, pacing: target.pacingRules }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE novel_reference_template_versions SET status = "superseded" WHERE template_id = ? AND status = 'draft'`).run(templateId)
      this.db.prepare(`INSERT INTO novel_reference_template_versions (id, template_id, version, status, parent_version_id, template_hash, profile_hash, spirit_rules, technique_rules, power_rules, pacing_rules, chapter_rule_sets, default_agent_scopes, project_overrides, safety_result, change_summary, created_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nextId, templateId, Math.max(...versions.map(v => v.version)) + 1, target.id, hashRules(rules), target.profileHash, JSON.stringify(rules.spirit), JSON.stringify(rules.technique), JSON.stringify(rules.power), JSON.stringify(rules.pacing), JSON.stringify(target.chapterRuleSets), JSON.stringify(target.defaultAgentScopes), JSON.stringify(target.projectOverrides), JSON.stringify(target.safetyResult), changeSummary ?? '模板回滚', now)
      this.db.prepare(`UPDATE novel_reference_templates SET current_version_id = ?, version_count = ?, updated_at = ? WHERE id = ?`).run(nextId, versions.length + 1, now, templateId)
    })()
    return this.getTemplate(templateId)!
  }

  getDeletionImpact(templateId: string): { boundProjects: string[]; usedInChapters: number; canDelete: boolean; blockers: string[] } {
    const template = this.getTemplate(templateId)
    if (!template) throw new Error('模板不存在')
    const boundProjects = (this.db.prepare('SELECT project_id FROM novel_project_reference_templates WHERE template_id = ? AND bound = 1').all(templateId) as Array<{ project_id: string }>).map(row => row.project_id)
    const usedInChapters = (this.db.prepare('SELECT COUNT(*) AS count FROM novel_reference_template_usages WHERE template_version_id IN (SELECT id FROM novel_reference_template_versions WHERE template_id = ?)').get(templateId) as { count: number }).count
    const blockers: string[] = []
    if (boundProjects.length > 0) blockers.push('存在项目绑定')
    if (usedInChapters > 0) blockers.push('存在章节使用记录')
    return { boundProjects, usedInChapters, canDelete: blockers.length === 0 && template.status !== 'published', blockers }
  }

  deleteTemplate(templateId: string, mode: 'archive' | 'purge'): void {
    if (!this.getTemplate(templateId)) throw new Error('模板不存在')
    if (mode === 'archive') {
      const now = Date.now()
      this.db.prepare('UPDATE novel_reference_templates SET status = "archived", archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, templateId)
      return
    }
    const impact = this.getDeletionImpact(templateId)
    if (!impact.canDelete) throw new Error('模板存在删除阻断项')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM novel_reference_template_versions WHERE template_id = ?').run(templateId)
      this.db.prepare('DELETE FROM novel_reference_templates WHERE id = ?').run(templateId)
    })()
  }
}

function toTemplate(row: TemplateRow): ReferenceTemplate {
  return {
    id: row.id, ownerProjectId: row.owner_project_id, name: row.name, description: row.description,
    visibility: row.visibility as 'private' | 'shared', status: row.status as TemplateStatus,
    currentVersionId: row.current_version_id, sourceProfileId: row.source_profile_id,
    sourceTextState: row.source_text_state as 'available' | 'deleted',
    bindingCount: row.binding_count, versionCount: row.version_count, previewHash: row.preview_hash,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at, deletedAt: row.deleted_at,
  }
}

function toVersion(row: VersionRow): ReferenceTemplateVersion {
  const parseRules = (value: string): CompiledRule[] => {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed)
        ? parsed.filter((item): item is CompiledRule =>
            Boolean(item) && typeof item === 'object' && typeof (item as CompiledRule).rule === 'string')
        : []
    } catch {
      return []
    }
  }
  const parseArray = <T>(value: string): T[] => {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed as T[] : []
    } catch {
      return []
    }
  }
  const parseObject = (value: string): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return {
    id: row.id, templateId: row.template_id, version: row.version, status: row.status as TemplateVersionStatus,
    parentVersionId: row.parent_version_id, templateHash: row.template_hash, profileHash: row.profile_hash,
    spiritRules: parseRules(row.spirit_rules), techniqueRules: parseRules(row.technique_rules),
    powerRules: parseRules(row.power_rules), pacingRules: parseRules(row.pacing_rules),
    chapterRuleSets: parseArray(row.chapter_rule_sets), defaultAgentScopes: parseArray(row.default_agent_scopes),
    projectOverrides: parseObject(row.project_overrides), validationRunId: row.validation_run_id,
    safetyResult: parseObject(row.safety_result), changeSummary: row.change_summary,
    createdAt: row.created_at, publishedAt: row.published_at,
  }
}

export function compileRules(
  profile: ReferenceProfile,
  findingKeys?: string[]
): { spirit: CompiledRule[]; technique: CompiledRule[]; power: CompiledRule[]; pacing: CompiledRule[] } {
  console.log('[compileRules] profile.id:', profile.id);
  console.log('[compileRules] profile.findings count:', profile.findings.length);
  console.log('[compileRules] findingKeys:', findingKeys);
  const targetKeys = findingKeys ? new Set(findingKeys) : null
  const findings = profile.findings.filter(f => f.promptEnabled !== false && (!targetKeys || targetKeys.has(f.key)))
  console.log('[compileRules] findings after filter:', findings.length);
  const result = { spirit: [] as CompiledRule[], technique: [] as CompiledRule[], power: [] as CompiledRule[], pacing: [] as CompiledRule[] }
  for (const finding of findings) {
    console.log('[compileRules] processing finding:', finding.key, 'category:', finding.category);
    const rule: CompiledRule = {
      findingKey: finding.key,
      category: finding.category,
      rule: finding.rule,
      strength: finding.strength || 'soft',
      agentScopes: (finding.agentTargets && finding.agentTargets.length > 0) ? finding.agentTargets : ['Writer'],
      chapterScope: (finding.chapterScope && finding.chapterScope.length > 0) ? finding.chapterScope : [],
    }
    result[finding.category].push(rule)
  }
  console.log('[compileRules] result counts:', { spirit: result.spirit.length, technique: result.technique.length, power: result.power.length, pacing: result.pacing.length });
  return result
}

function hashRules(rules: { spirit: CompiledRule[]; technique: CompiledRule[]; power: CompiledRule[]; pacing: CompiledRule[] }): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex')
}