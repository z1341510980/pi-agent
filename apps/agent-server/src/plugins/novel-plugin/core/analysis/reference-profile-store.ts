/**
 * ReferenceProfileStore：P5 参考档案与 finding 审核（方案 §8 P5）。
 *
 * - createProfileFromRun：由 P4 worker 的 book 聚合产物生成 draft profile 版本，
 *   findings 由聚合结果派生（key = category + 序号，稳定可审核）。
 * - 审核：accepted / rejected / edited 三态；强度 hard/soft/reference；
 *   Agent 只允许 Director/Writer/Reviser/Reviewer，Memory 不接收参考分析；
 *   章节范围为空数组表示全局。
 * - 安全报告：直接引用（已在 worker 核对存在）、专名/剧情序列/高独特场景线索、
 *   阻断项（存在 ≥12 字直接引用即阻断，进入 P6 前必须处理）。
 * - 版本比较：四类档案、findings、审核与安全差异；新草稿由批量审核产生。
 */
import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { ReferenceAnalysisRun } from './reference-analysis-run-store.js'

export type ReferenceProfileStatus = 'draft' | 'in_review' | 'active' | 'superseded' | 'archived'
export type ReferenceFindingCategory = 'spirit' | 'technique' | 'power' | 'pacing'
export type ReferenceFindingStrength = 'hard' | 'soft' | 'reference'
export type ReferenceFindingDecision = 'accepted' | 'rejected' | 'edited'
export type ReferenceAgentTarget = 'Director' | 'Writer' | 'Reviser' | 'Reviewer'

export const REFERENCE_AGENT_TARGETS: readonly ReferenceAgentTarget[] = ['Director', 'Writer', 'Reviser', 'Reviewer']

export interface ReferenceFindingReviewState {
  decision: ReferenceFindingDecision | null
  editedObservation: string | null
  editedRule: string | null
  strength: ReferenceFindingStrength | null
  promptEnabled: boolean
  agentTargets: ReferenceAgentTarget[]
  chapterScope: string[]
  note: string | null
  reviewer: string | null
  reviewedAt: number | null
}

export interface ReferenceFinding {
  key: string
  category: ReferenceFindingCategory
  observation: string
  rule: string
  strength: ReferenceFindingStrength
  confidence: number | null
  evidence: string[]
  promptEnabled: boolean
  agentTargets: ReferenceAgentTarget[]
  chapterScope: string[]
  review: ReferenceFindingReviewState | null
}

export interface ReferenceProfile {
  id: string
  analysisRunId: string
  status: ReferenceProfileStatus
  version: number
  parentVersionId: string | null
  profileHash: string
  spirit: { summary: string; rules: string[] }
  technique: { summary: string; rules: string[] }
  power: { summary: string; rules: string[] }
  pacing: { summary: string; rules: string[] }
  findings: ReferenceFinding[]
  safetyReport: ReferenceSafetyReport
  coverage: Record<string, unknown>
  changeSummary: string | null
  createdAt: number
  updatedAt: number
  activatedAt: number | null
}

export interface ReferenceSafetyReport {
  directQuotes: Array<{ prefix: string; length: number }>
  properNouns: string[]
  plotSequences: string[]
  uniqueScenes: string[]
  blockers: string[]
  degraded: boolean
  generatedAt: number
}

export interface ReferenceFindingReviewInput {
  findingKey: string
  decision: ReferenceFindingDecision
  editedObservation?: string
  editedRule?: string
  strength?: ReferenceFindingStrength
  promptEnabled?: boolean
  agentTargets?: ReferenceAgentTarget[]
  chapterScope?: string[]
  note?: string
  reviewer?: string
}

interface ProfileRow {
  id: string; analysis_run_id: string; status: string; version: number; parent_version_id: string | null
  profile_hash: string; spirit_profile: string; technique_profile: string; power_profile: string; pacing_profile: string
  story_elements: string; chapter_patterns: string; findings: string; safety_report: string; coverage: string
  change_summary: string | null; created_at: number; updated_at: number; activated_at: number | null
}

interface ReviewRow {
  id: string; profile_id: string; finding_key: string; decision: string; edited_observation: string | null
  edited_rule: string | null; strength: string | null; prompt_enabled: number; agent_targets: string
  chapter_scope: string; review_note: string | null; reviewer: string; batch_id: string | null; created_at: number
}

export class ReferenceProfileStore {
  constructor(private readonly db: Database.Database) {}

  /** 由 P4 book 聚合产物创建 draft profile v1（同一 run 幂等：已有则返回）。 */
  createProfileFromRun(
    run: ReferenceAnalysisRun,
    book: {
      spirit: { summary: string; rules: string[] }
      technique: { summary: string; rules: string[] }
      power: { summary: string; rules: string[] }
      pacing: { summary: string; rules: string[] }
      findings: Array<{ category: ReferenceFindingCategory; observation: string; rule: string; strength?: ReferenceFindingStrength; evidence?: string[] }>
    },
    verifiedDirectQuotes: string[],
  ): ReferenceProfile {
    const existing = this.db.prepare('SELECT id FROM novel_reference_profiles WHERE analysis_run_id = ?').get(run.id) as { id: string } | undefined
    if (existing) return this.getProfile(existing.id)!

    const now = Date.now()
    const id = randomUUID()
    const categoryCounters = new Map<ReferenceFindingCategory, number>()
    const findings: ReferenceFinding[] = book.findings.map((finding) => {
      const counter = (categoryCounters.get(finding.category) ?? 0) + 1
      categoryCounters.set(finding.category, counter)
      return {
        key: `${finding.category}-${String(counter).padStart(3, '0')}`,
        category: finding.category,
        observation: finding.observation,
        rule: finding.rule,
        strength: finding.strength ?? 'soft',
        confidence: null,
        evidence: (finding.evidence ?? []).slice(0, 5),
        promptEnabled: true,
        agentTargets: [],
        chapterScope: [],
        review: null,
      }
    })
    const safetyReport: ReferenceSafetyReport = {
      directQuotes: verifiedDirectQuotes.map((quote) => ({ prefix: quote.slice(0, 10), length: quote.length })),
      properNouns: [],
      plotSequences: [],
      uniqueScenes: [],
      blockers: verifiedDirectQuotes.length > 0
        ? [`存在 ${verifiedDirectQuotes.length} 条经核实的直接引用（≥12 字），进入应用预览前必须删除或改写`]
        : [],
      degraded: false,
      generatedAt: now,
    }
    const spirit = normalizeProfile(book.spirit)
    const technique = normalizeProfile(book.technique)
    const power = normalizeProfile(book.power)
    const pacing = normalizeProfile(book.pacing)
    const profileHash = hashProfile({ spirit, technique, power, pacing, findings })
    this.db.prepare(`
      INSERT INTO novel_reference_profiles
        (id, analysis_run_id, status, version, parent_version_id, profile_hash,
         spirit_profile, technique_profile, power_profile, pacing_profile,
         findings, safety_report, coverage, change_summary, created_at, updated_at)
      VALUES (?, ?, 'draft', 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, run.id, profileHash,
      JSON.stringify(spirit), JSON.stringify(technique), JSON.stringify(power), JSON.stringify(pacing),
      JSON.stringify(findings), JSON.stringify(safetyReport), JSON.stringify({ sourceId: run.sourceId, runId: run.id }),
      'P4 分析产物生成的初版草稿', now, now,
    )
    return this.getProfile(id)!
  }

  getProfile(id: string): ReferenceProfile | undefined {
    const row = this.db.prepare('SELECT * FROM novel_reference_profiles WHERE id = ?').get(id) as ProfileRow | undefined
    if (!row) return undefined
    const reviews = (this.db.prepare('SELECT * FROM novel_reference_finding_reviews WHERE profile_id = ? ORDER BY created_at ASC').all(id) as ReviewRow[])
      .map(toReview)
    const findings = parseFindings(row.findings).map((finding) => {
      const review = reviews.find((item) => item.findingKey === finding.key) ?? null
      return review ? applyReview(finding, review) : finding
    })
    return {
      id: row.id,
      analysisRunId: row.analysis_run_id,
      status: row.status as ReferenceProfileStatus,
      version: row.version,
      parentVersionId: row.parent_version_id,
      profileHash: row.profile_hash,
      spirit: parseProfile(row.spirit_profile),
      technique: parseProfile(row.technique_profile),
      power: parseProfile(row.power_profile),
      pacing: parseProfile(row.pacing_profile),
      findings,
      safetyReport: parseSafety(row.safety_report),
      coverage: parseObject(row.coverage),
      changeSummary: row.change_summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activatedAt: row.activated_at,
    }
  }

  listVersions(runId: string): ReferenceProfile[] {
    return (this.db.prepare('SELECT id FROM novel_reference_profiles WHERE analysis_run_id = ? ORDER BY version ASC').all(runId) as Array<{ id: string }>)
      .map((row) => this.getProfile(row.id)!)
      .filter((profile): profile is ReferenceProfile => Boolean(profile))
  }

  /** 单项审核（PATCH review）：写入审计行，不动档案本体；返回最新 finding 视图。 */
  reviewFinding(profileId: string, input: ReferenceFindingReviewInput): ReferenceFinding {
    const profile = this.getProfile(profileId)
    if (!profile) throw new Error('参考档案不存在')
    const finding = profile.findings.find((item) => item.key === input.findingKey)
    if (!finding) throw new Error(`finding 不存在: ${input.findingKey}`)
    if (finding.review && finding.review.decision !== null) throw new Error('finding 已审核，如需修改请编辑后生成新草稿版本')
    if (input.agentTargets) {
      const invalid = input.agentTargets.filter((target) => !REFERENCE_AGENT_TARGETS.includes(target))
      if (invalid.length > 0) throw new Error(`Agent 目标不合法: ${invalid.join('、')}（Memory 不接收参考分析）`)
    }
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO novel_reference_finding_reviews
        (id, profile_id, finding_key, decision, edited_observation, edited_rule, strength,
         prompt_enabled, agent_targets, chapter_scope, review_note, reviewer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), profileId, input.findingKey, input.decision,
      input.editedObservation?.slice(0, 2000) ?? null,
      input.editedRule?.slice(0, 2000) ?? null,
      input.strength ?? finding.strength,
      (input.promptEnabled ?? finding.promptEnabled) ? 1 : 0,
      JSON.stringify(input.agentTargets ?? finding.agentTargets),
      JSON.stringify(input.chapterScope ?? finding.chapterScope),
      input.note?.slice(0, 1000) ?? null,
      input.reviewer ?? 'user', now,
    )
    return this.getProfile(profileId)!.findings.find((item) => item.key === input.findingKey)!
  }

  /**
   * 批量审核：全部写入审计后，基于审核结果生成新草稿版本（version+1，parent 指向当前）。
   * edited 决定采用编辑值；rejected 的 finding 不进入新版本的 prompt 生效集。
   */
  reviewBatch(profileId: string, reviews: ReferenceFindingReviewInput[], batchNote?: string): ReferenceProfile {
    const profile = this.getProfile(profileId)
    if (!profile) throw new Error('参考档案不存在')
    const batchId = randomUUID()
    for (const review of reviews) {
      const finding = profile.findings.find((item) => item.key === review.findingKey)
      if (!finding) throw new Error(`finding 不存在: ${review.findingKey}`)
      if (finding.review && finding.review.decision !== null) continue
      this.reviewFinding(profileId, review)
      this.db.prepare('UPDATE novel_reference_finding_reviews SET batch_id = ? WHERE profile_id = ? AND finding_key = ? AND batch_id IS NULL')
        .run(batchId, profileId, review.findingKey)
    }

    const now = Date.now()
    const nextVersion = profile.version + 1
    const nextFindings: ReferenceFinding[] = profile.findings.map((finding) => {
      const review = this.getProfile(profileId)!.findings.find((item) => item.key === finding.key)?.review ?? null
      if (!review) return finding
      if (review.decision === 'rejected') {
        return { ...finding, promptEnabled: false, review }
      }
      if (review.decision === 'edited') {
        return {
          ...finding,
          observation: review.editedObservation ?? finding.observation,
          rule: review.editedRule ?? finding.rule,
          strength: review.strength ?? finding.strength,
          promptEnabled: review.promptEnabled,
          agentTargets: review.agentTargets,
          chapterScope: review.chapterScope,
          review,
        }
      }
      return {
        ...finding,
        strength: review.strength ?? finding.strength,
        promptEnabled: review.promptEnabled,
        agentTargets: review.agentTargets,
        chapterScope: review.chapterScope,
        review,
      }
    })
    const id = randomUUID()
    const profileHash = hashProfile({ spirit: profile.spirit, technique: profile.technique, power: profile.power, pacing: profile.pacing, findings: nextFindings })
    this.db.prepare(`
      INSERT INTO novel_reference_profiles
        (id, analysis_run_id, status, version, parent_version_id, profile_hash,
         spirit_profile, technique_profile, power_profile, pacing_profile,
         findings, safety_report, coverage, change_summary, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, profile.analysisRunId, nextVersion, profile.id, profileHash,
      JSON.stringify(profile.spirit), JSON.stringify(profile.technique), JSON.stringify(profile.power), JSON.stringify(profile.pacing),
      JSON.stringify(nextFindings), JSON.stringify(profile.safetyReport), JSON.stringify(profile.coverage),
      batchNote?.slice(0, 500) ?? `批量审核生成的新草稿（${reviews.length} 项）`, now, now,
    )
    return this.getProfile(id)!
  }

  setStatus(profileId: string, status: ReferenceProfileStatus): ReferenceProfile {
    const now = Date.now()
    if (status === 'active') {
      this.db.prepare(`UPDATE novel_reference_profiles SET status = 'superseded' WHERE analysis_run_id = (SELECT analysis_run_id FROM novel_reference_profiles WHERE id = ?) AND status = 'active'`).run(profileId)
    }
    this.db.prepare('UPDATE novel_reference_profiles SET status = ?, updated_at = ?, activated_at = CASE WHEN ? = \'active\' THEN ? ELSE activated_at END WHERE id = ?')
      .run(status, now, status, now, profileId)
    return this.getProfile(profileId)!
  }

  /** 版本比较：四类档案、findings 审核/强度差异、安全差异。 */
  compare(fromId: string, toId: string): {
    from: { id: string; version: number } | null
    to: { id: string; version: number } | null
    profileChanges: Array<{ category: ReferenceFindingCategory; fromSummary: string; toSummary: string; ruleCountDelta: number }>
    findingChanges: Array<{ key: string; category: ReferenceFindingCategory; from: string; to: string }>
    safetyChanges: { directQuoteCountDelta: number; blockersDelta: number }
  } {
    const from = this.getProfile(fromId) ?? null
    const to = this.getProfile(toId) ?? null
    const profileChanges: Array<{ category: ReferenceFindingCategory; fromSummary: string; toSummary: string; ruleCountDelta: number }> = []
    const findingChanges: Array<{ key: string; category: ReferenceFindingCategory; from: string; to: string }> = []
    if (from && to) {
      for (const category of ['spirit', 'technique', 'power', 'pacing'] as const) {
        const before = from[category]
        const after = to[category]
        if (before.summary !== after.summary || before.rules.length !== after.rules.length) {
          profileChanges.push({ category, fromSummary: before.summary, toSummary: after.summary, ruleCountDelta: after.rules.length - before.rules.length })
        }
      }
      for (const toFinding of to.findings) {
        const fromFinding = from.findings.find((item) => item.key === toFinding.key)
        const fromState = fromFinding
          ? `${fromFinding.review?.decision ?? 'pending'}/${fromFinding.strength}/${fromFinding.promptEnabled ? 'on' : 'off'}`
          : 'new'
        const toState = `${toFinding.review?.decision ?? 'pending'}/${toFinding.strength}/${toFinding.promptEnabled ? 'on' : 'off'}`
        if (fromState !== toState || (fromFinding && (fromFinding.observation !== toFinding.observation || fromFinding.rule !== toFinding.rule))) {
          findingChanges.push({ key: toFinding.key, category: toFinding.category, from: fromState, to: toState })
        }
      }
    }
    return {
      from: from ? { id: from.id, version: from.version } : null,
      to: to ? { id: to.id, version: to.version } : null,
      profileChanges,
      findingChanges,
      safetyChanges: {
        directQuoteCountDelta: (to?.safetyReport.directQuotes.length ?? 0) - (from?.safetyReport.directQuotes.length ?? 0),
        blockersDelta: (to?.safetyReport.blockers.length ?? 0) - (from?.safetyReport.blockers.length ?? 0),
      },
    }
  }
}

function applyReview(finding: ReferenceFinding, review: NonNullable<ReferenceFinding['review']>): ReferenceFinding {
  return {
    ...finding,
    promptEnabled: review.decision === 'rejected' ? false : review.promptEnabled,
    strength: review.strength ?? finding.strength,
    observation: review.decision === 'edited' && review.editedObservation ? review.editedObservation : finding.observation,
    rule: review.decision === 'edited' && review.editedRule ? review.editedRule : finding.rule,
    review,
  }
}

function toReview(row: ReviewRow): ReferenceFindingReviewState & { findingKey: string } {
  return {
    findingKey: row.finding_key,
    decision: row.decision as ReferenceFindingDecision,
    editedObservation: row.edited_observation,
    editedRule: row.edited_rule,
    strength: row.strength as ReferenceFindingStrength | null,
    promptEnabled: row.prompt_enabled === 1,
    agentTargets: parseArray(row.agent_targets).filter((item): item is ReferenceAgentTarget => REFERENCE_AGENT_TARGETS.includes(item as ReferenceAgentTarget)),
    chapterScope: parseArray(row.chapter_scope).filter((item): item is string => typeof item === 'string'),
    note: row.review_note,
    reviewer: row.reviewer,
    reviewedAt: row.created_at,
  }
}

function normalizeProfile(value: { summary?: unknown; rules?: unknown }): { summary: string; rules: string[] } {
  return {
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 2000) : '',
    rules: Array.isArray(value.rules) ? value.rules.filter((rule): rule is string => typeof rule === 'string').slice(0, 20) : [],
  }
}

function parseProfile(value: string): { summary: string; rules: string[] } {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizeProfile(parsed as { summary?: unknown; rules?: unknown })
    }
  } catch { /* fallthrough */ }
  return { summary: '', rules: [] }
}

function parseFindings(value: string): ReferenceFinding[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    const findings: ReferenceFinding[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      const category = candidate.category
      if (category !== 'spirit' && category !== 'technique' && category !== 'power' && category !== 'pacing') continue
      findings.push({
        key: typeof candidate.key === 'string' ? candidate.key : `${category}-${findings.length + 1}`,
        category,
        observation: typeof candidate.observation === 'string' ? candidate.observation : '',
        rule: typeof candidate.rule === 'string' ? candidate.rule : '',
        strength: candidate.strength === 'hard' || candidate.strength === 'reference' ? candidate.strength : 'soft',
        confidence: typeof candidate.confidence === 'number' ? candidate.confidence : null,
        evidence: parseArrayUnknown(candidate.evidence).filter((item): item is string => typeof item === 'string'),
        promptEnabled: candidate.promptEnabled !== false,
        agentTargets: parseArrayUnknown(candidate.agentTargets).filter((item): item is ReferenceAgentTarget => REFERENCE_AGENT_TARGETS.includes(item as ReferenceAgentTarget)),
        chapterScope: parseArrayUnknown(candidate.chapterScope).filter((item): item is string => typeof item === 'string'),
        review: null,
      })
    }
    return findings
  } catch {
    return []
  }
}

function parseSafety(value: string): ReferenceSafetyReport {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return {
      directQuotes: Array.isArray(parsed.directQuotes)
        ? parsed.directQuotes.filter((item): item is { prefix: string; length: number } =>
            Boolean(item) && typeof item === 'object' && typeof (item as Record<string, unknown>).prefix === 'string')
        : [],
      properNouns: parseArrayUnknown(parsed.properNouns).filter((item): item is string => typeof item === 'string'),
      plotSequences: parseArrayUnknown(parsed.plotSequences).filter((item): item is string => typeof item === 'string'),
      uniqueScenes: parseArrayUnknown(parsed.uniqueScenes).filter((item): item is string => typeof item === 'string'),
      blockers: parseArrayUnknown(parsed.blockers).filter((item): item is string => typeof item === 'string'),
      degraded: parsed.degraded === true,
      generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : 0,
    }
  } catch {
    return { directQuotes: [], properNouns: [], plotSequences: [], uniqueScenes: [], blockers: [], degraded: false, generatedAt: 0 }
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseArrayUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function hashProfile(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}
