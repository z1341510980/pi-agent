import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import type {
  AgUiSessionHandle,
  PluginContext,
  PluginSessionOptions
} from '../../../../core/plugin/plugin-types.js'
import {
  LengduWorkflow,
  splitIntoReadingPackets,
  type LengduFlowEvent,
  type LengduStageLog
} from './lengdu-workflow.js'

const SKILL_PATH = join(resolve(process.cwd(), '../..'), '.claude', 'skills', 'lengdu', 'SKILL.md')

interface FakeStageEntry {
  options: PluginSessionOptions
  messages: Array<string | undefined>
  finished: boolean
  disposed: boolean
}

interface FakeAgUiContext {
  context: PluginContext
  sessions: FakeStageEntry[]
}

/**
 * 模拟 createAgUiSession 底座：prompt 消息按序收集，响应由各测试自定义。
 * session.subscribe 返回空退订（usage 断言走 onStageLog 的 undefined 兜底）。
 */
function createFakeContext(
  respond: (sessionIndex: number, message: string | undefined) => string,
  options: { failSessionAt?: (sessionIndex: number) => boolean } = {}
): FakeAgUiContext {
  const sessions: FakeStageEntry[] = []
  const context = {
    logger: { warn: vi.fn() },
    createAgUiSession: vi.fn(async (sessionOptions: PluginSessionOptions): Promise<AgUiSessionHandle> => {
      const index = sessions.length
      if (options.failSessionAt?.(index)) throw new Error(`stage ${index} unavailable`)
      const entry: FakeStageEntry = { options: sessionOptions, messages: [], finished: false, disposed: false }
      sessions.push(entry)
      return {
        session: {
          sessionId: `sess-${index}`,
          async prompt(message?: string): Promise<string> {
            entry.messages.push(message)
            return respond(index, message)
          },
          promptStream: vi.fn(),
          subscribe: () => () => {},
          abort: vi.fn(),
          dispose: vi.fn(),
        } as unknown as AgUiSessionHandle['session'],
        streamEmitter: {
          finishTextMessage: vi.fn(() => {
            entry.finished = true
          }),
        } as unknown as AgUiSessionHandle['streamEmitter'],
        reasoningPipeline: {} as AgUiSessionHandle['reasoningPipeline'],
        messageId: `msg-${index}`,
        sessionId: `sess-${index}`,
        dispose: vi.fn(() => {
          entry.disposed = true
        }),
      }
    }),
  } as unknown as PluginContext & {
    createAgUiSession: ReturnType<typeof vi.fn>
  }
  return { context, sessions }
}

const CALIBRATION_OK = '## 校准结论\n- 是否发现明确候选：否'
const READER_PASS = '## 最终读感\n- 看懂：通过\n- 流畅：顺畅\n- 好看：想马上继续'
const READER_FAIL = '## 最终读感\n- 看懂：勉强通过\n- 流畅：偶尔卡\n- 好看：有空可能继续'
const PACKET_OK = '## 这段读感\n- 看懂：一眼懂\n- 流畅：顺着读\n- 好看：想接着看'

describe('LengduWorkflow', () => {
  it('uses fresh calibration and Reader AG-UI sessions, then reads the draft packet by packet', async () => {
    const { context, sessions } = createFakeContext((sessionIndex, message) => {
      if (sessionIndex === 0) return CALIBRATION_OK
      if (message?.includes('全文输出')) return READER_PASS
      return PACKET_OK
    })
    const events: LengduFlowEvent[] = []
    const stageLogs: LengduStageLog[] = []

    const result = await new LengduWorkflow(context).run({
      projectId: 'project-1',
      chapterNumber: 1,
      content: '第一段正文。\n\n第二段正文。',
      skillPath: SKILL_PATH,
      emit: () => {},
      onEvent: event => events.push(event),
      onStageLog: log => stageLogs.push(log),
    })

    expect(result.content).toBe('第一段正文。\n\n第二段正文。')
    expect(result.usedIndependentCalibration).toBe(true)
    expect(result.usedIndependentReader).toBe(true)
    expect(result.revisionCount).toBe(0)
    expect(result.quality).toMatchObject({
      status: 'passed',
      calibration: 'independent',
      reader: 'independent',
      comprehension: 'passed',
      fluency: 'passed',
      appeal: 'passed',
    })

    // 校准者 + Reader 两个独立会话；均显式禁用工具并挂同一 trace 会话
    expect(sessions).toHaveLength(2)
    expect(sessions.map((entry) => entry.options.tools)).toEqual([[], []])
    expect(sessions.map((entry) => entry.options.trace?.sessionId)).toEqual([
      'novel:chapter:project-1:1',
      'novel:chapter:project-1:1',
    ])
    expect(sessions[0].options.userMessage).toContain('当前正文')
    // Reader 首轮为档案装载（无参 prompt），随后逐包发送，最后请求全文输出
    expect(sessions[1].messages[0]).toBeUndefined()
    expect(sessions[1].messages[1]).toContain('【正文事件包 1】')
    expect(sessions[1].messages.at(-1)).toContain('全文输出')
    // 会话收尾：finishTextMessage + dispose 都被调用（AG-UI 流关闭、句柄释放）
    expect(sessions.map((entry) => entry.finished)).toEqual([true, true])
    expect(sessions.map((entry) => entry.disposed)).toEqual([true, true])

    // 前端契约：每个阶段都有带 messageId 的 agent_start 来源事件
    const starts = events.filter(event => event.kind === 'stage_start')
    expect(starts.map(event => (event.kind === 'stage_start' ? event.stage : '')))
      .toEqual(['calibrator', 'reader'])
    // 包级读感事件：短文合并为单包，仍逐包上报（"第几包开始卡"的载体）
    const packets = events.filter(event => event.kind === 'packet_report')
    expect(packets.map(event => (event.kind === 'packet_report' ? event.packetIndex : 0)))
      .toEqual([1])
    expect(packets[0]?.kind === 'packet_report' ? packets[0].packetCount : 0).toBe(1)
    // 阶段日志：成功两条，阶段名与展示口径一致
    expect(stageLogs.map(log => [log.stage, log.status])).toEqual([
      ['calibrator', 'success'],
      ['reader', 'success'],
    ])
    expect(stageLogs[1].sessionId).toBe('sess-1')
  })

  it('keeps paragraph boundaries while splitting Reader event packets', () => {
    const content = ['甲'.repeat(500), '乙'.repeat(500), '丙'.repeat(300)].join('\n\n')
    expect(splitIntoReadingPackets(content)).toEqual([
      ['甲'.repeat(500)].join(''),
      ['乙'.repeat(500), '丙'.repeat(300)].join('\n\n')
    ])
  })

  it('falls back to bundled profiles when no external skill path is provided', async () => {
    const { context, sessions } = createFakeContext((_index, message) =>
      message?.includes('全文输出') ? READER_PASS : PACKET_OK
    )

    const result = await new LengduWorkflow(context).run({
      projectId: 'project-1',
      chapterNumber: 2,
      content: '第一段正文。\n\n第二段正文。',
      // 不传 skillPath：必须回退到插件内置档案而不是跳过或抛错
    })

    expect(result.quality.status).toBe('passed')
    expect(sessions[0].options.userMessage).toContain('校准者档案')
    expect(sessions[0].options.userMessage.length).toBeGreaterThan(1000)
  })

  it('reports an explicit degraded result instead of claiming an independent Reader check', async () => {
    const onDegraded = vi.fn()
    const { context } = createFakeContext(() => CALIBRATION_OK, {
      failSessionAt: index => index === 1,
    })
    const stageLogs: LengduStageLog[] = []

    const result = await new LengduWorkflow(context).run({
      projectId: 'project-1',
      chapterNumber: 2,
      content: '第一段正文。',
      skillPath: SKILL_PATH,
      onDegraded,
      onStageLog: log => stageLogs.push(log),
    })

    expect(result.revisionCount).toBe(0)
    expect(result.quality).toMatchObject({
      status: 'degraded',
      calibration: 'independent',
      reader: 'self_review',
      comprehension: 'needs_attention',
      fluency: 'needs_attention',
      appeal: 'needs_attention',
    })
    expect(result.quality.summary).toContain('自审降级')
    expect(onDegraded).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'reader',
      error: expect.objectContaining({ message: 'stage 1 unavailable' }),
      traceId: expect.stringMatching(/^lengdu:reader:/),
      content: '第一段正文。',
      durationMs: expect.any(Number),
    }))
    // 失败阶段同样落日志，便于 AgentLog 面板与预算侧观察
    expect(stageLogs).toHaveLength(2)
    expect(stageLogs[1]).toMatchObject({ stage: 'reader', status: 'error' })
  })

  it('reports a revision failure with the failed stage and trace context', async () => {
    const onFailure = vi.fn()
    const { context } = createFakeContext((sessionIndex, message) => {
      if (sessionIndex === 0) return CALIBRATION_OK
      if (message?.includes('全文输出')) return READER_FAIL
      return PACKET_OK
    }, { failSessionAt: index => index === 2 })

    await expect(new LengduWorkflow(context).run({
      projectId: 'project-1',
      chapterNumber: 4,
      content: '需要修订的正文。',
      skillPath: SKILL_PATH,
      onFailure,
    })).rejects.toThrow('stage 2 unavailable')

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'revision',
      error: expect.objectContaining({ message: 'stage 2 unavailable' }),
      traceId: expect.stringMatching(/^lengdu:revision:/),
      content: '需要修订的正文。',
      durationMs: expect.any(Number),
    }))
  })

  it('revises a failed draft with the writer profile, then checks the new version with another Reader', async () => {
    const { context, sessions } = createFakeContext((sessionIndex, message) => {
      if (sessionIndex === 0) return CALIBRATION_OK
      if (sessionIndex === 2) return '修订后的正文。'
      if (message?.includes('全文输出')) {
        return sessionIndex === 1 ? READER_FAIL : READER_PASS
      }
      return PACKET_OK
    })

    const result = await new LengduWorkflow(context).run({
      projectId: 'project-1',
      chapterNumber: 3,
      content: '初稿正文。',
      skillPath: SKILL_PATH,
    })

    expect(result.content).toBe('修订后的正文。')
    expect(result.revisionCount).toBe(1)
    expect(result.quality.status).toBe('passed')
    expect(sessions).toHaveLength(4)
    expect(sessions[2].options.userMessage).toContain('## 作家人格档案')
    expect(sessions[3].options.trace?.runId).toMatch(/^lengdu:reader:/)
    expect(sessions[3].options.trace?.runId).not.toBe(sessions[1].options.trace?.runId)
  })
})
