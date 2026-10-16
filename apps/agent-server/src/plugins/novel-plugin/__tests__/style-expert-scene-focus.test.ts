/**
 * 专家团场景聚焦 + 本章风格决策注入测试。
 *
 * 覆盖两处创作流程优化：
 * 1. buildSceneExpertFocus / buildWriterSceneExpertFocus：按主导场景优先放大维度专家，
 *    尊重 styleExpertIds 召集过滤，无维度标注的专家不受影响；
 * 2. Reviewer/Reviser 的 per-chapter 风格决策注入：验收与修订能看到本章许可波动。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'
import {
  buildSceneExpertFocus,
  compileWritingStylePrompt,
} from '../core/prompting/writing-style-prompt-factory.js'
import type { NovelWritingStyleProfile } from '@repo/shared/novel'

let expertSeq = 0
const DIMENSION_LABELS: Record<string, string> = {
  scene_craft: '场景',
  character_craft: '人物',
  dialogue_craft: '对话',
  action_craft: '打斗',
  emotion_craft: '情感',
  conflict_craft: '冲突',
  narrative_craft: '叙事',
}
type StyleExpertLike = NonNullable<NovelWritingStyleProfile['styleExperts']>[number]
function makeExpert(dimension?: string, overrides: Record<string, unknown> = {}): StyleExpertLike {
  expertSeq += 1
  return {
    id: `expert-${expertSeq}`,
    projectId: 'p1',
    name: `${dimension ? (DIMENSION_LABELS[dimension] ?? dimension) : '手动'}专家${expertSeq}`,
    sourceTitle: '参考小说A',
    description: '能力摘要',
    distilledPrompt: '迁移提示词',
    enabled: true,
    sortOrder: expertSeq,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...(dimension ? { dimension } : {}),
    ...overrides,
  } as StyleExpertLike
}

describe('buildSceneExpertFocus', () => {
  it('对话场优先放大对话维度，其次情感/人物', () => {
    const focus = buildSceneExpertFocus({
      experts: [makeExpert('scene_craft'), makeExpert('dialogue_craft'), makeExpert('emotion_craft')],
      sceneType: 'dialogue',
    })
    expect(focus).toContain('本章优先文风能力')
    expect(focus).toContain('主导场景：对话场')
    expect(focus.indexOf('对话专家')).toBeGreaterThan(-1)
    expect(focus.indexOf('对话专家')).toBeLessThan(focus.indexOf('情感专家'))
    // 非优先维度不进入聚焦段
    expect(focus).not.toContain('场景专家')
    // 展开版给足预算：迁移提示完整保留（简版会截断到 300 字符）
    expect(focus).toContain('迁移提示：迁移提示词')
  })

  it('动作场映射打斗/冲突/情感维度', () => {
    const focus = buildSceneExpertFocus({
      experts: [makeExpert('action_craft'), makeExpert('conflict_craft')],
      sceneType: 'action',
    })
    expect(focus).toContain('主导场景：动作场')
    expect(focus.indexOf('打斗专家')).toBeLessThan(focus.indexOf('冲突专家'))
  })

  it('maxExperts 截断与同维度多专家保持优先序', () => {
    const focus = buildSceneExpertFocus({
      experts: [
        makeExpert('dialogue_craft'),
        makeExpert('dialogue_craft'),
        makeExpert('emotion_craft'),
        makeExpert('character_craft'),
      ],
      sceneType: 'dialogue',
      maxExperts: 3,
    })
    expect(focus).toContain('对话专家')
    expect(focus).toContain('情感专家')
    // 第 4 个（人物）被截断
    expect(focus).not.toContain('人物专家')
  })

  it('无维度标注的手动专家不参与聚焦；无匹配时返回空串', () => {
    const manualOnly = buildSceneExpertFocus({
      experts: [makeExpert(undefined), makeExpert(undefined)],
      sceneType: 'dialogue',
    })
    expect(manualOnly).toBe('')
    expect(buildSceneExpertFocus({ experts: [], sceneType: 'quiet' })).toBe('')
  })

  it('禁用的专家不参与聚焦', () => {
    const focus = buildSceneExpertFocus({
      experts: [makeExpert('dialogue_craft', { enabled: false })],
      sceneType: 'dialogue',
    })
    expect(focus).toBe('')
  })
})

describe('buildWriterSceneExpertFocus 与 suffix 注入', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore
  let builder: NovelPromptBuilder
  let projectId: string

  function promptStores(s: NovelStore): Record<string, (...args: never[]) => unknown> {
    return {
      getProject: ((id: string) => s.getProject(id)) as never,
      listWorldRules: ((id: string) => s.listWorldRules(id)) as never,
      listStyleGuide: ((id: string) => s.listStyleGuide(id)) as never,
      getWritingStyleProfile: ((id: string) => s.getWritingStyleProfile(id)) as never,
      listRecentChapters: ((id: string, limit: number) => s.listRecentChapters(id, limit)) as never,
      getChapter: ((id: string, chapter: number) => s.getChapter(id, chapter)) as never,
      listVolumes: ((id: string) => s.listVolumes(id)) as never,
    }
  }

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    projectId = crypto.randomUUID()
    store.createProject({
      id: projectId, title: '聚焦测试', genre: '悬疑', synopsis: '', outline: '', targetWords: 0,
      currentVolume: 1, currentChapter: 1, currentStage: 'rising', status: 'active',
    })
    store.createChapter({
      id: 'ch1', projectId, volume: 1, chapterNumber: 1, title: '', content: '', wordCount: 0,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    })
    const promptManager = { render: () => '', getTemplate: () => '' } as any
    builder = new NovelPromptBuilder(promptManager, promptStores(store) as never, memoryStore)
  })

  function seedTeam(): void {
    store.upsertWritingStyleProfile(projectId, {
      name: '档案', preset: 'custom', narrativePerson: 'third', narrativeDistance: 'limited',
      sentenceRhythm: 'balanced', dialogueRatio: 45, emotionalTemperature: 5, imageryDensity: 3,
      vocabularyRegister: 'plain', hardRules: [], softRules: [], positiveExamples: [],
      negativeExamples: [], notes: '',
    })
    for (const dimension of ['dialogue_craft', 'emotion_craft', 'scene_craft']) {
      store.createStyleExpert({
        id: `team-${dimension}`, projectId, name: `${dimension}卡`, sourceTitle: '参考小说A',
        description: '能力摘要', distilledPrompt: '迁移提示词', dimension, teamKey: 'source-1',
        reviewStatus: 'approved', enabled: true, sortOrder: 0, version: 1,
      })
    }
  }

  it('未指定召集时放大全部启用团队专家中匹配维度的卡', () => {
    seedTeam()
    const focus = builder.buildWriterSceneExpertFocus(projectId, '审讯室对峙，逼问玉佩下落')
    expect(focus).toContain('本章优先文风能力')
    expect(focus).toContain('dialogue_craft卡')
    expect(focus).toContain('emotion_craft卡')
    expect(focus).not.toContain('scene_craft卡')
  })

  it('召集过滤生效：空召集返回空串，部分召集只放大已召维度', () => {
    seedTeam()
    expect(builder.buildWriterSceneExpertFocus(projectId, '审讯室对峙', [])).toBe('')
    const partial = builder.buildWriterSceneExpertFocus(
      projectId, '审讯室对峙，逼问玉佩下落', ['team-emotion_craft'],
    )
    expect(partial).toContain('emotion_craft卡')
    expect(partial).not.toContain('dialogue_craft卡')
  })

  it('草稿专家（enabled=false）不参与聚焦', () => {
    store.upsertWritingStyleProfile(projectId, {
      name: '档案', preset: 'custom', narrativePerson: 'third', narrativeDistance: 'limited',
      sentenceRhythm: 'balanced', dialogueRatio: 45, emotionalTemperature: 5, imageryDensity: 3,
      vocabularyRegister: 'plain', hardRules: [], softRules: [], positiveExamples: [],
      negativeExamples: [], notes: '',
    })
    store.createStyleExpert({
      id: 'draft-dialogue', projectId, name: '对话草稿', sourceTitle: '参考小说A',
      description: '能力摘要', distilledPrompt: '迁移提示词', dimension: 'dialogue_craft',
      teamKey: 'source-1', reviewStatus: 'draft', enabled: false, sortOrder: 0, version: 1,
    })
    expect(builder.buildWriterSceneExpertFocus(projectId, '审讯室对峙')).toBe('')
  })

  it('Reviewer suffix 含本章风格决策；Reviser 获得 reviser-guidance chunk', () => {
    const task = { description: '审讯室对峙，逼问玉佩下落', type: 'create_conflict', targetEntity: null, priority: 'medium' } as never
    const constraints = {
      facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [],
      conflictTargets: [], suspenseHooks: [], positioning: 'high_pressure',
    } as never
    const reviewerChunks = builder.buildChapterContextSuffixChunks(
      projectId, 1, task, constraints, undefined, 'reviewer',
    )
    const rubric = reviewerChunks.find((chunk) => chunk.chunkId === 'reviewer-rubric')
    expect(rubric?.content).toContain('本章风格决策（验收对照）')
    expect(rubric?.content).toContain('高压章')

    const reviserChunks = builder.buildChapterContextSuffixChunks(
      projectId, 1, task, constraints, undefined, 'reviser',
    )
    expect(reviserChunks).toHaveLength(1)
    expect(reviserChunks[0]!.chunkId).toBe('reviser-guidance')
    expect(reviserChunks[0]!.content).toContain('本章风格决策（修订对照）')
    expect(reviserChunks[0]!.content).toContain('不要为了贴近档案把它们修平')
  })

  it('身份段编译不受聚焦改动影响：全部启用专家仍以简版存在', () => {
    seedTeam()
    const profile = store.getWritingStyleProfile(projectId)!
    const compiled = compileWritingStylePrompt(profile, 'writer')
    // 身份段包含全部 3 个维度专家（简版），不只聚焦段那两个
    expect(compiled.content).toContain('dialogue_craft卡')
    expect(compiled.content).toContain('scene_craft卡')
  })
})
