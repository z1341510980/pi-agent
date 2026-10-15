import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { novelMigrations } from '../novel-migrations.js'
import { ReferenceTemplateBindingStore } from '../core/analysis/reference-template-binding-store.js'
import { ReferenceTemplateStore } from '../core/analysis/reference-template-store.js'
import { ReferenceProfileStore } from '../core/analysis/reference-profile-store.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function seedTemplate(db: Database.Database): { projectId: string; templateId: string; versionId: string } {
  const projectId = randomUUID()
  const templateId = randomUUID()
  const versionId = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO novel_projects (id, title, genre, synopsis, target_words, current_volume, current_chapter, current_stage, status, created_at, updated_at)
    VALUES (?, '绑定测试项目', 'test', '', 3000, 1, 0, 'setup', 'active', ?, ?)
  `).run(projectId, now, now)
  db.prepare(`
    INSERT INTO novel_reference_templates
      (id, owner_project_id, name, description, visibility, status, current_version_id, source_profile_id, source_text_state, version_count, preview_hash, created_at, updated_at)
    VALUES (?, ?, '绑定测试模板', '', 'private', 'draft', ?, NULL, 'available', 1, NULL, ?, ?)
  `).run(templateId, projectId, versionId, now, now)
  db.prepare(`
    INSERT INTO novel_reference_template_versions
      (id, template_id, version, status, parent_version_id, template_hash, profile_hash,
       spirit_rules, technique_rules, power_rules, pacing_rules, chapter_rule_sets,
       default_agent_scopes, project_overrides, safety_result, change_summary, created_at)
    VALUES (?, ?, 1, 'draft', NULL, 'hash', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'test', ?)
  `).run(
    versionId,
    templateId,
    JSON.stringify([{ findingKey: 'spirit-1', category: 'spirit', rule: '克制', strength: 'soft', agentScopes: ['Writer'], chapterScope: [] }]),
    '[]', '[]',
    JSON.stringify([{ findingKey: 'pace-1', category: 'pacing', rule: '留钩子', strength: 'hard', agentScopes: ['Writer'], chapterScope: ['turn'] }]),
    '[]', JSON.stringify(['Writer']), '{}', '{}', now,
  )
  return { projectId, templateId, versionId }
}

describe('ReferenceTemplateBindingStore', () => {
  let db: Database.Database
  let store: ReferenceTemplateBindingStore

  beforeEach(() => {
    db = createDb()
    const profiles = new ReferenceProfileStore(db)
    const templates = new ReferenceTemplateStore(db, profiles)
    store = new ReferenceTemplateBindingStore(db, templates)
  })

  it('creates and maps a project binding, preserving omitted fields on update', () => {
    const seed = seedTemplate(db)
    const created = store.upsert({
      projectId: seed.projectId,
      templateId: seed.templateId,
      templateVersionId: seed.versionId,
      bound: true,
      defaultEnabled: true,
      agentScopes: ['Writer'],
      chapterScopes: ['turn'],
      projectOverrides: { tone: 'restrained' },
    })

    expect(created).toMatchObject({
      projectId: seed.projectId,
      templateId: seed.templateId,
      templateVersionId: seed.versionId,
      bound: true,
      defaultEnabled: true,
      agentScopes: ['Writer'],
      chapterScopes: ['turn'],
      projectOverrides: { tone: 'restrained' },
      lockVersion: 1,
    })

    const updated = store.upsert({
      projectId: seed.projectId,
      templateId: seed.templateId,
      templateVersionId: seed.versionId,
      lockVersion: created.lockVersion,
      projectOverrides: { tone: 'urgent' },
    })
    expect(updated).toMatchObject({
      bound: true,
      defaultEnabled: true,
      agentScopes: ['Writer'],
      chapterScopes: ['turn'],
      projectOverrides: { tone: 'urgent' },
      lockVersion: 2,
    })
  })

  it('rejects stale optimistic lock and a version belonging to another template', () => {
    const seed = seedTemplate(db)
    const otherTemplateId = randomUUID()
    const otherVersionId = randomUUID()
    const now = Date.now()
    db.prepare(`
      INSERT INTO novel_reference_templates
        (id, owner_project_id, name, description, visibility, status, current_version_id, source_profile_id, source_text_state, version_count, preview_hash, created_at, updated_at)
      VALUES (?, ?, '另一个模板', '', 'private', 'draft', ?, NULL, 'available', 1, NULL, ?, ?)
    `).run(otherTemplateId, seed.projectId, otherVersionId, now, now)
    db.prepare(`
      INSERT INTO novel_reference_template_versions
        (id, template_id, version, status, parent_version_id, template_hash, profile_hash,
         spirit_rules, technique_rules, power_rules, pacing_rules, chapter_rule_sets,
         default_agent_scopes, project_overrides, safety_result, change_summary, created_at)
      VALUES (?, ?, 1, 'draft', NULL, 'hash-2', NULL, '[]', '[]', '[]', '[]', '[]', '[]', '{}', '{}', 'test', ?)
    `).run(otherVersionId, otherTemplateId, now)
    const created = store.upsert({ projectId: seed.projectId, templateId: seed.templateId, templateVersionId: seed.versionId })

    expect(() => store.upsert({
      projectId: seed.projectId,
      templateId: seed.templateId,
      templateVersionId: seed.versionId,
      lockVersion: created.lockVersion - 1,
    })).toThrow(/lock/i)

    expect(() => store.upsert({
      projectId: seed.projectId,
      templateId: seed.templateId,
      templateVersionId: otherVersionId,
    })).toThrow(/属于|template/i)
  })

  it('resolves the selected binding and filters rules by chapter classification', () => {
    const seed = seedTemplate(db)
    store.upsert({
      projectId: seed.projectId,
      templateId: seed.templateId,
      templateVersionId: seed.versionId,
      bound: true,
      agentScopes: ['Writer'],
      chapterScopes: ['turn'],
    })

    const resolved = store.resolve(seed.projectId, {
      enabled: true,
      templateId: seed.templateId,
      chapterClassification: 'turn',
    })
    expect(resolved).toMatchObject({
      effective: true,
      templateId: seed.templateId,
      templateVersionId: seed.versionId,
      agentScopes: ['Writer'],
      chapterScopes: ['turn'],
    })
    expect(resolved.rules.pacing).toHaveLength(1)

    const disabled = store.resolve(seed.projectId, { enabled: false })
    expect(disabled).toEqual({ effective: false, rules: { spirit: [], technique: [], power: [], pacing: [] } })
  })
})
