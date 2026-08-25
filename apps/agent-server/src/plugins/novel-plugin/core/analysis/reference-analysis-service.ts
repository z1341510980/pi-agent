import { randomUUID } from 'node:crypto'
import type {
  ReferenceFileFormat,
  ReferenceLocalAnalysisReport,
  ReferencePreflightResult,
  ReferenceQualityReport,
  ReferenceRetentionPolicy,
  ReferenceSection,
  ReferenceSourceDetail,
  ReferenceTextEncoding,
  ReferenceTextPreview,
  ReferenceTokenBudgetEstimate
} from '@repo/shared/novel'
import type { ProviderModelConfig } from './../../../../core/config/provider-config-store.js'
import { NovelStore } from '../novel-store.js'
import { ReferenceAnalysisStore } from './reference-analysis-store.js'
import {
  MAX_REFERENCE_PREVIEW_CHARS,
  MAX_REFERENCE_SOURCE_BYTES,
  REFERENCE_LOCAL_CHUNK_TARGET_TOKENS,
  analyzeReferenceText,
  buildReferenceLocalChunkPlan,
  buildReferenceQualityReport,
  detectAndDecodeReferenceText,
  detectReferenceSections,
  estimateReferenceTokens,
  normalizeReferenceText,
  sha256
} from './reference-analysis.js'

export interface ReferencePreflightInput {
  inputKind: 'file' | 'paste'
  displayName: string
  fileName?: string
  text?: string
  bytes?: Uint8Array
  fileFormat?: ReferenceFileFormat
}

export type ReferenceSectionBatchOperation =
  | {
      type: 'update'
      sectionId: string
      title?: string
      start?: number
      end?: number
      included?: boolean
      exclusionReason?: string
      version: number
    }
  | {
      type: 'split'
      sectionId: string
      offset: number
      leftTitle?: string
      rightTitle?: string
      version: number
    }
  | { type: 'merge'; sectionIds: string[]; title?: string }

export class ReferenceAnalysisService {
  constructor(
    private readonly store: ReferenceAnalysisStore,
    private readonly novelStore: NovelStore
  ) {}

  listSources(projectId: string): ReferenceSourceDetail[] {
    this.requireProject(projectId)
    return this.store.listSources(projectId)
  }

  getSource(sourceId: string): ReferenceSourceDetail {
    return this.store.requireSource(sourceId)
  }

  preflight(projectId: string, input: ReferencePreflightInput): ReferencePreflightResult {
    this.requireProject(projectId)
    const displayName = input.displayName.trim()
    if (!displayName) throw new Error('参考源名称不能为空')
    const fileFormat = resolveFileFormat(input)
    const bytes =
      input.inputKind === 'paste' ? new TextEncoder().encode(input.text ?? '') : input.bytes
    if (!bytes || bytes.byteLength === 0) throw new Error('参考文本不能为空')
    if (bytes.byteLength > MAX_REFERENCE_SOURCE_BYTES) {
      throw new Error(`参考文本超过本地导入硬限制 ${MAX_REFERENCE_SOURCE_BYTES} 字节`)
    }
    const decoded = detectAndDecodeReferenceText(bytes)
    const normalized = normalizeReferenceText(decoded.text)
    if (!normalized.text) throw new Error('文本清洗后为空，无法导入')
    const sourceId = randomUUID()
    const structure = detectReferenceSections(normalized.text, sourceId)
    const source = this.store.createSource({
      id: sourceId,
      projectId,
      inputKind: input.inputKind,
      displayName,
      fileFormat,
      originalBytes: bytes,
      originalHash: sha256(bytes),
      normalizedText: normalized.text,
      normalizedHash: sha256(normalized.text),
      encoding: decoded.encoding,
      encodingConfidence: decoded.confidence,
      characterCount: normalized.text.length,
      estimatedTokens: estimateReferenceTokens(normalized.text),
      estimatedChapterCount: structure.sections.filter((section) => section.type === 'chapter')
        .length
    })
    const warnings = [...decoded.warnings, ...structure.warnings]
    return {
      ...source,
      sourceDraftId: source.id,
      detectedEncoding: source.encoding,
      estimatedChapterCount: source.chapterCount,
      contentHash: source.normalizedHash,
      warnings,
      supported: true
    }
  }

  updateImportOptions(
    sourceId: string,
    input: {
      version: number
      encoding: ReferenceTextEncoding
      retentionPolicy: ReferenceRetentionPolicy
      rightsConfirmed: boolean
      rightsStatement?: string
    }
  ): { source: ReferenceSourceDetail; warnings: string[] } {
    const current = this.store.requireSource(sourceId)
    if (current.inputKind === 'paste' && input.encoding !== 'utf-8') {
      throw new Error('粘贴文本已由桌面端按 UTF-8 接收，不能改选其他文件编码')
    }
    const bytes = this.store.getOriginalBytes(sourceId)
    const decoded = detectAndDecodeReferenceText(bytes, input.encoding)
    const normalized = normalizeReferenceText(decoded.text)
    const structure = detectReferenceSections(normalized.text, sourceId)
    const source = this.store.updateImportOptions({
      sourceId,
      expectedVersion: input.version,
      encoding: input.encoding,
      encodingConfidence: decoded.confidence,
      normalizedText: normalized.text,
      normalizedHash: sha256(normalized.text),
      characterCount: normalized.text.length,
      estimatedTokens: estimateReferenceTokens(normalized.text),
      estimatedChapterCount: structure.sections.filter((section) => section.type === 'chapter')
        .length,
      retentionPolicy: input.retentionPolicy,
      rightsConfirmed: input.rightsConfirmed,
      rightsStatement: input.rightsStatement
    })
    if (!source) throw new Error('参考源版本冲突，请刷新后重试')
    return { source, warnings: [...decoded.warnings, ...structure.warnings] }
  }

  parse(
    sourceId: string,
    expectedVersion: number
  ): {
    source: ReferenceSourceDetail
    parseStatus: 'parsed'
    qualityReportId: string
    chapterCount: number
    sceneCount: number
    excludedCandidates: ReferenceQualityReport['excludedCandidates']
    nextPage: 'quality'
  } {
    const source = this.store.requireSource(sourceId)
    if (source.version !== expectedVersion) throw new Error('参考源版本冲突，请刷新后重试')
    if (!source.rights.confirmed) throw new Error('请先确认有权分析该文本')
    const decoded = detectAndDecodeReferenceText(
      this.store.getOriginalBytes(sourceId),
      source.encoding
    )
    const normalized = normalizeReferenceText(decoded.text)
    const structure = detectReferenceSections(normalized.text, sourceId)
    const quality = buildReferenceQualityReport(
      sourceId,
      normalized.text,
      source.encoding,
      source.encodingConfidence,
      normalized,
      structure
    )
    const localReport = analyzeReferenceText(
      sourceId,
      source.version + 1,
      normalized.text,
      sha256(normalized.text),
      structure.sections,
      quality
    )
    const parsed = this.store.replaceParsedArtifacts(
      sourceId,
      expectedVersion,
      normalized.text,
      sha256(normalized.text),
      structure.sections,
      quality,
      localReport
    )
    if (!parsed) throw new Error('参考源版本冲突，请刷新后重试')
    return {
      source: parsed,
      parseStatus: 'parsed',
      qualityReportId: quality.id,
      chapterCount: parsed.chapterCount,
      sceneCount: 0,
      excludedCandidates: quality.excludedCandidates,
      nextPage: 'quality'
    }
  }

  getQualityReport(sourceId: string): ReferenceQualityReport {
    this.store.requireSource(sourceId)
    const report = this.store.getQualityReport(sourceId)
    if (!report) throw new Error('参考源尚未解析，没有数据质量报告')
    return report
  }

  getLocalReport(sourceId: string): ReferenceLocalAnalysisReport {
    this.store.requireSource(sourceId)
    const report = this.store.getLocalReport(sourceId)
    if (!report) throw new Error('参考源尚未解析，没有本地分析报告')
    return report
  }

  listSections(sourceId: string): ReferenceSection[] {
    this.store.requireSource(sourceId)
    return this.store.listSections(sourceId)
  }

  getSectionsText(
    sourceId: string,
    sectionIds: string[]
  ): {
    sourceId: string
    sections: ReferenceSection[]
    text: string
    sectionTexts: Record<string, string>
  } {
    const source = this.store.requireSource(sourceId)
    const allSections = this.store.listSections(sourceId)
    const selected = allSections.filter(
      (section) => sectionIds.includes(section.id) && section.included
    )
    if (selected.length === 0) throw new Error('至少选择一个可分析的参考章节')
    const text = this.store.getNormalizedText(sourceId)
    const sectionTexts = Object.fromEntries(
      selected.map((section) => [section.id, text.slice(section.start, section.end)])
    )
    return {
      sourceId: source.id,
      sections: selected,
      text: Object.values(sectionTexts).join('\n\n'),
      sectionTexts
    }
  }

  getTextPreview(
    sourceId: string,
    input: { sectionId?: string; start?: number; end?: number; contextChars?: number }
  ): ReferenceTextPreview {
    const text = this.store.getNormalizedText(sourceId)
    const sections = this.store.listSections(sourceId)
    const section = input.sectionId
      ? sections.find((candidate) => candidate.id === input.sectionId)
      : undefined
    if (input.sectionId && !section) throw new Error('参考分段不存在')
    const contextChars = Math.min(500, Math.max(0, input.contextChars ?? 200))
    const requestedStart = input.start ?? section?.start ?? 0
    const requestedEnd = input.end ?? Math.min(section?.end ?? text.length, requestedStart + 2000)
    if (requestedStart < 0 || requestedStart >= text.length || requestedEnd <= requestedStart) {
      throw new Error('文本预览偏移无效')
    }
    const start = Math.max(0, requestedStart - contextChars)
    const desiredEnd = Math.min(text.length, requestedEnd + contextChars)
    const end = Math.min(desiredEnd, start + MAX_REFERENCE_PREVIEW_CHARS)
    const index = section ? sections.findIndex((candidate) => candidate.id === section.id) : -1
    return {
      sourceId,
      sectionId: section?.id,
      start,
      end,
      text: text.slice(start, end),
      previousBoundary: index > 0 ? sections[index - 1]?.end : undefined,
      nextBoundary:
        index >= 0 && index < sections.length - 1 ? sections[index + 1]?.start : undefined,
      excluded: section ? !section.included : false,
      truncated: end < desiredEnd
    }
  }

  updateSection(
    sectionId: string,
    input: {
      title?: string
      start?: number
      end?: number
      included?: boolean
      exclusionReason?: string
      version: number
    }
  ): { source: ReferenceSourceDetail; section: ReferenceSection; sections: ReferenceSection[] } {
    const section = this.store.getSection(sectionId)
    if (!section) throw new Error('参考分段不存在')
    if (section.version !== input.version) throw new Error('参考分段版本冲突，请刷新后重试')
    const source = this.store.requireSource(section.sourceId)
    const text = this.store.getNormalizedText(section.sourceId)
    const sections = this.store.listSections(section.sourceId)
    const updated = recomputeSection({ ...section, ...input, version: section.version + 1 }, text)
    const nextSections = sections.map((candidate) =>
      candidate.id === section.id ? updated : candidate
    )
    validateSectionBoundaries(nextSections, text.length)
    const updatedSource = this.store.replaceSections(source.id, source.version, nextSections)
    if (!updatedSource) throw new Error('参考源版本冲突，请刷新后重试')
    this.refreshLocalReport(updatedSource, nextSections)
    return { source: updatedSource, section: updated, sections: nextSections }
  }

  batchSections(
    sourceId: string,
    sourceVersion: number,
    operations: ReferenceSectionBatchOperation[]
  ): {
    source: ReferenceSourceDetail
    sections: ReferenceSection[]
  } {
    const source = this.store.requireSource(sourceId)
    if (source.version !== sourceVersion) throw new Error('参考源版本冲突，请刷新后重试')
    const text = this.store.getNormalizedText(sourceId)
    let sections = this.store.listSections(sourceId)
    for (const operation of operations) {
      if (operation.type === 'update') {
        const current = sections.find((section) => section.id === operation.sectionId)
        if (!current || current.version !== operation.version)
          throw new Error('批量更新包含不存在或过期的分段')
        sections = sections.map((section) =>
          section.id === current.id
            ? recomputeSection(
                {
                  ...section,
                  title: operation.title ?? section.title,
                  start: operation.start ?? section.start,
                  end: operation.end ?? section.end,
                  included: operation.included ?? section.included,
                  exclusionReason: operation.exclusionReason ?? section.exclusionReason,
                  version: section.version + 1
                },
                text
              )
            : section
        )
      } else if (operation.type === 'split') {
        const current = sections.find((section) => section.id === operation.sectionId)
        if (!current || current.version !== operation.version)
          throw new Error('拆分目标不存在或版本过期')
        if (operation.offset <= current.start || operation.offset >= current.end)
          throw new Error('拆分位置必须位于分段内部')
        const left = recomputeSection(
          {
            ...current,
            title: operation.leftTitle ?? current.title,
            end: operation.offset,
            version: current.version + 1
          },
          text
        )
        const right = recomputeSection(
          {
            ...current,
            id: randomUUID(),
            title: operation.rightTitle ?? `${current.title ?? '章节'}（下）`,
            start: operation.offset,
            version: 1
          },
          text
        )
        sections = sections.flatMap((section) =>
          section.id === current.id ? [left, right] : [section]
        )
      } else {
        const selected = sections
          .filter((section) => operation.sectionIds.includes(section.id))
          .sort((a, b) => a.start - b.start)
        if (selected.length < 2) throw new Error('合并至少需要两个分段')
        for (let index = 1; index < selected.length; index += 1) {
          if (selected[index - 1]!.end !== selected[index]!.start)
            throw new Error('只能合并相邻分段')
        }
        const first = selected[0]!
        const merged = recomputeSection(
          {
            ...first,
            title: operation.title ?? first.title,
            end: selected.at(-1)!.end,
            version: first.version + 1
          },
          text
        )
        const selectedIds = new Set(selected.map((section) => section.id))
        sections = sections.flatMap((section) =>
          section.id === first.id ? [merged] : selectedIds.has(section.id) ? [] : [section]
        )
      }
    }
    sections = sections
      .sort((a, b) => a.start - b.start)
      .map((section, order) => ({ ...section, order }))
    validateSectionBoundaries(sections, text.length)
    const updatedSource = this.store.replaceSections(sourceId, sourceVersion, sections)
    if (!updatedSource) throw new Error('参考源版本冲突，请刷新后重试')
    this.refreshLocalReport(updatedSource, sections)
    return { source: updatedSource, sections }
  }

  estimateBudget(
    sourceId: string,
    input: {
      providerId: string
      modelId: string
      model: ProviderModelConfig
      selectedSectionIds?: string[]
      outputReserveTokens?: number
      safetyMarginTokens?: number
    }
  ): ReferenceTokenBudgetEstimate {
    const source = this.store.requireSource(sourceId)
    const text = this.store.getNormalizedText(sourceId)
    const persistedSections = this.store.listSections(sourceId)
    // 导入确认阶段尚未落库章节；此时也要能预览本地分包，故按同一章节识别器临时计算。
    const allSections =
      persistedSections.length > 0
        ? persistedSections
        : detectReferenceSections(text, sourceId).sections
    const selectedSections = input.selectedSectionIds?.length
      ? allSections.filter((section) => input.selectedSectionIds!.includes(section.id))
      : allSections.filter((section) => section.included)
    if (
      input.selectedSectionIds?.length &&
      selectedSections.length !== new Set(input.selectedSectionIds).size
    ) {
      throw new Error('分析范围包含不存在的分段')
    }
    const selectedText =
      selectedSections.length > 0
        ? selectedSections.map((section) => text.slice(section.start, section.end)).join('\n')
        : text
    const contextWindow = input.model.contextWindow ?? 32768
    const maxOutputTokens = input.model.maxTokens ?? 8192
    const systemPromptTokens = 2500
    const instructionTokens = 2500
    const outputReserveTokens = Math.min(
      maxOutputTokens,
      Math.max(512, input.outputReserveTokens ?? 4096)
    )
    const safetyMarginTokens = Math.max(
      2048,
      input.safetyMarginTokens ?? Math.ceil(contextWindow * 0.1)
    )
    const effectiveInputLimit = Math.max(
      0,
      contextWindow -
        systemPromptTokens -
        instructionTokens -
        outputReserveTokens -
        safetyMarginTokens
    )
    const selectedTextTokens = estimateReferenceTokens(selectedText)
    const localChunkPlan = buildReferenceLocalChunkPlan(
      selectedSections,
      Math.max(1, Math.min(REFERENCE_LOCAL_CHUNK_TARGET_TOKENS, effectiveInputLimit))
    )
    const largestChunkTokens = Math.max(
      0,
      ...localChunkPlan.chunks.map((chunk) => chunk.estimatedTokens)
    )
    // 总文本超过上下文时按章节分批处理；只有完整章节自身无法容纳时才阻断。
    const excessTokens = Math.max(0, largestChunkTokens - effectiveInputLimit)
    const withinLimit = effectiveInputLimit > 0 && excessTokens === 0
    const estimatedInputTokens = {
      min: selectedTextTokens,
      max: Math.ceil(selectedTextTokens * 1.15)
    }
    const estimatedOutputTokens = {
      min: Math.ceil(outputReserveTokens * 0.4),
      max: outputReserveTokens
    }
    const warnings = [
      '阶段 1 只执行本地统计，不会发送文本；该估算用于后续语义分析前的硬限制与费用确认。'
    ]
    warnings.push(...localChunkPlan.warnings)
    if (!withinLimit) {
      warnings.push(
        effectiveInputLimit === 0
          ? '模型没有可用的输入预算，不能启动语义分析。'
          : `存在完整章节超出模型有效输入上限 ${excessTokens.toLocaleString()} tokens；请在章节边界手动拆分后重试。`
      )
    } else if (localChunkPlan.splitRequired) {
      warnings.push('整本参考文本超过单次上下文，远端分析将按章节边界合并分包处理。')
    } else if (selectedTextTokens >= effectiveInputLimit * 0.7)
      warnings.push('输入已接近模型有效上下文上限，后续分析需要谨慎确认。')
    const pricing = input.model.cost
    const estimatedCost = pricing
      ? {
          currency: 'USD',
          min: roundCost(
            (estimatedInputTokens.min * pricing.input +
              estimatedOutputTokens.min * pricing.output) /
              1_000_000
          ),
          max: roundCost(
            (estimatedInputTokens.max * pricing.input +
              estimatedOutputTokens.max * pricing.output) /
              1_000_000
          )
        }
      : undefined
    if (estimatedCost && estimatedCost.max > 0)
      warnings.push(
        `按当前 provider 配置，后续单次语义分析预计最高费用约 ${estimatedCost.currency} ${estimatedCost.max}。`
      )
    const estimateBase = {
      sourceId,
      sourceVersion: source.version,
      normalizedHash: source.normalizedHash,
      providerId: input.providerId,
      modelId: input.modelId,
      selectedSectionIds: selectedSections.map((section) => section.id),
      contextWindow,
      outputReserveTokens,
      safetyMarginTokens,
      localChunkPlan
    }
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindow,
      maxOutputTokens,
      selectedCharacters: selectedText.length,
      selectedTextTokens,
      systemPromptTokens,
      instructionTokens,
      outputReserveTokens,
      safetyMarginTokens,
      effectiveInputLimit,
      estimatedSceneCalls: 0,
      estimatedChapterCalls: 0,
      estimatedBookCalls: 1,
      estimatedTotalCalls: 1,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCost,
      pricingSource: pricing ? 'provider_config' : 'unknown',
      tokenizerSource: 'fallback',
      localChunkPlan,
      withinLimit,
      excessTokens,
      excessCharacters:
        selectedTextTokens === 0
          ? 0
          : Math.ceil((excessTokens * selectedText.length) / selectedTextTokens),
      warnings,
      estimateHash: sha256(JSON.stringify(estimateBase))
    }
  }

  private refreshLocalReport(source: ReferenceSourceDetail, sections: ReferenceSection[]): void {
    const currentQuality = this.getQualityReport(source.id)
    const quality: ReferenceQualityReport = {
      ...currentQuality,
      lowConfidenceSectionIds: sections
        .filter((section) => section.boundaryConfidence < 0.6)
        .map((section) => section.id),
      chapterBoundaryConfidence:
        sections.length === 0
          ? 0
          : Number(
              (
                sections.reduce((sum, section) => sum + section.boundaryConfidence, 0) /
                sections.length
              ).toFixed(4)
            ),
      generatedAt: new Date().toISOString()
    }
    this.store.saveQualityReport(quality)
    const text = this.store.getNormalizedText(source.id)
    this.store.saveLocalReport(
      analyzeReferenceText(
        source.id,
        source.version,
        text,
        source.normalizedHash,
        sections,
        quality
      )
    )
  }

  private requireProject(projectId: string): void {
    if (!this.novelStore.getProject(projectId)) throw new Error(`项目不存在: ${projectId}`)
  }
}

function resolveFileFormat(input: ReferencePreflightInput): ReferenceFileFormat {
  if (input.fileFormat) return input.fileFormat
  if (input.inputKind === 'paste') return 'txt'
  const fileName = input.fileName?.toLocaleLowerCase() ?? ''
  if (fileName.endsWith('.md') || fileName.endsWith('.markdown')) return 'markdown'
  if (fileName.endsWith('.txt')) return 'txt'
  throw new Error('第一版只支持 TXT 和 Markdown 文件')
}

function recomputeSection(section: ReferenceSection, text: string): ReferenceSection {
  const content = text.slice(section.start, section.end)
  return {
    ...section,
    characterCount: content.length,
    estimatedTokens: estimateReferenceTokens(content),
    contentHash: sha256(content),
    exclusionReason: section.included ? undefined : section.exclusionReason || '用户手动排除'
  }
}

function validateSectionBoundaries(sections: ReferenceSection[], textLength: number): void {
  const sorted = [...sections].sort((a, b) => a.start - b.start)
  for (let index = 0; index < sorted.length; index += 1) {
    const section = sorted[index]!
    if (section.start < 0 || section.end > textLength || section.start >= section.end)
      throw new Error('分段边界超出文本范围')
    if (index > 0 && sorted[index - 1]!.end > section.start) throw new Error('分段边界不能重叠')
  }
}

function roundCost(value: number): number {
  return Number(value.toFixed(6))
}
