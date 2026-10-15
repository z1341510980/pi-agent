import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { CompiledRule, ReferenceTemplateStore } from './reference-template-store.js'

export interface ReferenceTemplateBinding {
  id: string
  projectId: string
  templateId: string
  templateVersionId: string
  bound: boolean
  defaultEnabled: boolean
  agentScopes: string[]
  chapterScopes: string[]
  projectOverrides: Record<string, unknown>
  lockVersion: number
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface UpsertReferenceTemplateBindingInput {
  projectId: string
  templateId: string
  templateVersionId: string
  bound?: boolean
  defaultEnabled?: boolean
  agentScopes?: string[]
  chapterScopes?: string[]
  projectOverrides?: Record<string, unknown>
  lockVersion?: number
}

export interface ResolveReferenceTemplateInput {
  enabled: boolean
  templateId?: string
  templateVersionId?: string
  chapterClassification?: string
  chapterNumber?: number
}

export type ReferenceTemplateResolution =
  | { effective: false; reason?: string; rules: EmptyRules }
  | {
      effective: true
      templateId: string
      templateVersionId: string
      agentScopes: string[]
      chapterScopes: string[]
      projectOverrides: Record<string, unknown>
      rules: RuleGroups
      ruleCount: number
    }

export interface RuleGroups {
  spirit: CompiledRule[]
  technique: CompiledRule[]
  power: CompiledRule[]
  pacing: CompiledRule[]
}

interface EmptyRules {
  spirit: []
  technique: []
  power: []
  pacing: []
}

interface BindingRow {
  id: string
  project_id: string
  template_id: string
  template_version_id: string
  bound: number
  default_enabled: number
  agent_scopes: string | null
  chapter_scopes: string | null
  project_overrides: string | null
  lock_version: number
  last_used_at: number | null
  created_at: number
  updated_at: number
}

export class ReferenceTemplateBindingConflictError extends Error {
  constructor(message = '参考模板绑定 lockVersion 已过期') {
    super(message)
    this.name = 'ReferenceTemplateBindingConflictError'
  }
}

export class ReferenceTemplateBindingStore {
  constructor(
    private readonly db: Database.Database,
    private readonly templateStore: ReferenceTemplateStore,
  ) {}

  listByProject(projectId: string): ReferenceTemplateBinding[] {
    const rows = this.db.prepare(`
      SELECT id, project_id, template_id, template_version_id, bound, default_enabled,
             agent_scopes, chapter_scopes, project_overrides, lock_version,
             last_used_at, created_at, updated_at
      FROM novel_project_reference_templates
      WHERE project_id = ?
      ORDER BY updated_at DESC, id ASC
    `).all(projectId) as BindingRow[]
    return rows.map(toBinding)
  }

  upsert(input: UpsertReferenceTemplateBindingInput): ReferenceTemplateBinding {
    this.assertTemplateVersion(input.templateId, input.templateVersionId)
    const existing = this.db.prepare(`
      SELECT id, project_id, template_id, template_version_id, bound, default_enabled,
             agent_scopes, chapter_scopes, project_overrides, lock_version,
             last_used_at, created_at, updated_at
      FROM novel_project_reference_templates
      WHERE project_id = ? AND template_id = ?
    `).get(input.projectId, input.templateId) as BindingRow | undefined
    const now = Date.now()

    if (!existing) {
      const id = randomUUID()
      try {
        this.db.prepare(`
          INSERT INTO novel_project_reference_templates
            (id, project_id, template_id, template_version_id, bound, default_enabled,
             agent_scopes, chapter_scopes, project_overrides, lock_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          id,
          input.projectId,
          input.templateId,
          input.templateVersionId,
          input.bound === false ? 0 : 1,
          input.defaultEnabled === true ? 1 : 0,
          JSON.stringify(input.agentScopes ?? []),
          JSON.stringify(input.chapterScopes ?? []),
          JSON.stringify(input.projectOverrides ?? {}),
          now,
          now,
        )
      } catch (error) {
        throw new Error(`参考模板绑定创建失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return this.getByProjectAndTemplate(input.projectId, input.templateId)!
    }

    const expectedLockVersion = input.lockVersion ?? existing.lock_version
    const result = this.db.prepare(`
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
      input.bound === undefined ? existing.bound : (input.bound ? 1 : 0),
      input.defaultEnabled === undefined ? existing.default_enabled : (input.defaultEnabled ? 1 : 0),
      input.agentScopes === undefined ? existing.agent_scopes ?? '[]' : JSON.stringify(input.agentScopes),
      input.chapterScopes === undefined ? existing.chapter_scopes ?? '[]' : JSON.stringify(input.chapterScopes),
      input.projectOverrides === undefined ? existing.project_overrides ?? '{}' : JSON.stringify(input.projectOverrides),
      now,
      input.projectId,
      input.templateId,
      expectedLockVersion,
    )
    if (result.changes !== 1) throw new ReferenceTemplateBindingConflictError()
    return this.getByProjectAndTemplate(input.projectId, input.templateId)!
  }

  remove(projectId: string, templateId: string): void {
    const result = this.db.prepare(`
      DELETE FROM novel_project_reference_templates
      WHERE project_id = ? AND template_id = ?
    `).run(projectId, templateId)
    if (result.changes !== 1) throw new Error('绑定不存在')
  }

  resolve(projectId: string, input: ResolveReferenceTemplateInput): ReferenceTemplateResolution {
    const empty: EmptyRules = { spirit: [], technique: [], power: [], pacing: [] }
    if (!input.enabled) return { effective: false, rules: empty }

    const candidates = this.listByProject(projectId).filter(binding => {
      if (!binding.bound) return false
      if (input.templateId && binding.templateId !== input.templateId) return false
      if (input.templateVersionId && binding.templateVersionId !== input.templateVersionId) return false
      if (binding.chapterScopes.length === 0) return true
      const chapterValue = input.chapterClassification ?? (input.chapterNumber != null ? String(input.chapterNumber) : undefined)
      return chapterValue != null && binding.chapterScopes.includes(chapterValue)
    })
    if (candidates.length === 0) return { effective: false, reason: '未找到已绑定的模板', rules: empty }

    const binding = candidates[0]!
    const version = this.templateStore.getVersion(binding.templateVersionId)
    if (!version || version.templateId !== binding.templateId) {
      return { effective: false, reason: '模板版本不存在', rules: empty }
    }
    const allRules = {
      spirit: filterRules(version.spiritRules, input.chapterClassification),
      technique: filterRules(version.techniqueRules, input.chapterClassification),
      power: filterRules(version.powerRules, input.chapterClassification),
      pacing: filterRules(version.pacingRules, input.chapterClassification),
    }
    return {
      effective: true,
      templateId: binding.templateId,
      templateVersionId: binding.templateVersionId,
      agentScopes: binding.agentScopes,
      chapterScopes: binding.chapterScopes,
      projectOverrides: binding.projectOverrides,
      rules: allRules,
      ruleCount: Object.values(allRules).reduce((sum, rules) => sum + rules.length, 0),
    }
  }

  private getByProjectAndTemplate(projectId: string, templateId: string): ReferenceTemplateBinding | undefined {
    const row = this.db.prepare(`
      SELECT id, project_id, template_id, template_version_id, bound, default_enabled,
             agent_scopes, chapter_scopes, project_overrides, lock_version,
             last_used_at, created_at, updated_at
      FROM novel_project_reference_templates
      WHERE project_id = ? AND template_id = ?
    `).get(projectId, templateId) as BindingRow | undefined
    return row ? toBinding(row) : undefined
  }

  private assertTemplateVersion(templateId: string, versionId: string): void {
    if (!this.templateStore.getTemplate(templateId)) throw new Error('模板不存在')
    const version = this.templateStore.getVersion(versionId)
    if (!version) throw new Error('模板版本不存在')
    if (version.templateId !== templateId) throw new Error('模板版本不属于指定模板')
  }
}

function toBinding(row: BindingRow): ReferenceTemplateBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    bound: Boolean(row.bound),
    defaultEnabled: Boolean(row.default_enabled),
    agentScopes: parseArray(row.agent_scopes),
    chapterScopes: parseArray(row.chapter_scopes),
    projectOverrides: parseObject(row.project_overrides),
    lockVersion: row.lock_version,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function filterRules(rules: CompiledRule[], chapterClassification?: string): CompiledRule[] {
  if (!chapterClassification) return rules
  return rules.filter(rule => rule.chapterScope.length === 0 || rule.chapterScope.includes(chapterClassification))
}
