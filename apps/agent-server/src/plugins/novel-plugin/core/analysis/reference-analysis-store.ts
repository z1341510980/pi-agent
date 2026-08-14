import type Database from 'better-sqlite3'
import type {
  ReferenceFileFormat,
  ReferenceInputKind,
  ReferenceLocalAnalysisReport,
  ReferenceQualityReport,
  ReferenceRetentionPolicy,
  ReferenceSection,
  ReferenceSourceDetail,
  ReferenceTextEncoding
} from '@repo/shared/novel'

interface ReferenceSourceRow {
  id: string
  project_id: string
  input_kind: ReferenceInputKind
  display_name: string
  file_format: ReferenceFileFormat
  file_size: number
  original_bytes: Buffer
  normalized_text: string
  original_hash: string
  normalized_hash: string
  encoding: ReferenceTextEncoding
  encoding_confidence: number
  language: string
  rights_confirmed: number
  rights_statement: string | null
  rights_confirmed_at: string | null
  retention_policy: ReferenceRetentionPolicy
  source_text_state: ReferenceSourceDetail['sourceTextState']
  parse_status: ReferenceSourceDetail['parseStatus']
  parser_version: string
  character_count: number
  estimated_tokens: number
  chapter_count: number
  scene_count: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  purged_at: string | null
  version: number
}

interface ReferenceSectionRow {
  id: string
  source_id: string
  parent_id: string | null
  type: ReferenceSection['type']
  sort_order: number
  title: string | null
  start_offset: number
  end_offset: number
  character_count: number
  estimated_tokens: number
  boundary_confidence: number
  content_hash: string
  included: number
  exclusion_reason: string | null
  warnings_json: string
  version: number
}

export interface CreateReferenceSourceInput {
  id: string
  projectId: string
  inputKind: ReferenceInputKind
  displayName: string
  fileFormat: ReferenceFileFormat
  originalBytes: Uint8Array
  originalHash: string
  normalizedText: string
  normalizedHash: string
  encoding: ReferenceTextEncoding
  encodingConfidence: number
  characterCount: number
  estimatedTokens: number
  estimatedChapterCount: number
}

export class ReferenceAnalysisStore {
  constructor(private readonly db: Database.Database) {}

  createSource(input: CreateReferenceSourceInput): ReferenceSourceDetail {
    const timestamp = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO novel_reference_sources (
      id, project_id, input_kind, display_name, file_format, file_size, original_bytes,
      normalized_text, original_hash, normalized_hash, encoding, encoding_confidence,
      character_count, estimated_tokens, chapter_count, created_at, updated_at
    ) VALUES (
      @id, @projectId, @inputKind, @displayName, @fileFormat, @fileSize, @originalBytes,
      @normalizedText, @originalHash, @normalizedHash, @encoding, @encodingConfidence,
      @characterCount, @estimatedTokens, @estimatedChapterCount, @createdAt, @updatedAt
    )`
      )
      .run({
        ...input,
        fileSize: input.originalBytes.byteLength,
        originalBytes: Buffer.from(input.originalBytes),
        createdAt: timestamp,
        updatedAt: timestamp
      })
    return this.requireSource(input.id)
  }

  listSources(projectId: string): ReferenceSourceDetail[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM novel_reference_sources
      WHERE project_id = ? AND purged_at IS NULL
      ORDER BY updated_at DESC
    `
      )
      .all(projectId) as ReferenceSourceRow[]
    return rows.map(rowToSource)
  }

  getSource(id: string): ReferenceSourceDetail | undefined {
    const row = this.db.prepare('SELECT * FROM novel_reference_sources WHERE id = ?').get(id) as
      | ReferenceSourceRow
      | undefined
    return row ? rowToSource(row) : undefined
  }

  requireSource(id: string): ReferenceSourceDetail {
    const source = this.getSource(id)
    if (!source) throw new Error(`参考源不存在: ${id}`)
    return source
  }

  getOriginalBytes(id: string): Uint8Array {
    const row = this.db
      .prepare('SELECT original_bytes FROM novel_reference_sources WHERE id = ?')
      .get(id) as { original_bytes: Buffer } | undefined
    if (!row) throw new Error(`参考源不存在: ${id}`)
    return new Uint8Array(row.original_bytes)
  }

  getNormalizedText(id: string): string {
    const row = this.db
      .prepare('SELECT normalized_text FROM novel_reference_sources WHERE id = ?')
      .get(id) as { normalized_text: string } | undefined
    if (!row) throw new Error(`参考源不存在: ${id}`)
    return row.normalized_text
  }

  updateImportOptions(input: {
    sourceId: string
    expectedVersion: number
    encoding: ReferenceTextEncoding
    encodingConfidence: number
    normalizedText: string
    normalizedHash: string
    characterCount: number
    estimatedTokens: number
    estimatedChapterCount: number
    retentionPolicy: ReferenceRetentionPolicy
    rightsConfirmed: boolean
    rightsStatement?: string
  }): ReferenceSourceDetail | undefined {
    const timestamp = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE novel_reference_sources SET
      encoding = @encoding,
      encoding_confidence = @encodingConfidence,
      normalized_text = @normalizedText,
      normalized_hash = @normalizedHash,
      character_count = @characterCount,
      estimated_tokens = @estimatedTokens,
      chapter_count = @estimatedChapterCount,
      retention_policy = @retentionPolicy,
      rights_confirmed = @rightsConfirmed,
      rights_statement = @rightsStatement,
      rights_confirmed_at = @rightsConfirmedAt,
      source_text_state = 'draft',
      parse_status = 'draft',
      updated_at = @updatedAt,
      version = version + 1
      WHERE id = @sourceId AND version = @expectedVersion
    `
      )
      .run({
        ...input,
        rightsConfirmed: input.rightsConfirmed ? 1 : 0,
        rightsStatement: input.rightsStatement ?? null,
        rightsConfirmedAt: input.rightsConfirmed ? timestamp : null,
        updatedAt: timestamp
      })
    return result.changes > 0 ? this.requireSource(input.sourceId) : undefined
  }

  replaceParsedArtifacts(
    sourceId: string,
    expectedVersion: number,
    normalizedText: string,
    normalizedHash: string,
    sections: ReferenceSection[],
    qualityReport: ReferenceQualityReport,
    localReport: ReferenceLocalAnalysisReport
  ): ReferenceSourceDetail | undefined {
    return this.db.transaction(() => {
      const timestamp = new Date().toISOString()
      const result = this.db
        .prepare(
          `UPDATE novel_reference_sources SET
        normalized_text = ?, normalized_hash = ?, source_text_state = 'available',
        parse_status = 'parsed', character_count = ?, chapter_count = ?,
        scene_count = 0, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `
        )
        .run(
          normalizedText,
          normalizedHash,
          normalizedText.length,
          sections.filter((section) => section.type === 'chapter').length,
          timestamp,
          sourceId,
          expectedVersion
        )
      if (result.changes === 0) return undefined
      this.replaceSectionsInternal(sourceId, sections)
      this.saveQualityReportInternal(qualityReport)
      this.saveLocalReportInternal(localReport)
      return this.requireSource(sourceId)
    })()
  }

  listSections(sourceId: string): ReferenceSection[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM novel_reference_sections WHERE source_id = ? ORDER BY sort_order
    `
      )
      .all(sourceId) as ReferenceSectionRow[]
    return rows.map(rowToSection)
  }

  getSection(id: string): ReferenceSection | undefined {
    const row = this.db.prepare('SELECT * FROM novel_reference_sections WHERE id = ?').get(id) as
      | ReferenceSectionRow
      | undefined
    return row ? rowToSection(row) : undefined
  }

  replaceSections(
    sourceId: string,
    expectedSourceVersion: number,
    sections: ReferenceSection[]
  ): ReferenceSourceDetail | undefined {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE novel_reference_sources
        SET chapter_count = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `
        )
        .run(
          sections.filter((section) => section.type === 'chapter').length,
          new Date().toISOString(),
          sourceId,
          expectedSourceVersion
        )
      if (result.changes === 0) return undefined
      this.replaceSectionsInternal(sourceId, sections)
      return this.requireSource(sourceId)
    })()
  }

  saveLocalReport(report: ReferenceLocalAnalysisReport): void {
    this.saveLocalReportInternal(report)
  }

  saveQualityReport(report: ReferenceQualityReport): void {
    this.saveQualityReportInternal(report)
  }

  getQualityReport(sourceId: string): ReferenceQualityReport | undefined {
    const row = this.db
      .prepare('SELECT report_json FROM novel_reference_quality_reports WHERE source_id = ?')
      .get(sourceId) as { report_json: string } | undefined
    return row ? (JSON.parse(row.report_json) as ReferenceQualityReport) : undefined
  }

  getLocalReport(sourceId: string): ReferenceLocalAnalysisReport | undefined {
    const row = this.db
      .prepare('SELECT report_json FROM novel_reference_local_reports WHERE source_id = ?')
      .get(sourceId) as { report_json: string } | undefined
    return row ? (JSON.parse(row.report_json) as ReferenceLocalAnalysisReport) : undefined
  }

  private replaceSectionsInternal(sourceId: string, sections: ReferenceSection[]): void {
    this.db.prepare('DELETE FROM novel_reference_sections WHERE source_id = ?').run(sourceId)
    const insert = this.db.prepare(`INSERT INTO novel_reference_sections (
      id, source_id, parent_id, type, sort_order, title, start_offset, end_offset,
      character_count, estimated_tokens, boundary_confidence, content_hash,
      included, exclusion_reason, warnings_json, version
    ) VALUES (
      @id, @sourceId, @parentId, @type, @order, @title, @start, @end,
      @characterCount, @estimatedTokens, @boundaryConfidence, @contentHash,
      @included, @exclusionReason, @warningsJson, @version
    )`)
    for (const section of sections) {
      insert.run({
        ...section,
        parentId: section.parentId ?? null,
        title: section.title ?? null,
        included: section.included ? 1 : 0,
        exclusionReason: section.exclusionReason ?? null,
        warningsJson: JSON.stringify(section.warnings)
      })
    }
  }

  private saveQualityReportInternal(report: ReferenceQualityReport): void {
    this.db
      .prepare(
        `INSERT INTO novel_reference_quality_reports (id, source_id, report_json, generated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET id = excluded.id, report_json = excluded.report_json, generated_at = excluded.generated_at
    `
      )
      .run(report.id, report.sourceId, JSON.stringify(report), report.generatedAt)
  }

  private saveLocalReportInternal(report: ReferenceLocalAnalysisReport): void {
    this.db
      .prepare(
        `INSERT INTO novel_reference_local_reports (
      id, source_id, source_version, normalized_hash, analyzer_version, report_json, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        id = excluded.id, source_version = excluded.source_version,
        normalized_hash = excluded.normalized_hash, analyzer_version = excluded.analyzer_version,
        report_json = excluded.report_json, generated_at = excluded.generated_at
    `
      )
      .run(
        report.id,
        report.sourceId,
        report.sourceVersion,
        report.normalizedHash,
        report.analyzerVersion,
        JSON.stringify(report),
        report.generatedAt
      )
  }
}

function rowToSource(row: ReferenceSourceRow): ReferenceSourceDetail {
  return {
    id: row.id,
    projectId: row.project_id,
    inputKind: row.input_kind,
    displayName: row.display_name,
    fileFormat: row.file_format,
    fileSize: row.file_size,
    originalHash: row.original_hash,
    normalizedHash: row.normalized_hash,
    encoding: row.encoding,
    encodingConfidence: row.encoding_confidence,
    language: row.language,
    rights: {
      confirmed: row.rights_confirmed === 1,
      statement: row.rights_statement ?? undefined,
      confirmedAt: row.rights_confirmed_at ?? undefined
    },
    retentionPolicy: row.retention_policy,
    sourceTextState: row.source_text_state,
    parseStatus: row.parse_status,
    parserVersion: row.parser_version,
    characterCount: row.character_count,
    estimatedTokens: row.estimated_tokens,
    chapterCount: row.chapter_count,
    sceneCount: row.scene_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    purgedAt: row.purged_at ?? undefined,
    version: row.version
  }
}

function rowToSection(row: ReferenceSectionRow): ReferenceSection {
  return {
    id: row.id,
    sourceId: row.source_id,
    parentId: row.parent_id ?? undefined,
    type: row.type,
    order: row.sort_order,
    title: row.title ?? undefined,
    start: row.start_offset,
    end: row.end_offset,
    characterCount: row.character_count,
    estimatedTokens: row.estimated_tokens,
    boundaryConfidence: row.boundary_confidence,
    contentHash: row.content_hash,
    included: row.included === 1,
    exclusionReason: row.exclusion_reason ?? undefined,
    warnings: JSON.parse(row.warnings_json) as string[],
    version: row.version
  }
}
