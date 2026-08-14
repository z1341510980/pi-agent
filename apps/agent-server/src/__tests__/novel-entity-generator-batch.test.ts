import { describe, expect, it } from 'vitest'
import { NovelEntityGenerator, type GeneratedEntity } from '../plugins/novel-plugin/core/generation/novel-entity-generator.js'

type BatchRun = {
  generated: Map<object, GeneratedEntity>
  itemCount: number
  batchCount: number
  retryCount: number
  fallbackCount: number
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  calls: Array<{
    operation: string
    sessionId: string
    payloadStats: { messagesChars: number; toolsChars: number; toolCount: number; totalChars: number; roundTrips: number }
  }>
}

type BatchRunner = {
  generatePlanInBatches(
    projectId: string,
    plan: unknown,
    onProgress?: (event: unknown) => void,
    signal?: AbortSignal,
  ): Promise<BatchRun>
}

function character(name: string): Record<string, unknown> {
  return {
    name,
    description: `${name}的简介`,
    identity: '身份',
    personality: '性格',
    appearance: '外貌',
    currentState: '当前状态',
    currentGoal: '当前目标',
    currentPressure: '当前压力',
    secret: '秘密',
    arcStage: 'setup',
    speechStyle: '简短',
    longTermDesire: '长期欲望',
    plotRole: 'supporting',
    removalImpact: '影响剧情推进',
  }
}

function createGenerator(outputs: string[]) {
  const sessionOptions: Array<{ userMessage: string; onPayloadStats?: (stats: any) => void }> = []
  const context = {
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    createSession: async (options: { userMessage: string; onPayloadStats?: (stats: any) => void }) => {
      sessionOptions.push(options)
      const output = outputs.shift() ?? '{"items":[]}'
      const sessionId = `session-${sessionOptions.length}`
      let subscriber: ((event: Record<string, unknown>) => void) | undefined
      return {
        subscribe: (listener: (event: Record<string, unknown>) => void) => {
          subscriber = listener
          return () => { subscriber = undefined }
        },
        promptStream: async (onDelta: (delta: string) => void) => {
          options.onPayloadStats?.({ messagesChars: 100, toolsChars: 20, toolCount: 3, totalChars: 150 })
          onDelta(output)
          subscriber?.({
            type: 'message_end',
            message: {
              role: 'assistant',
              provider: 'test-provider',
              model: 'test-model',
              usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
            },
          })
          return output
        },
        dispose: () => undefined,
        sessionId,
      }
    },
  }
  const promptBuilder = {
    buildSystemPrompt: () => 'system',
    buildAgentIdentity: () => 'identity',
  }
  const generator = new NovelEntityGenerator(
    promptBuilder as never,
    {} as never,
    context as never,
    {} as never,
    {} as never,
  )
  return { runner: generator as unknown as BatchRunner, sessionOptions }
}

describe('NovelEntityGenerator batch generation', () => {
  it('每批最多生成 4 个同类实体', async () => {
    const specs = Array.from({ length: 5 }, (_, index) => ({ coreStyle: `角色${index}` }))
    const firstItems = specs.slice(0, 4).map((_, index) => ({ index, result: character(`姓名${index}`) }))
    const secondItems = [{ index: 0, result: character('姓名4') }]
    const { runner, sessionOptions } = createGenerator([
      JSON.stringify({ items: firstItems }),
      JSON.stringify({ items: secondItems }),
    ])

    const run = await runner.generatePlanInBatches('project-1', {
      characters: specs,
      conflicts: [],
      foreshadows: [],
      factions: [],
      locations: [],
      items: [],
    })

    expect(run.itemCount).toBe(5)
    expect(run.batchCount).toBe(2)
    expect(run.generated.size).toBe(5)
    expect(sessionOptions).toHaveLength(2)
    expect(sessionOptions[0].userMessage).toContain('角色3')
    expect(sessionOptions[0].userMessage).not.toContain('角色4')
    expect(sessionOptions[1].userMessage).toContain('角色4')
  })

  it('只重试校验失败项并累加两次请求的 token', async () => {
    const validSpec = { coreStyle: '沉着的巡夜人' }
    const invalidSpec = { coreStyle: '急躁的信使' }
    const { runner, sessionOptions } = createGenerator([
      JSON.stringify({
        items: [
          { index: 0, result: character('周巡') },
          { index: 1, result: { ...character(''), name: '' } },
        ],
      }),
      JSON.stringify({ items: [{ index: 0, result: character('季风') }] }),
    ])

    const run = await runner.generatePlanInBatches('project-1', {
      characters: [validSpec, invalidSpec],
      conflicts: [],
      foreshadows: [],
      factions: [],
      locations: [],
      items: [],
    })

    expect(run.retryCount).toBe(1)
    expect(run.fallbackCount).toBe(0)
    expect((run.generated.get(validSpec) as Extract<GeneratedEntity, { type: 'character' }>).data.name).toBe('周巡')
    expect((run.generated.get(invalidSpec) as Extract<GeneratedEntity, { type: 'character' }>).data.name).toBe('季风')
    expect(sessionOptions[1].userMessage).toContain('急躁的信使')
    expect(sessionOptions[1].userMessage).not.toContain('沉着的巡夜人')
    expect(run.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
    })
    expect(run.calls.map((call) => call.operation)).toEqual(['batch', 'retry'])
    expect(run.calls.map((call) => call.sessionId)).toEqual(['session-1', 'session-2'])
    expect(run.calls.map((call) => call.payloadStats)).toEqual([
      { messagesChars: 100, toolsChars: 20, toolCount: 3, totalChars: 150, roundTrips: 1 },
      { messagesChars: 100, toolsChars: 20, toolCount: 3, totalChars: 150, roundTrips: 1 },
    ])
  })

  it('编排收到中止信号后不再启动任何批次', async () => {
    const { runner, sessionOptions } = createGenerator([])
    const controller = new AbortController()
    controller.abort(new Error('用户手动停止'))

    await expect(runner.generatePlanInBatches('project-1', {
      characters: [{ coreStyle: '新角色' }],
      conflicts: [],
      foreshadows: [],
      factions: [],
      locations: [],
      items: [],
    }, undefined, controller.signal)).rejects.toThrow('用户手动停止')
    expect(sessionOptions).toHaveLength(0)
  })
})
