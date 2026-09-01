import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgUiEventSink } from '@repo/protocol/events'
import type {
  AgUiSessionHandle,
  PluginContext,
  PluginSessionOptions
} from '../../../../core/plugin/plugin-types.js'
import {
  addLlmUsage,
  extractLlmUsageFromMessage,
  hasLlmUsage,
  type LlmUsageSnapshot
} from '../agent-run-utils.js'

export type LengduStage = 'calibrator' | 'reader' | 'revision'

export interface LengduWorkflowOptions {
  projectId: string
  chapterNumber: number
  content: string
  /**
   * 显式 lengdu Skill 路径（PI_LENGDU_SKILL_PATH / 项目内 .claude/skills/lengdu）。
   * 提供时档案从 `<skillDir>/references/` 读取（用户可调）；缺省或读取失败时
   * 回退到随插件分发的内置档案（core/lengdu/profiles），不再静默跳过整个工作流。
   */
  skillPath?: string
  signal?: AbortSignal
  modelId?: PluginSessionOptions['modelId']
  /** AG-UI sink：传入时各阶段经 createAgUiSession 流式推送 TEXT_MESSAGE_*。 */
  emit?: AgUiEventSink
  /** 过程事件：状态行 / 阶段启动 / Reader 包级读感，由编排层映射为前端进度。 */
  onEvent?: (event: LengduFlowEvent) => void
  /** 阶段调用结束回调：编排层负责 insertAgentLog 落库与单章预算记账。 */
  onStageLog?: (log: LengduStageLog) => void
  onDegraded?: (event: LengduDegradationEvent) => void
  onFailure?: (event: LengduFailureEvent) => void
}

export type LengduFlowEvent =
  | { kind: 'status'; stage: LengduStage; message: string }
  | {
      kind: 'stage_start'
      stage: LengduStage
      round: number
      messageId: string
      agentName: string
    }
  | {
      kind: 'packet_report'
      round: number
      packetIndex: number
      packetCount: number
      report: string
    }

/** 单次阶段调用的可观测记录；usage 为该阶段全部 LLM 往返之和。 */
export interface LengduStageLog {
  stage: LengduStage
  /** reader 第几轮首读（0 起）；calibrator / revision 恒为 0。 */
  round: number
  systemPrompt: string
  /** 首条用户消息（reader 为档案装载消息；分包内容不重复计入）。 */
  userMessage: string
  result: string
  durationMs: number
  status: 'success' | 'error' | 'cancelled'
  error?: string
  sessionId?: string
  usage?: LlmUsageSnapshot
  payloadTotalChars: number
  llmRoundTrips: number
}

export interface LengduDegradationEvent {
  stage: Exclude<LengduStage, 'revision'>
  error: unknown
  traceId: string
  content: string
  durationMs: number
}

export interface LengduFailureEvent {
  stage: Extract<LengduStage, 'revision'>
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

// P2-1：修订轮次 1 → 2。首轮 Reader 发现的问题往往需要一次有界重建才能消除；
// 第二轮用"新的 Reader 复核修订稿"，避免同一个 Reader 固化首读印象。
const MAX_READER_REVISIONS = 2

const STAGE_TIMEOUT_MS = 300_000

/** 各阶段对外展示名；编排层落 AgentLog 时复用，避免两处口径漂移。 */
export const LENGDU_STAGE_AGENT_NAMES: Record<LengduStage, string> = {
  calibrator: 'lengdu 校准者',
  reader: 'lengdu Reader',
  revision: 'lengdu 主作家',
}

const STAGE_AGENT_NAMES = LENGDU_STAGE_AGENT_NAMES

/**
 * Execute the isolation rules encoded by the bundled lengdu skill. The workflow
 * deliberately creates fresh AG-UI sessions rather than reusing the Writer's
 * session: calibration and Reader must not inherit the outline or author intent.
 *
 * 所有阶段都走 `createAgUiSession` 底座：前端能收到 agent_start + 流式正文，
 * 编排层能拿到 usage/payload 计量并统一落 AgentLog 与单章预算。
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
      this.emitStatus(options, 'reader', round === 0
        ? 'lengdu Reader 正在按事件包进行独立首读...'
        : 'lengdu 正在用新的 Reader 复核修订稿...')
      const reader = await this.readAsReader(options, references, content, round)
      readerReports.push(reader.report)
      usedIndependentReader ||= reader.independent

      if (!reader.independent || readerPassed(reader.report)) break
      if (round === MAX_READER_REVISIONS) break

      this.emitStatus(options, 'revision', 'lengdu 主作家正在依据读感重建必要范围...')
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
    this.emitStatus(options, 'calibrator', 'lengdu 作者侧校准者正在独立检查正文...')
    const startedAt = Date.now()
    const trace = this.trace(options, 'calibrator')
    let profile = ''
    try {
      profile = references.read('author-calibrator-profile-v0.2.md')
      const userMessage = [
        '阅读当前正文并按随附档案提交校准记录。',
        '',
        '## 校准者档案',
        profile,
        '',
        '## 当前正文',
        options.content
      ].join('\n')
      const stage = await this.openStageSession(options, {
        stage: 'calibrator',
        round: 0,
        systemPrompt: '你是本次独立作者侧校准者。只处理随后的档案与当前正文，不使用任何工具。',
        userMessage,
        trace,
      })
      try {
        const report = await stage.handle.session.prompt()
        stage.finish()
        this.emitStageLog(options, {
          stage: 'calibrator',
          round: 0,
          systemPrompt: stage.systemPrompt,
          userMessage,
          result: report,
          durationMs: Date.now() - startedAt,
          status: 'success',
          sessionId: stage.handle.sessionId,
          usage: stage.readUsage(),
          payloadTotalChars: stage.payload.totalChars,
          llmRoundTrips: stage.payload.roundTrips,
        })
        return { report, independent: true }
      } finally {
        stage.dispose()
      }
    } catch (error) {
      const aborted = options.signal?.aborted === true
      this.emitStageLog(options, {
        stage: 'calibrator',
        round: 0,
        systemPrompt: profile,
        userMessage: '',
        result: '',
        durationMs: Date.now() - startedAt,
        status: aborted ? 'cancelled' : 'error',
        error: error instanceof Error ? error.message : String(error),
        usage: undefined,
        payloadTotalChars: 0,
        llmRoundTrips: 0,
      })
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
    content: string,
    round: number
  ): Promise<ReaderResult> {
    const startedAt = Date.now()
    const trace = this.trace(options, 'reader', round)
    try {
      const readerProfile = references.read('reader-profile-v0.4.md')
      const packets = splitIntoReadingPackets(content)
      const setupMessage = [
        '完整阅读以下 Reader 档案。之后正文会按原顺序分包发送。',
        '每次只依据目前收到的文字，严格使用档案中的输出格式。',
        '不得索取后文、提供改写、评价 AI 味或检测结果。收到【全文结束】前只返回当前事件包读感。',
        '',
        '## Reader 档案',
        readerProfile
      ].join('\n')
      const stage = await this.openStageSession(options, {
        stage: 'reader',
        round,
        systemPrompt: '你是本次干净的普通 Reader。只按收到的文字首读，不使用任何工具。',
        userMessage: setupMessage,
        trace,
      })

      let report = ''
      try {
        // First send the neutral Reader setup. Subsequent prompt(message) calls
        // then append exactly one event packet to this isolated Session.
        // （底座已把相邻 prompt 的完整生命周期串行化，分包多轮不再撞上
        // Pi 的 "Agent is already processing" 守卫。）
        await stage.handle.session.prompt()

        for (let index = 0; index < packets.length; index += 1) {
          options.signal?.throwIfAborted()
          const finalMarker = index === packets.length - 1 ? '\n\n【全文结束】' : ''
          const packetReport = await stage.handle.session.prompt(
            `【正文事件包 ${index + 1}】\n${packets[index]}${finalMarker}`
          )
          options.onEvent?.({
            kind: 'packet_report',
            round,
            packetIndex: index + 1,
            packetCount: packets.length,
            report: packetReport.trim(),
          })
        }
        report = await stage.handle.session.prompt(
          '请只按 Reader 档案中的“全文输出”格式，给出最终读感。'
        )
        stage.finish()
      } finally {
        stage.dispose()
      }

      this.emitStageLog(options, {
        stage: 'reader',
        round,
        systemPrompt: stage.systemPrompt,
        userMessage: setupMessage,
        result: report,
        durationMs: Date.now() - startedAt,
        status: 'success',
        sessionId: stage.handle.sessionId,
        usage: stage.readUsage(),
        payloadTotalChars: stage.payload.totalChars,
        llmRoundTrips: stage.payload.roundTrips,
      })
      return { report, independent: true }
    } catch (error) {
      const aborted = options.signal?.aborted === true
      this.emitStageLog(options, {
        stage: 'reader',
        round,
        systemPrompt: '',
        userMessage: '',
        result: '',
        durationMs: Date.now() - startedAt,
        status: aborted ? 'cancelled' : 'error',
        error: error instanceof Error ? error.message : String(error),
        usage: undefined,
        payloadTotalChars: 0,
        llmRoundTrips: 0,
      })
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
    try {
      const writerProfile = references.read('writer-profile-v0.3.md')
      const revisionProtocol = references.read('writer-revision-protocol.md')
      const userMessage = [
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
      ].join('\n')
      const stage = await this.openStageSession(options, {
        stage: 'revision',
        round: 0,
        systemPrompt: '你是成熟中文小说作家。只输出修订后的完整正文，不使用工具。',
        userMessage,
        trace,
      })
      try {
        const revised = await stage.handle.session.prompt()
        stage.finish()
        this.emitStageLog(options, {
          stage: 'revision',
          round: 0,
          systemPrompt: stage.systemPrompt,
          userMessage,
          result: revised,
          durationMs: Date.now() - startedAt,
          status: 'success',
          sessionId: stage.handle.sessionId,
          usage: stage.readUsage(),
          payloadTotalChars: stage.payload.totalChars,
          llmRoundTrips: stage.payload.roundTrips,
        })
        return revised
      } finally {
        stage.dispose()
      }
    } catch (error) {
      const aborted = options.signal?.aborted === true
      this.emitStageLog(options, {
        stage: 'revision',
        round: 0,
        systemPrompt: '',
        userMessage: '',
        result: '',
        durationMs: Date.now() - startedAt,
        status: aborted ? 'cancelled' : 'error',
        error: error instanceof Error ? error.message : String(error),
        usage: undefined,
        payloadTotalChars: 0,
        llmRoundTrips: 0,
      })
      if (options.signal?.aborted) throw error
      this.notifyFailure(options, {
        stage: 'revision',
        error,
        traceId: trace.runId,
        content,
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }

  /**
   * 通过底座工厂打开一个阶段会话：StreamEmitter 已订阅并向前端流式推送，
   * 这里只额外订阅 usage、累积 payload 计量，并在结束时补 finishTextMessage。
   */
  private async openStageSession(
    options: LengduWorkflowOptions,
    args: {
      stage: LengduStage
      round: number
      systemPrompt: string
      userMessage: string
      trace: NonNullable<PluginSessionOptions['trace']>
    }
  ): Promise<{
    handle: AgUiSessionHandle
    systemPrompt: string
    payload: { totalChars: number; roundTrips: number }
    readUsage: () => LlmUsageSnapshot | undefined
    finish: () => void
    dispose: () => void
  }> {
    const sink: AgUiEventSink = options.emit ?? (() => {})
    const payload = { totalChars: 0, roundTrips: 0 }
    let capturedUsage: LlmUsageSnapshot | undefined
    const handle = await this.context.createAgUiSession({
      systemPrompt: args.systemPrompt,
      userMessage: args.userMessage,
      tools: [],
      trace: args.trace,
      signal: options.signal,
      modelId: options.modelId,
      timeoutMs: STAGE_TIMEOUT_MS,
      promptCacheScope: `${novelTraceSessionId(options.projectId, options.chapterNumber)}:lengdu:${args.stage}`,
      emit: sink,
      onPayloadStats: (stats) => {
        payload.roundTrips += 1
        payload.totalChars += stats.totalChars
      },
    })
    const unsubscribeUsage = handle.session.subscribe((event: Record<string, unknown>) => {
      if (event.type !== 'message_end') return
      const message = (event as { message?: Record<string, unknown> }).message
      if (!message || message.role !== 'assistant') return
      const next = extractLlmUsageFromMessage(message)
      if (next) capturedUsage = addLlmUsage(capturedUsage, next)
    })
    options.onEvent?.({
      kind: 'stage_start',
      stage: args.stage,
      round: args.round,
      messageId: handle.messageId,
      agentName: STAGE_AGENT_NAMES[args.stage],
    })
    let finished = false
    return {
      handle,
      systemPrompt: args.systemPrompt,
      payload,
      readUsage: () => (hasLlmUsage(capturedUsage) ? capturedUsage : undefined),
      finish: () => {
        if (finished) return
        finished = true
        try {
          handle.streamEmitter.finishTextMessage()
        } catch {
          /* 无文本时 finish 是空操作 */
        }
      },
      dispose: () => {
        unsubscribeUsage()
        handle.dispose()
      },
    }
  }

  private emitStatus(options: LengduWorkflowOptions, stage: LengduStage, message: string): void {
    options.onEvent?.({ kind: 'status', stage, message })
  }

  private emitStageLog(options: LengduWorkflowOptions, log: LengduStageLog): void {
    try {
      options.onStageLog?.(log)
    } catch (logError) {
      this.context.logger.warn(
        { projectId: options.projectId, chapterNumber: options.chapterNumber, err: logError, stage: log.stage },
        'lengdu 阶段日志回调失败',
      )
    }
  }

  private trace(options: LengduWorkflowOptions, stage: LengduStage, round = 0): NonNullable<PluginSessionOptions['trace']> {
    return {
      sessionId: novelTraceSessionId(options.projectId, options.chapterNumber),
      runId: `lengdu:${stage}:${randomUUID()}`,
      metadata: {
        source: 'lengdu',
        projectId: options.projectId,
        chapterNumber: options.chapterNumber,
        stage,
        ...(stage === 'reader' ? { round } : {}),
        agentName: STAGE_AGENT_NAMES[stage],
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

function novelTraceSessionId(projectId: string, chapterNumber: number): string {
  return `novel:chapter:${projectId}:${chapterNumber}`
}

/**
 * 档案解析：显式 Skill 的 references 目录优先（用户可热调），
 * 缺省或文件缺失时回退到随插件分发的内置档案。
 */
class LengduReferences {
  private readonly externalRoot?: string

  constructor(skillPath?: string) {
    this.externalRoot = skillPath ? join(dirname(skillPath), 'references') : undefined
  }

  read(name: string): string {
    const candidates = [
      ...(this.externalRoot ? [join(this.externalRoot, name)] : []),
      join(BUNDLED_PROFILES_DIR, name)
    ]
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      return readFileSync(candidate, 'utf-8')
    }
    throw new Error(`lengdu 档案缺失: ${name}（尝试过: ${candidates.join(', ')}）`)
  }
}

const BUNDLED_PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'profiles')

/**
 * 循环控制与质量报告共用同一套判定。
 *
 * 旧实现两处口径不一致：这里用宽松正则（`看懂：通过（…）`也算过）判"不修订"，
 * buildQualityReport 用严格全等判 needs_attention——出现"不修订但拦发布"的矛盾态。
 * 统一走 parseGateVerdict：修订触发与报告结论永远一致。
 */
export function readerPassed(report: string): boolean {
  const passing: Array<['看懂' | '流畅' | '好看', string]> = [
    ['看懂', '通过'],
    ['流畅', '顺畅'],
    ['好看', '想马上继续'],
  ]
  return passing.every(([label, passingValue]) =>
    parseGateVerdict(report, label, passingValue) === 'passed'
  )
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
