import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { PluginContext, PluginSessionOptions } from '../../../../core/plugin/plugin-types.js'

export interface LengduWorkflowOptions {
  projectId: string
  chapterNumber: number
  content: string
  skillPath: string
  signal?: AbortSignal
  modelId?: PluginSessionOptions['modelId']
  onProgress?: (message: string) => void
  onDegraded?: (event: LengduDegradationEvent) => void
  onFailure?: (event: LengduFailureEvent) => void
}

export interface LengduDegradationEvent {
  stage: 'calibrator' | 'reader'
  error: unknown
  traceId: string
  content: string
  durationMs: number
}

export interface LengduFailureEvent {
  stage: 'revision'
  error: unknown
  traceId: string
  content: string
  durationMs: number
}

export interface LengduWorkflowResult {
  content: string
  usedIndependentCalibration: boolean
  usedIndependentReader: boolean
  calibrationReport?: string
  readerReports: string[]
  revisionCount: number
  quality: LengduQualityReport
}

export type LengduGateVerdict = 'passed' | 'needs_attention' | 'unverified'

/**
 * The durable, user-facing result of the lengdu closed loop. Raw reader and
 * calibration transcripts remain internal so a saved chapter history exposes
 * the verdict without leaking the full manuscript back into the UI payload.
 */
export interface LengduQualityReport {
  status: 'passed' | 'needs_attention' | 'degraded'
  calibration: 'independent' | 'unavailable'
  reader: 'independent' | 'self_review'
  comprehension: LengduGateVerdict
  fluency: LengduGateVerdict
  appeal: LengduGateVerdict
  revisionCount: number
  summary: string
}

interface ReaderResult {
  report: string
  independent: boolean
}

interface CalibrationResult {
  report?: string
  independent: boolean
}

const MAX_READER_REVISIONS = 1

/**
 * Execute the isolation rules encoded by the bundled lengdu skill. The workflow
 * deliberately creates fresh plugin Sessions rather than reusing the Writer's
 * session: calibration and Reader must not inherit the outline or author intent.
 */
export class LengduWorkflow {
  constructor(private readonly context: PluginContext) {}

  async run(options: LengduWorkflowOptions): Promise<LengduWorkflowResult> {
    const references = new LengduReferences(options.skillPath)
    const calibration = await this.calibrate(options, references)
    const calibrationReport = calibration.report
    let content = options.content
    const readerReports: string[] = []
    let usedIndependentReader = false
    let revisionCount = 0

    for (let round = 0; round <= MAX_READER_REVISIONS; round += 1) {
      options.signal?.throwIfAborted()
      options.onProgress?.(
        round === 0
          ? 'lengdu Reader 正在按事件包进行独立首读...'
          : 'lengdu 正在用新的 Reader 复核修订稿...'
      )
      const reader = await this.readAsReader(options, references, content)
      readerReports.push(reader.report)
      usedIndependentReader ||= reader.independent

      if (!reader.independent || readerPassed(reader.report)) break
      if (round === MAX_READER_REVISIONS) break

      options.onProgress?.('lengdu 主作家正在依据读感重建必要范围...')
      content = await this.revise(options, references, content, reader.report, calibrationReport)
      revisionCount += 1
    }

    return {
      content,
      usedIndependentCalibration: calibration.independent,
      usedIndependentReader,
      calibrationReport,
      readerReports,
      revisionCount,
      quality: buildQualityReport({
        calibrationIndependent: calibration.independent,
        readerIndependent: usedIndependentReader,
        finalReaderReport: readerReports.at(-1),
        revisionCount,
      }),
    }
  }

  private async calibrate(
    options: LengduWorkflowOptions,
    references: LengduReferences
  ): Promise<CalibrationResult> {
    options.signal?.throwIfAborted()
    options.onProgress?.('lengdu 作者侧校准者正在独立检查正文...')
    const startedAt = Date.now()
    const trace = this.trace(options, 'calibrator')
    try {
      const calibratorProfile = references.read('author-calibrator-profile-v0.2.md')
      const session = await this.context.createSession({
        systemPrompt: '你是本次独立作者侧校准者。只处理随后的档案与当前正文，不使用任何工具。',
        userMessage: [
          '阅读当前正文并按随附档案提交校准记录。',
          '',
          '## 校准者档案',
          calibratorProfile,
          '',
          '## 当前正文',
          options.content
        ].join('\n'),
        tools: [],
        trace,
        signal: options.signal,
        modelId: options.modelId,
        timeoutMs: 300_000
      })
      try {
        return { report: await session.prompt(), independent: true }
      } finally {
        session.dispose()
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      this.notifyDegradation(options, {
        stage: 'calibrator',
        error,
        traceId: trace.runId,
        content: options.content,
        durationMs: Date.now() - startedAt,
      })
      this.context.logger.warn(
        { projectId: options.projectId, chapterNumber: options.chapterNumber, err: error },
        'lengdu 作者侧独立校准不可用，降级为不使用校准报告'
      )
      return { independent: false }
    }
  }

  private async readAsReader(
    options: LengduWorkflowOptions,
    references: LengduReferences,
    content: string
  ): Promise<ReaderResult> {
    let session: Awaited<ReturnType<PluginContext['createSession']>> | undefined
    const startedAt = Date.now()
    const trace = this.trace(options, 'reader')
    try {
      const readerProfile = references.read('reader-profile-v0.4.md')
      const packets = splitIntoReadingPackets(content)
      session = await this.context.createSession({
        systemPrompt: '你是本次干净的普通 Reader。只按收到的文字首读，不使用任何工具。',
        userMessage: [
          '完整阅读以下 Reader 档案。之后正文会按原顺序分包发送。',
          '每次只依据目前收到的文字，严格使用档案中的输出格式。',
          '不得索取后文、提供改写、评价 AI 味或检测结果。收到【全文结束】前只返回当前事件包读感。',
          '',
          '## Reader 档案',
          readerProfile
        ].join('\n'),
        tools: [],
        trace,
        signal: options.signal,
        modelId: options.modelId,
        timeoutMs: 300_000
      })

      // First send the neutral Reader setup. Subsequent prompt(message) calls
      // then append exactly one event packet to this isolated Session.
      await session.prompt()

      for (let index = 0; index < packets.length; index += 1) {
        options.signal?.throwIfAborted()
        const finalMarker = index === packets.length - 1 ? '\n\n【全文结束】' : ''
        await session.prompt(`【正文事件包 ${index + 1}】\n${packets[index]}${finalMarker}`)
      }
      const report = await session.prompt('请只按 Reader 档案中的“全文输出”格式，给出最终读感。')
      return { report, independent: true }
    } catch (error) {
      if (options.signal?.aborted) throw error
      this.notifyDegradation(options, {
        stage: 'reader',
        error,
        traceId: trace.runId,
        content,
        durationMs: Date.now() - startedAt,
      })
      this.context.logger.warn(
        { projectId: options.projectId, chapterNumber: options.chapterNumber, err: error },
        'lengdu Reader 不可用，标记为自审降级'
      )
      return {
        report:
          '## 最终读感\n- 看懂：未完成独立验证\n- 流畅：未完成独立验证\n- 好看：未完成独立验证\n- 一句话总评：Reader 会话未完成，属于自审降级模式。',
        independent: false
      }
    } finally {
      session?.dispose()
    }
  }

  private async revise(
    options: LengduWorkflowOptions,
    references: LengduReferences,
    content: string,
    readerReport: string,
    calibrationReport?: string
  ): Promise<string> {
    const startedAt = Date.now()
    const trace = this.trace(options, 'revision')
    let session: Awaited<ReturnType<PluginContext['createSession']>> | undefined
    try {
      const writerProfile = references.read('writer-profile-v0.3.md')
      const revisionProtocol = references.read('writer-revision-protocol.md')
      session = await this.context.createSession({
        systemPrompt: '你是成熟中文小说作家。只输出修订后的完整正文，不使用工具。',
        userMessage: [
          '请保留既定事实、核心事件、人物关系与文风，只重建读感确实受阻的最小自然叙事范围。',
          '不要逐条机械照改，不要为了人工感制造错别字、逻辑漏洞或无效细节。',
          '',
          '## 作家人格档案',
          writerProfile,
          '',
          '## 当前正文',
          content,
          '',
          '## 普通 Reader 最终读感',
          readerReport,
          ...(calibrationReport
            ? ['', '## 作者侧校准候选（仅作证据，采纳与范围由你判断）', calibrationReport]
            : []),
          '',
          '## 修改协议',
          revisionProtocol
        ].join('\n'),
        tools: [],
        trace,
        signal: options.signal,
        modelId: options.modelId,
        timeoutMs: 300_000
      })
      return await session.prompt()
    } catch (error) {
      if (options.signal?.aborted) throw error
      this.notifyFailure(options, {
        stage: 'revision',
        error,
        traceId: trace.runId,
        content,
        durationMs: Date.now() - startedAt,
      })
      throw error
    } finally {
      session?.dispose()
    }
  }

  private trace(options: LengduWorkflowOptions, stage: 'calibrator' | 'reader' | 'revision'): NonNullable<PluginSessionOptions['trace']> {
    return {
      sessionId: `novel:chapter:${options.projectId}:${options.chapterNumber}`,
      runId: `lengdu:${stage}:${randomUUID()}`,
      metadata: {
        source: 'lengdu',
        projectId: options.projectId,
        chapterNumber: options.chapterNumber,
        stage,
        agentName: stage === 'calibrator' ? 'lengdu 校准者' : stage === 'reader' ? 'lengdu Reader' : 'lengdu 主作家',
      },
    }
  }

  private notifyDegradation(options: LengduWorkflowOptions, event: LengduDegradationEvent): void {
    try {
      options.onDegraded?.(event)
    } catch (auditError) {
      this.context.logger.warn(
        { projectId: options.projectId, chapterNumber: options.chapterNumber, err: auditError, stage: event.stage },
        'lengdu 降级审计回调失败',
      )
    }
  }

  private notifyFailure(options: LengduWorkflowOptions, event: LengduFailureEvent): void {
    try {
      options.onFailure?.(event)
    } catch (auditError) {
      this.context.logger.warn(
        { projectId: options.projectId, chapterNumber: options.chapterNumber, err: auditError, stage: event.stage },
        'lengdu 失败审计回调失败',
      )
    }
  }
}

class LengduReferences {
  private readonly root: string

  constructor(skillPath: string) {
    this.root = join(dirname(skillPath), 'references')
  }

  read(name: string): string {
    return readFileSync(join(this.root, name), 'utf-8')
  }
}

function readerPassed(report: string): boolean {
  return /看懂：通过/.test(report) && /流畅：顺畅/.test(report) && /好看：想马上继续/.test(report)
}

function buildQualityReport(input: {
  calibrationIndependent: boolean
  readerIndependent: boolean
  finalReaderReport: string | undefined
  revisionCount: number
}): LengduQualityReport {
  const comprehension = parseGateVerdict(input.finalReaderReport, '看懂', '通过')
  const fluency = parseGateVerdict(input.finalReaderReport, '流畅', '顺畅')
  const appeal = parseGateVerdict(input.finalReaderReport, '好看', '想马上继续')
  const fullyIndependent = input.calibrationIndependent && input.readerIndependent
  const allPassed = [comprehension, fluency, appeal].every(value => value === 'passed')
  const status = !fullyIndependent
    ? 'degraded'
    : allPassed
      ? 'passed'
      : 'needs_attention'

  return {
    status,
    calibration: input.calibrationIndependent ? 'independent' : 'unavailable',
    reader: input.readerIndependent ? 'independent' : 'self_review',
    comprehension,
    fluency,
    appeal,
    revisionCount: input.revisionCount,
    summary: extractReaderSummary(input.finalReaderReport, status),
  }
}

function parseGateVerdict(
  report: string | undefined,
  label: '看懂' | '流畅' | '好看',
  passingValue: string,
): LengduGateVerdict {
  if (!report) return 'unverified'
  const match = report.match(new RegExp(`-\\s*${label}：([^\\n]+)`))
  if (!match) return 'unverified'
  return match[1].trim() === passingValue ? 'passed' : 'needs_attention'
}

function extractReaderSummary(
  report: string | undefined,
  status: LengduQualityReport['status'],
): string {
  if (status === 'degraded') {
    return '独立校准或 Reader 未完成，本次结果仅能作为自审降级记录。'
  }
  const match = report?.match(/-\s*一句话总评：\s*([^\n]+)/)
  if (match?.[1]?.trim()) return match[1].trim().slice(0, 240)
  return status === 'passed'
    ? '独立 Reader 对本版正文的看懂、流畅和好看三项均通过。'
    : '独立 Reader 已完成首读，但仍有至少一项读感未通过。'
}

/** Split on paragraph boundaries near the skill's 400-800 Han-character target. */
export function splitIntoReadingPackets(content: string): string[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (paragraphs.length === 0) return [content.trim()]

  const packets: string[] = []
  let packet = ''
  for (const paragraph of paragraphs) {
    const next = packet ? `${packet}\n\n${paragraph}` : paragraph
    if (packet && next.length > 900) {
      packets.push(packet)
      packet = paragraph
    } else {
      packet = next
    }
  }
  if (packet) packets.push(packet)
  return packets
}
