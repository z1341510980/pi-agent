import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

/**
 * 覆盖两组历史缺陷：
 *
 * 1. 文风指纹（formatStyleFingerprint）
 *    - 引号字符类被编码转换吃成 ASCII "，中文正文的 “…” 一个都匹配不到 → 对话占比恒 0%
 *    - 情感温度用绝对词频差，样本一长必然被 clamp 到 0
 *    - 指标失真时仍带 ⚠️ 强制一致，把 Writer 锁死在"零对话、零情感"的错误基准上
 *
 * 2. 角色短卡（compactCharacterDetail）
 *    - 只取命中的前 2 个键：personality 只剩「核心+优点」，缺点全丢；
 *      speechStyle 只剩「基调+特点」，"典型句式示例"全丢。
 *      这两块恰好是让角色不趋同的部分。
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
  return db
}

function createStoresMock(store: NovelStore) {
  return {
    getProject: (id: string) => store.getProject(id),
    listWorldRules: (id: string) => store.listWorldRules(id),
    listStyleGuide: (id: string) => store.listStyleGuide(id),
    listCharacters: (id: string) => store.listCharacters(id),
    listRelationships: (id: string) => store.listRelationships(id),
    listConflicts: (id: string) => store.listConflicts(id),
    listForeshadowing: (id: string) => store.listForeshadowing(id),
    listClues: (id: string) => store.listClues(id),
    listInformationLayers: (id: string) => store.listInformationLayers(id),
    listConstraints: (id: string) => store.listConstraints(id),
    listRecentChapters: (id: string, n: number) => store.listRecentChapters(id, n),
    getChapter: (pid: string, n: number) => store.getChapter(pid, n),
    listEdges: (id: string) => store.listEdges(id),
    listEdgesByEntity: (id: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }) => store.listEdgesByEntity(id, opts),
    listFactions: (id: string) => store.listFactions(id),
    listLocations: (id: string) => store.listLocations(id),
    listItems: (id: string) => store.listItems(id),
    listWorldElements: (id: string) => store.listWorldElements(id),
    listUnfulfilledHooksBefore: (id: string, before: number) => store.listUnfulfilledHooksBefore(id, before),
    listHooksByChapter: (id: string, chapter: number) => store.listHooksByChapter(id, chapter),
    getCharacter: (id: string) => store.getCharacter(id),
    getConflict: (id: string) => store.getConflict(id),
    getForeshadow: (id: string) => store.getForeshadow(id),
    getClue: (id: string) => store.getClue(id),
    getFaction: (id: string) => store.getFaction(id),
    getLocation: (id: string) => store.getLocation(id),
    getInformationLayer: (id: string) => store.getInformationLayer(id),
  }
}

const EMPTY_CONSTRAINTS = {
  facts: [], cognitive: [], stage: [], narrativeDebts: [],
  characterArcs: [], conflictTargets: [], suspenseHooks: [],
}
const TASK = { description: '任务', type: 'advance_mainline' as const, targetEntity: null, priority: 'medium' as const }

function buildBuilder(store: NovelStore): NovelPromptBuilder {
  const promptManager = { render: () => 'instruction', getTemplate: () => '' } as any
  return new NovelPromptBuilder(promptManager, createStoresMock(store) as any)
}

describe('文风指纹指标可信度', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string

  /** 生成一段"有对话、有冷静词"的中文正文，弯引号用 U+201C/U+201D */
  function chapterText(seed: number): string {
    const paragraphs: string[] = []
    for (let i = 0; i < 18; i += 1) {
      paragraphs.push(`\u201c第${seed}章第${i}句对话，说得很清楚。\u201d`)
      paragraphs.push(`他把灯放回桌上，动作很稳，没有多余的话。这一段是叙述，用来撑起段落平均长度和总字数，避免样本量不足触发降级。`)
    }
    return paragraphs.join('\n\n')
  }

  beforeEach(() => {
    db = createTestDb()
    store = new NovelStore(db)
    projectId = randomUUID()
    store.createProject({
      id: projectId, title: 't', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 3,
      currentStage: 'setup', status: 'active',
    })
    for (let n = 1; n <= 4; n += 1) {
      store.createChapter({
        id: randomUUID(), projectId, volume: 1, chapterNumber: n,
        title: '', content: n < 4 ? chapterText(n) : '', wordCount: 0,
        status: n < 4 ? 'review' : 'planned',
        narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
      })
    }
  })

  it('中文弯引号能被识别为对话，对话占比不再恒为 0%', () => {
    const ctx = buildBuilder(store).buildChapterContextShared(projectId, 4, TASK, EMPTY_CONSTRAINTS)
    expect(ctx).toContain('## 文风指纹')
    const match = ctx.match(/- 对话占比：(\d+)%/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThan(0)
  })

  it('情感温度按每千字归一，长样本不会被压成 0', () => {
    const ctx = buildBuilder(store).buildChapterContextShared(projectId, 4, TASK, EMPTY_CONSTRAINTS)
    const match = ctx.match(/- 情感温度：(\d+)\/10/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThan(0)
  })

  it('指标可信时才升级为 ⚠️ 硬约束', () => {
    const ctx = buildBuilder(store).buildChapterContextShared(projectId, 4, TASK, EMPTY_CONSTRAINTS)
    expect(ctx).toContain('⚠️ 本章文风必须与此指纹保持一致')
  })

  it('样本无对话时指纹降级为参考值，不再强制一致', () => {
    // 纯叙述、零对话：旧实现会输出"对话占比 0%"并要求保持一致，
    // 等价于命令 Writer 整章不写对话。
    const noDialogue = Array.from({ length: 30 }, () =>
      '他沿着走廊往前走，脚步声压得很低，谁也没有开口，四周只有风穿过窗缝的声音。',
    ).join('\n\n')
    for (let n = 1; n <= 3; n += 1) {
      const chapter = store.getChapter(projectId, n)!
      store.updateChapter(chapter.id, { content: noDialogue })
    }
    const ctx = buildBuilder(store).buildChapterContextShared(projectId, 4, TASK, EMPTY_CONSTRAINTS)
    expect(ctx).toContain('- 对话占比：0%')
    expect(ctx).not.toContain('⚠️ 本章文风必须与此指纹保持一致')
    expect(ctx).toContain('仅作参考')
  })
})

describe('角色短卡保留区分度字段', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string
  let charId: string

  const PERSONALITY = JSON.stringify({
    核心: '温和的理性主义者',
    优点: ['思维极度清晰', '情绪稳定', '极强的韧性'],
    缺点: ['过度分析导致错失时机', '缺乏热血难以让人追随', '固执'],
    '座右铭（内心独白）': '一切异常都是可复现的 bug。',
  })
  const SPEECH_STYLE = JSON.stringify({
    基调: '平静、有条理、偶尔冷幽默',
    特点: ['节奏偏慢', '用词精确', '不擅寒暄'],
    典型句式示例: ['让我拆解一下这个问题。', '这个方案的时间复杂度太高了。'],
  })

  beforeEach(() => {
    db = createTestDb()
    store = new NovelStore(db)
    projectId = randomUUID()
    store.createProject({
      id: projectId, title: 't', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 0,
      currentStage: 'setup', status: 'active',
    })
    charId = randomUUID()
    store.createCharacter({
      id: charId, projectId, name: '叶明远', description: '程序员穿越者',
      identity: '外门弟子', personality: PERSONALITY, appearance: '',
      currentState: '带着未解的异象赴考', currentGoal: '通过考核', currentPressure: '风险陡增',
      secret: '', arcStage: 'rising', arcHistory: '[]', speechStyle: SPEECH_STYLE,
      isProtagonist: true,
      longTermDesire: '把整个修真体系拆解成可复现的工程问题',
      plotRole: 'protagonist' as const, removalImpact: '',
    })
    store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    })
  })

  function shortCard(): string {
    return buildBuilder(store).buildChapterContextShared(
      projectId, 1, TASK, EMPTY_CONSTRAINTS,
      { characterIds: [charId], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
    )
  }

  it('性格保留缺点（旧实现只取核心+优点，缺点全丢）', () => {
    const ctx = shortCard()
    expect(ctx).toContain('温和的理性主义者')
    expect(ctx).toContain('缺点')
    expect(ctx).toContain('过度分析导致错失时机')
  })

  it('语言风格保留典型句式示例（最能区分口吻的部分）', () => {
    const ctx = shortCard()
    expect(ctx).toContain('典型句式示例')
    expect(ctx).toContain('让我拆解一下这个问题。')
  })

  it('注入 longTermDesire 作为跨章人格发动机', () => {
    expect(shortCard()).toContain('一直想要：把整个修真体系拆解成可复现的工程问题')
  })

  it('占位文本不进 prompt', () => {
    store.updateCharacter(charId, { currentGoal: '待补充（占位）', longTermDesire: '长期欲望待补充' })
    const ctx = shortCard()
    expect(ctx).not.toContain('待补充')
    expect(ctx).not.toContain('占位')
  })
})
