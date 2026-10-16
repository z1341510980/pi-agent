import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from '../core/domain/novel-agents.js'
import {
  getNovelAskStoryPolicy,
  isNovelAskStoryEnabled,
  resolveNovelAgentToolNames,
  type NovelAskStoryPolicy,
} from '../core/domain/novel-ask-story-policy.js'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'

const AGENT_TYPES: NovelAgentType[] = ['director', 'writer', 'reviser', 'reviewer']
const POLICY_ENV = 'PI_NOVEL_ASK_STORY_POLICY'
const originalPolicy = process.env[POLICY_ENV]

function finalToolNames(
  agentType: NovelAgentType,
  policy: NovelAskStoryPolicy,
  extraToolNames: string[] = [],
): string[] {
  return [
    ...resolveNovelAgentToolNames(agentType, NOVEL_AGENT_CONFIGS[agentType].tools, policy),
    ...extraToolNames,
  ]
}

afterEach(() => {
  if (originalPolicy === undefined) delete process.env[POLICY_ENV]
  else process.env[POLICY_ENV] = originalPolicy
})

describe('novel_ask_story policy', () => {
  it('defaults to legacy, trims whitespace, and rejects unknown or differently cased values', () => {
    expect(getNovelAskStoryPolicy(undefined, undefined, 'production')).toBe('legacy')
    expect(getNovelAskStoryPolicy(undefined, '', 'test')).toBe('legacy')
    expect(getNovelAskStoryPolicy(undefined, '   ', 'test')).toBe('legacy')
    expect(getNovelAskStoryPolicy(undefined, 'unknown-policy', 'test')).toBe('legacy')
    expect(getNovelAskStoryPolicy(undefined, 'directorrevieweroff', 'test')).toBe('legacy')
    expect(getNovelAskStoryPolicy(undefined, ' directorReviewerOff ', 'test')).toBe('directorReviewerOff')
    expect(getNovelAskStoryPolicy(undefined, 'allOffWithReferences', 'development')).toBe('allOffWithReferences')
    expect(getNovelAskStoryPolicy('directorReviewerOff', 'legacy', 'production')).toBe('directorReviewerOff')
  })

  it('keeps novel_ask_story available to all four agents in legacy mode', () => {
    for (const agentType of AGENT_TYPES) {
      expect(finalToolNames(agentType, 'legacy')).toContain('novel_ask_story')
      expect(isNovelAskStoryEnabled('legacy', agentType)).toBe(true)
    }
  })

  it('only hides novel_ask_story from Director and Reviewer in directorReviewerOff mode', () => {
    expect(finalToolNames('director', 'directorReviewerOff')).not.toContain('novel_ask_story')
    expect(finalToolNames('reviewer', 'directorReviewerOff')).not.toContain('novel_ask_story')
    expect(finalToolNames('writer', 'directorReviewerOff')).toContain('novel_ask_story')
    expect(finalToolNames('reviser', 'directorReviewerOff')).toContain('novel_ask_story')
  })

  it('preserves closure tools while filtering the static ask_story whitelist', () => {
    expect(finalToolNames('director', 'directorReviewerOff', ['novel_submit_narrative_task']))
      .toEqual(['novel_submit_narrative_task'])
    expect(finalToolNames('reviewer', 'directorReviewerOff', ['novel_submit_review']))
      .toEqual(['novel_submit_review'])
    expect(finalToolNames('reviser', 'directorReviewerOff', ['novel_apply_revision']))
      .toEqual(['novel_ask_story', 'novel_apply_revision'])
  })

  it('disables ask_story for all four agents only when fact-pack injection is active', () => {
    for (const agentType of AGENT_TYPES) {
      expect(finalToolNames(agentType, 'allOffWithReferences')).toContain('novel_ask_story')
      expect(isNovelAskStoryEnabled('allOffWithReferences', agentType)).toBe(true)
      expect(resolveNovelAgentToolNames(
        agentType,
        NOVEL_AGENT_CONFIGS[agentType].tools,
        'allOffWithReferences',
        true,
      )).not.toContain('novel_ask_story')
    }
    expect([
      ...resolveNovelAgentToolNames('director', NOVEL_AGENT_CONFIGS.director.tools, 'allOffWithReferences', true),
      'novel_submit_narrative_task',
    ]).toEqual(['novel_submit_narrative_task'])
    expect([
      ...resolveNovelAgentToolNames('reviser', NOVEL_AGENT_CONFIGS.reviser.tools, 'allOffWithReferences', true),
      'novel_apply_revision',
    ]).toEqual(['novel_apply_revision'])
  })

  it('derives independent tool arrays without mutating static configuration across concurrent runs', async () => {
    const staticTools = Object.fromEntries(
      AGENT_TYPES.map((agentType) => [agentType, [...NOVEL_AGENT_CONFIGS[agentType].tools]]),
    )

    const [disabledDirector, legacyReviewer, disabledReviewer, legacyWriter] = await Promise.all([
      Promise.resolve(resolveNovelAgentToolNames('director', NOVEL_AGENT_CONFIGS.director.tools, 'directorReviewerOff')),
      Promise.resolve(resolveNovelAgentToolNames('reviewer', NOVEL_AGENT_CONFIGS.reviewer.tools, 'legacy')),
      Promise.resolve(resolveNovelAgentToolNames('reviewer', NOVEL_AGENT_CONFIGS.reviewer.tools, 'directorReviewerOff')),
      Promise.resolve(resolveNovelAgentToolNames('writer', NOVEL_AGENT_CONFIGS.writer.tools, 'legacy')),
    ])

    expect(disabledDirector).toEqual([])
    expect(legacyReviewer).toEqual(['novel_ask_story'])
    expect(disabledReviewer).toEqual([])
    expect(legacyWriter).toEqual(['novel_ask_story'])
    for (const agentType of AGENT_TYPES) {
      expect(NOVEL_AGENT_CONFIGS[agentType].tools).toEqual(staticTools[agentType])
    }
  })

  it('snapshots the policy at create-flow start despite a later environment change', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.pendingUserMessages = new Map()
    const project = { novelAskStoryPolicy: 'directorReviewerOff' as NovelAskStoryPolicy }
    orchestrator.store = { getNovelModelId: () => undefined, getProject: () => project }
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    orchestrator.createChapterWithFlowInContext = async () => {
      await blocked
      return { status: 'completed', policy: orchestrator.requireRunContext().askStoryPolicy }
    }

    const flow = orchestrator.createChapterWithFlow('project', 1, {})
    project.novelAskStoryPolicy = 'legacy'
    release!()

    await expect(flow).resolves.toMatchObject({ policy: 'directorReviewerOff' })
  })

  it('changes the unarranged story-state guidance only when ask_story is unavailable', () => {
    const builder = new NovelPromptBuilder({} as any, {} as any)
    const storyState = {
      project: {},
      characters: [],
      relationships: [],
      activeConflicts: [],
      pendingForeshadowing: [],
      activeClues: [],
      activeFactions: [],
      activeLocations: [],
      items: [],
      currentStage: 'setup',
      currentChapter: 1,
    }

    const enabled = (builder as any).formatStoryState(storyState, true)
    const disabled = (builder as any).formatStoryState(storyState, false)

    expect(enabled).toContain('novel_ask_story')
    expect(disabled).not.toContain('novel_ask_story')
    expect(disabled).toContain('请仅依据已注入的章节上下文完成当前职责。')
  })

  it('运行时限额：同一 run 超限后不再调用底层 novel_ask_story，不同 Agent 隔离', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.context = { logger: { warn: vi.fn() } }
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'story' }], details: undefined }))
    const tool = { name: 'novel_ask_story', description: 'ask story', execute }
    const run: { askStoryCounts: Partial<Record<NovelAgentType, number>> } = { askStoryCounts: {} }
    const writerTool = orchestrator.wrapAskStoryWithLimit(tool, run, 'writer', 'p1', 3)
    for (let i = 0; i < 6; i++) await writerTool.execute(`call-${i}`, { projectId: 'foreign', question: '状态' })
    const blocked = await writerTool.execute('call-6', { projectId: 'p1', question: '状态' })
    expect(execute).toHaveBeenCalledTimes(6)
    expect(execute).toHaveBeenNthCalledWith(1, 'call-0', {
      projectId: 'p1', question: '状态', chapterNumber: 3,
    })
    expect(blocked.content[0].text).toContain('额度已用完')
    expect(run.askStoryCounts.writer).toBe(6)

    const reviewerTool = orchestrator.wrapAskStoryWithLimit(tool, run, 'reviewer', 'p1', 3)
    await reviewerTool.execute('reviewer-call', { projectId: 'p1', question: '状态' })
    expect(execute).toHaveBeenCalledTimes(7)
    expect(run.askStoryCounts.reviewer).toBe(1)
  })

  it('persists the normalized policy and per-agent enabled value in both audit logs', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    const insertedLogs: Array<Record<string, unknown>> = []
    const universalLogs: Array<Record<string, unknown>> = []
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.pendingUserMessages = new Map()
    orchestrator.store = {
      getChapter: () => ({ narrativeTask: '推进主线', positioning: null }),
      insertAgentLog: (entry: Record<string, unknown>) => insertedLogs.push(entry),
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ conflictTargets: [], suspenseHooks: [], rhythmConstraint: '', wordBudget: { target: 3000 } }),
    }
    orchestrator.promptBuilder = {
      buildAgentIdentity: () => 'identity',
      buildSystemPrompt: () => 'system',
      getChapterBoundaryContext: () => ({
        chapterNumber: 3,
        fromSnapshot: false,
        state: {},
        entities: {
          characters: [], relationships: [], conflicts: [], foreshadowing: [], clues: [],
          factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
        },
      }),
      // 2026-08-12 逻辑统一：orchestrator 恒走 chunk 组装，mock 需提供 chunk 路径方法
      buildChapterContextChunks: () => [{ chunkId: 'chapter-info', content: 'shared' }],
      assembleSharedFromChunks: (chunks: Array<{ chunkId: string; content: string }>) =>
        chunks.map((c) => c.content).join('\n\n---\n\n'),
      chooseChapterEntitySummaryMode: () => 'full',
      buildChapterContextSuffix: () => 'suffix',
      buildArrangedEntitiesSection: () => '',
      buildReferenceFactPack: () => '',
      buildReviewFactPack: () => '',
      buildWriterSceneExpertFocus: () => '',
      stripEmDash: (value: string) => value,
    }
    orchestrator.novelTools = [{ name: 'novel_ask_story', description: 'ask story' }]
    orchestrator.context = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      db: { prepare: vi.fn() },
      subagentManager: undefined,
      agentCallLogger: { record: (entry: Record<string, unknown>) => universalLogs.push(entry) },
      createAgUiSession: vi.fn(async () => ({
        sessionId: 'session-1',
        // Writer 输出现在严格遵守中文正文协议；其它 Agent 仍只关心调用审计字段。
        session: { sessionId: 'session-1', subscribe: () => () => {}, prompt: async () => '这是用于策略审计的中文正文。' },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: 'message-1',
        dispose: vi.fn(),
      })),
    }
    orchestrator.emitProgress = vi.fn()

    const invoke = async (
      agentType: NovelAgentType,
      policy: NovelAskStoryPolicy,
      contextMode?: 'identity_only',
    ): Promise<void> => {
      await orchestrator.runStorage.run({
        askStoryPolicy: policy,
        factPackPathActive: true,
        semiLayerSharedCache: null,
        budget: undefined,
      }, async () => {
        await orchestrator.runAgentOnce(
          agentType,
          'project',
          1,
          'task',
          { onProgress: vi.fn(), emit: vi.fn() },
          contextMode ? { contextMode } : undefined,
        )
      })
    }

    await invoke('director', 'directorReviewerOff')
    await invoke('reviewer', 'directorReviewerOff')
    await invoke('writer', 'directorReviewerOff')
    await invoke('reviser', 'directorReviewerOff')
    await invoke('director', 'legacy')
    await invoke('reviewer', 'allOffWithReferences')
    await invoke('reviewer', 'legacy', 'identity_only')

    expect(insertedLogs.map((entry) => [entry.agentType, entry.askStoryPolicy, entry.askStoryEnabled])).toEqual([
      ['director', 'directorReviewerOff', false],
      ['reviewer', 'directorReviewerOff', false],
      ['writer', 'directorReviewerOff', true],
      ['reviser', 'directorReviewerOff', true],
      ['director', 'legacy', true],
      ['reviewer', 'allOffWithReferences', false],
      ['reviewer', 'legacy', false],
    ])
    expect(universalLogs.map((entry) => JSON.parse(entry.metadata as string))).toEqual(expect.arrayContaining([
      expect.objectContaining({ askStoryPolicy: 'directorReviewerOff', askStoryEnabled: false }),
      expect.objectContaining({ askStoryPolicy: 'directorReviewerOff', askStoryEnabled: true }),
      expect.objectContaining({ askStoryPolicy: 'legacy', askStoryEnabled: true }),
      expect.objectContaining({ askStoryPolicy: 'allOffWithReferences', askStoryEnabled: false }),
    ]))
  })
})
