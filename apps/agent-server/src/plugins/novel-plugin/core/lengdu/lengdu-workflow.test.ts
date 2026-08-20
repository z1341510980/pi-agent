import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import type { PluginContext, PluginSessionOptions } from '../../../../core/plugin/plugin-types.js'
import { LengduWorkflow, splitIntoReadingPackets } from './lengdu-workflow.js'

const SKILL_PATH = join(resolve(process.cwd(), '../..'), '.claude', 'skills', 'lengdu', 'SKILL.md')

describe('LengduWorkflow', () => {
  it('uses fresh calibration and Reader sessions, then reads the draft packet by packet', async () => {
    const sessions: Array<{ options: PluginSessionOptions; messages: Array<string | undefined> }> =
      []
    const context = {
      logger: { warn: vi.fn() },
      createSession: vi.fn(async (options: PluginSessionOptions) => {
        const entry = { options, messages: [] as Array<string | undefined> }
        sessions.push(entry)
        const sessionIndex = sessions.length - 1
        return {
          async prompt(message?: string): Promise<string> {
            entry.messages.push(message)
            if (sessionIndex === 0) return '## 校准结论\n- 是否发现明确候选：否'
            if (message?.includes('全文输出')) {
              return '## 最终读感\n- 看懂：通过\n- 流畅：顺畅\n- 好看：想马上继续'
            }
            return '## 这段读感\n- 看懂：一眼懂\n- 流畅：顺着读\n- 好看：想接着看'
          },
          promptStream: vi.fn(),
          subscribe: () => () => {},
          abort: vi.fn(),
          dispose: vi.fn()
        }
      })
    } as unknown as PluginContext

    const result = await new LengduWorkflow(context).run({
      projectId: 'project-1',
      chapterNumber: 1,
      content: '第一段正文。\n\n第二段正文。',
      skillPath: SKILL_PATH
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
    expect(sessions).toHaveLength(2)
    expect(sessions.map((session) => session.options.tools)).toEqual([[], []])
    expect(sessions.map((session) => session.options.trace?.sessionId)).toEqual([
      'novel:chapter:project-1:1',
      'novel:chapter:project-1:1',
    ])
    expect(sessions[0].options.userMessage).toContain('当前正文')
    expect(sessions[1].messages[0]).toBeUndefined()
    expect(sessions[1].messages[1]).toContain('【正文事件包 1】')
    expect(sessions[1].messages.at(-1)).toContain('全文输出')
  })

  it('keeps paragraph boundaries while splitting Reader event packets', () => {
    const content = ['甲'.repeat(500), '乙'.repeat(500), '丙'.repeat(300)].join('\n\n')
    expect(splitIntoReadingPackets(content)).toEqual([
      ['甲'.repeat(500)].join(''),
      ['乙'.repeat(500), '丙'.repeat(300)].join('\n\n')
    ])
  })

  it('reports an explicit degraded result instead of claiming an independent Reader check', async () => {
    let created = 0
    const onDegraded = vi.fn()
    const context = {
      logger: { warn: vi.fn() },
      createSession: vi.fn(async (_options: PluginSessionOptions) => {
        created += 1
        if (created === 2) throw new Error('Reader unavailable')
        return {
          prompt: vi.fn(async () => '## 校准结论\n- 是否发现明确候选：否'),
          promptStream: vi.fn(),
          subscribe: () => () => {},
          abort: vi.fn(),
          dispose: vi.fn(),
        }
      }),
    } as unknown as PluginContext

    const result = await new LengduWorkflow(context).run({
      projectId: 'project-1',
      chapterNumber: 2,
      content: '第一段正文。',
      skillPath: SKILL_PATH,
      onDegraded,
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
      error: expect.objectContaining({ message: 'Reader unavailable' }),
      traceId: expect.stringMatching(/^lengdu:reader:/),
      content: '第一段正文。',
      durationMs: expect.any(Number),
    }))
  })

  it('reports a revision failure with the failed stage and trace context', async () => {
    let created = 0
    const onFailure = vi.fn()
    const context = {
      logger: { warn: vi.fn() },
      createSession: vi.fn(async () => {
        created += 1
        if (created === 3) throw new Error('Revision provider unavailable')
        return {
          async prompt(message?: string): Promise<string> {
            if (created === 1) return '## 校准结论\n- 是否发现明确候选：否'
            if (message?.includes('全文输出')) {
              return '## 最终读感\n- 看懂：勉强通过\n- 流畅：偶尔卡\n- 好看：有空可能继续'
            }
            return '## 这段读感\n- 看懂：一眼懂\n- 流畅：顺着读\n- 好看：想接着看'
          },
          promptStream: vi.fn(),
          subscribe: () => () => {},
          abort: vi.fn(),
          dispose: vi.fn(),
        }
      }),
    } as unknown as PluginContext

    await expect(new LengduWorkflow(context).run({
      projectId: 'project-1',
      chapterNumber: 4,
      content: '需要修订的正文。',
      skillPath: SKILL_PATH,
      onFailure,
    })).rejects.toThrow('Revision provider unavailable')

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'revision',
      error: expect.objectContaining({ message: 'Revision provider unavailable' }),
      traceId: expect.stringMatching(/^lengdu:revision:/),
      content: '需要修订的正文。',
      durationMs: expect.any(Number),
    }))
  })

  it('revises a failed draft with the writer profile, then checks the new version with another Reader', async () => {
    const sessions: Array<{ options: PluginSessionOptions; messages: Array<string | undefined> }> = []
    const context = {
      logger: { warn: vi.fn() },
      createSession: vi.fn(async (options: PluginSessionOptions) => {
        const entry = { options, messages: [] as Array<string | undefined> }
        sessions.push(entry)
        const sessionIndex = sessions.length - 1
        return {
          async prompt(message?: string): Promise<string> {
            entry.messages.push(message)
            if (sessionIndex === 0) return '## 校准结论\n- 是否发现明确候选：否'
            if (sessionIndex === 2) return '修订后的正文。'
            if (message?.includes('全文输出')) {
              return sessionIndex === 1
                ? '## 最终读感\n- 看懂：勉强通过\n- 流畅：偶尔卡\n- 好看：有空可能继续'
                : '## 最终读感\n- 看懂：通过\n- 流畅：顺畅\n- 好看：想马上继续'
            }
            return '## 这段读感\n- 看懂：一眼懂\n- 流畅：顺着读\n- 好看：想接着看'
          },
          promptStream: vi.fn(),
          subscribe: () => () => {},
          abort: vi.fn(),
          dispose: vi.fn(),
        }
      }),
    } as unknown as PluginContext

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
