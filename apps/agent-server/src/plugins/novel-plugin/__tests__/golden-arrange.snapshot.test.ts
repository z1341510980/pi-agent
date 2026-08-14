/**
 * Golden arrange 快照：`generateAndArrange` 的落库结果护栏。
 *
 * 编排一次会动 7 类实体的章节维度字段 + 角色历史 + 事件账本，
 * 逻辑现在是 6 份复制粘贴的循环（角色/冲突/伏笔/势力/地点/物品）。
 * 抽 EntityArrangeStrategy 时，这些快照必须字节级不变 ——
 * 这是判断"结构重构没有改变行为"的唯一可靠依据。
 *
 * 场景覆盖：
 *   1. 全复用（已有实体被编排进新章节）
 *   2. 全新建
 *   3. 混合（一半复用一半新建）
 *   4. 正文反推（source='content'，账本语义与章纲编排不同）
 */
import { describe, it, expect } from 'vitest'
import { NovelEntityGenerator, type GeneratedEntity } from '../core/generation/novel-entity-generator.js'
import { createChapterProjectionRecorder } from '../core/chapters/chapter-projection-recorder.js'
import {
  createNovelFixture,
  FIXTURE_IDS,
  FIXTURE_TARGET_CHAPTER,
  type NovelFixture,
} from './fixtures/novel-fixture.js'
import { dumpNovelState, normalizeForSnapshot } from './fixtures/state-dump.js'

type Plan = {
  characters: Array<{ coreStyle: string; plotFunction?: string; functionNote?: string }>
  conflicts: Array<{ coreStyle: string }>
  foreshadows: Array<{ coreStyle: string; chapterAction?: unknown }>
  factions: Array<{ coreStyle: string }>
  locations: Array<{ coreStyle: string }>
  items: Array<{ coreStyle: string }>
}

function makeGenerator(fx: NovelFixture, plan: Plan, generated: Map<object, GeneratedEntity>): NovelEntityGenerator {
  // 与生产装配一致：复用实体的 `<类型>.arranged` 由 NovelStore 的章节投影观察者写入。
  // 快照必须覆盖真实装配下的账本内容，否则测不到 S4-1a 的收口点。
  fx.store.setChapterProjectionObserver(createChapterProjectionRecorder(fx.memoryStore))
  const generator = new NovelEntityGenerator(
    {} as never,
    {} as never,
    { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
    {} as never,
    fx.store,
    fx.memoryStore,
  )
  ;(generator as never as Record<string, unknown>).planEntitiesFromOutline = async () => ({
    plan,
    logContext: { systemPrompt: '', userMessage: '', rawResult: '', status: 'success', error: '' },
  })
  ;(generator as never as Record<string, unknown>).generatePlanInBatches = async () => ({
    generated,
    itemCount: generated.size,
    batchCount: 1,
    retryCount: 0,
    fallbackCount: 0,
    unbatchedGenerationCount: 0,
  })
  return generator
}

function dump(fx: NovelFixture): string {
  return dumpNovelState(fx.store, fx.memoryStore, fx.projectId, {
    fixtureIds: { ...FIXTURE_IDS },
    ledgerChapters: [3, FIXTURE_TARGET_CHAPTER],
  })
}

/** 新建实体的生成结果（固定值，保证快照稳定） */
function newEntities(plan: Plan): Map<object, GeneratedEntity> {
  const map = new Map<object, GeneratedEntity>()
  if (plan.characters[0]) {
    map.set(plan.characters[0], {
      type: 'character',
      data: {
        name: '周执',
        description: '外门考核的监考执事。',
        identity: '青云宗外门执事',
        personality: '{"核心":"按章办事","缺点":["刻板"]}',
        appearance: '灰袍',
        currentState: '正在核对考核名册。',
        currentGoal: '按流程完成本次考核。',
        currentPressure: '名额有限而报名超额。',
        secret: '',
        arcStage: 'setup',
        speechStyle: '{"基调":"公事公办"}',
        longTermDesire: '把执事做到退休。',
        plotRole: 'function',
        removalImpact: '考核流程失去执行者。',
      } as never,
    })
  }
  if (plan.conflicts[0]) {
    map.set(plan.conflicts[0], {
      type: 'conflict',
      data: {
        description: '考核名额与主角的隐秘身份之间形成新的暴露风险。',
        type: 'survival',
        intensity: 5,
        stage: 'emerging',
        participants: '[]',
        tier: 'secondary',
        climaxChapter: null,
        climaxType: null,
        stakes: '身份暴露即失去庇护。',
        twistPotential: 4,
        plotFunction: 'create_obstacle',
        progressionMode: 'linear',
      } as never,
    })
  }
  if (plan.foreshadows[0]) {
    map.set(plan.foreshadows[0], {
      type: 'foreshadow',
      data: {
        description: '考核名册上有一栏被人事后涂改过。',
        category: 'item',
        status: 'planted',
        plantMethod: 'implicit',
        recoverMethod: 'explicit',
      } as never,
    })
  }
  if (plan.factions[0]) {
    map.set(plan.factions[0], {
      type: 'faction',
      data: {
        name: '青云宗外门',
        description: '主角所属的宗门外门体系。',
        type: 'sect',
        ideology: '按资源分配机会。',
        strength: 'medium',
        resources: ['考核名额'],
        allies: [],
        enemies: [],
        status: 'active',
      } as never,
    })
  }
  if (plan.locations[0]) {
    map.set(plan.locations[0], {
      type: 'location',
      data: {
        name: '外门考核场',
        description: '露天石台，四周设有阵旗。',
        type: 'building',
        significance: 'moderate',
        status: 'normal',
      } as never,
    })
  }
  if (plan.items[0]) {
    map.set(plan.items[0], {
      type: 'item',
      data: {
        name: '考核名册',
        description: '记录报名者与名额分配的册子。',
        type: 'info',
        ownerId: null,
        status: 'active',
        abilities: '记录考核结果。',
        origin: '外门执事处。',
      } as never,
    })
  }
  return map
}

describe('Golden arrange 快照', () => {
  it('场景 1：全部复用已有实体（章纲编排）', async () => {
    const fx = createNovelFixture()
    try {
      const plan: Plan = {
        characters: [
          { coreStyle: '已有：叶明远', plotFunction: 'change_judgment', functionNote: '把失控读成结构' },
          { coreStyle: '已有：沈维章', plotFunction: 'reveal_world_rule', functionNote: '宣布旧模型错了' },
        ],
        conflicts: [{ coreStyle: '已有：蓝星科学分析发现修炼功法的七处关键节点在蓝星人体解剖上不存在' }],
        foreshadows: [{
          coreStyle: '已有：主角体内第七处深层节点在最低刺激下自行牵动前六点，形成完整图形',
          chapterAction: 'reinforce',
        }],
        factions: [{ coreStyle: '已有：国安总局' }],
        locations: [{ coreStyle: '已有：潼关杂役坑' }],
        items: [{ coreStyle: '已有：鱼环形玉佩' }],
      }
      const generator = makeGenerator(fx, plan, new Map())
      const arranged = await generator.generateAndArrange(
        fx.projectId, FIXTURE_TARGET_CHAPTER, '章纲', undefined, 'outline',
      )
      expect(normalizeForSnapshot(arranged, { ...FIXTURE_IDS })).toMatchSnapshot('arranged-result')
      expect(dump(fx)).toMatchSnapshot('db-state')
    } finally {
      fx.close()
    }
  })

  it('场景 2：全部新建（章纲编排）', async () => {
    const fx = createNovelFixture()
    try {
      const plan: Plan = {
        characters: [{ coreStyle: '外门执事', plotFunction: 'create_obstacle', functionNote: '按流程施压' }],
        conflicts: [{ coreStyle: '考核暴露风险' }],
        foreshadows: [{
          coreStyle: '被涂改的名册',
          importance: 'major',
          narrativeRole: 'dark_line',
          hiddenQuestion: '谁改了名册',
          plannedPayoff: '揭示交易链条时回收',
        } as never],
        factions: [{ coreStyle: '青云宗外门' }],
        locations: [{ coreStyle: '外门考核场' }],
        items: [{ coreStyle: '考核名册' }],
      }
      const generator = makeGenerator(fx, plan, newEntities(plan))
      const arranged = await generator.generateAndArrange(
        fx.projectId, FIXTURE_TARGET_CHAPTER, '章纲', undefined, 'outline',
      )
      expect(normalizeForSnapshot(arranged, { ...FIXTURE_IDS })).toMatchSnapshot('arranged-result')
      expect(dump(fx)).toMatchSnapshot('db-state')
    } finally {
      fx.close()
    }
  })

  it('场景 3：复用与新建混合（章纲编排）', async () => {
    const fx = createNovelFixture()
    try {
      const plan: Plan = {
        characters: [
          { coreStyle: '已有：叶明远', plotFunction: 'change_judgment' },
          { coreStyle: '外门执事', plotFunction: 'create_obstacle' },
        ],
        conflicts: [{ coreStyle: '已有：主角必须在异常失控风险与放弃外门考核所带来的现实后果之间做出选择' }],
        foreshadows: [{
          coreStyle: '已有：旧藏残卷中的七枢内照图与主角体内节点结构高度一致',
          chapterAction: 'reveal',
        }],
        factions: [{ coreStyle: '青云宗外门' }],
        locations: [{ coreStyle: '已有：潼关杂役坑' }],
        items: [{ coreStyle: '考核名册' }],
      }
      const generated = newEntities({ ...plan, characters: [plan.characters[1]] })
      const generator = makeGenerator(fx, plan, generated)
      const arranged = await generator.generateAndArrange(
        fx.projectId, FIXTURE_TARGET_CHAPTER, '章纲', undefined, 'outline',
      )
      expect(normalizeForSnapshot(arranged, { ...FIXTURE_IDS })).toMatchSnapshot('arranged-result')
      expect(dump(fx)).toMatchSnapshot('db-state')
    } finally {
      fx.close()
    }
  })

  it('场景 4：正文反推（source=content，账本语义不同）', async () => {
    const fx = createNovelFixture()
    try {
      fx.store.updateChapter('fx-chapter-4', { content: '第四章正文。'.repeat(60) })
      const plan: Plan = {
        characters: [{ coreStyle: '已有：叶明远' }],
        conflicts: [{ coreStyle: '考核暴露风险' }],
        foreshadows: [],
        factions: [{ coreStyle: '已有：国安总局' }],
        locations: [{ coreStyle: '外门考核场' }],
        items: [],
      }
      const generator = makeGenerator(fx, plan, newEntities({ ...plan, characters: [] }))
      const arranged = await generator.generateAndArrange(
        fx.projectId, FIXTURE_TARGET_CHAPTER, '正文', undefined, 'content',
      )
      expect(normalizeForSnapshot(arranged, { ...FIXTURE_IDS })).toMatchSnapshot('arranged-result')
      expect(dump(fx)).toMatchSnapshot('db-state')
    } finally {
      fx.close()
    }
  })
})
