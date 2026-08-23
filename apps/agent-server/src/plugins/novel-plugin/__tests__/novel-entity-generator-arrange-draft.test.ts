import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelEntityGenerator, type GeneratedConflict, type GeneratedEntity } from '../core/generation/novel-entity-generator.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { NovelStore } from '../core/novel-store.js'
import { createChapterProjectionRecorder } from '../core/chapters/chapter-projection-recorder.js'
import { novelMigrations } from '../novel-migrations.js'

/**
 * 覆盖 AI 编排"生成 → 用户确认/拒绝"闭环的补偿语义（arrange_review）：
 *
 * 1. 生成阶段照常提交（数据在决策前就存在），但撤销动作已登记；
 * 2. rollback() 反向撤销本轮全部矩阵写入：新建实体删除、复用实体的
 *    chapterSpans 恢复、编排投影 story event 删除；
 * 3. rollback 幂等，commit 为 no-op；
 * 4. 账本是追加式事件流：观察者在编排期间写入的 `<类型>.arranged`
 *    变化记录按设计保留（"移除"是更正而非事件），矩阵读实体字段不受影响。
 */

interface Harness {
  db: Database.Database
  store: NovelStore
  memoryStore: NovelMemoryStore
  projectId: string
  generator: NovelEntityGenerator
}

function createHarness(): Harness {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)

  const store = new NovelStore(db)
  const memoryStore = new NovelMemoryStore(db)
  store.setChapterProjectionObserver(createChapterProjectionRecorder(memoryStore))
  const projectId = randomUUID()
  store.createProject({
    id: projectId,
    title: 'Arrange draft test',
    genre: 'test',
    synopsis: '',
    outline: '',
    targetWords: 0,
    currentVolume: 1,
    currentChapter: 0,
    currentStage: 'setup',
    status: 'active',
  })
  for (let n = 1; n <= 20; n += 1) {
    store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: n,
      title: `第${n}章`, content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
      tension: null, positioning: null, timeOffset: null,
      chapterEndingHook: null, recap: null,
    })
  }

  const generator = new NovelEntityGenerator(
    {} as never,
    {} as never,
    // undo 里删除编排投影事件走 context.db（与生产 PluginContext 一致），测试桩需带上。
    { db, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
    {} as never,
    store,
    memoryStore,
  )
  return { db, store, memoryStore, projectId, generator }
}

const EMPTY_PLAN = { characters: [], conflicts: [], foreshadows: [], factions: [], locations: [], items: [] }

/** 复用冲突的完整生成结果（GeneratedConflict 全字段） */
function newConflictData(description: string): GeneratedConflict {
  return {
    description,
    type: 'interest',
    intensity: 6,
    stage: 'emerging',
    tier: 'secondary',
    participants: '[]',
    climaxChapter: null,
    climaxType: null,
    stakes: '妹妹的下落',
    twistPotential: 5,
    plotFunction: 'amplify_conflict',
    progressionMode: 'linear',
  }
}

/** 预置一个第 1-10 章已出场的势力，供"复用 + 回滚恢复"断言使用 */
function seedFaction(h: Harness): string {
  const factionId = randomUUID()
  h.store.createFaction({
    id: factionId,
    projectId: h.projectId,
    name: '国安总局',
    description: '蓝星侧主导机构',
    type: 'organization',
    leaderId: null,
    ideology: '秩序优先',
    strength: 'strong',
    resources: [],
    allies: [],
    enemies: [],
    status: 'active',
    chapterSpans: [[1, 10]],
  })
  return factionId
}

async function buildDraft(h: Harness, factionId: string, newConflictDescription: string) {
  const conflictSpec = { coreStyle: newConflictDescription }
  const factionSpec = { coreStyle: '已有：国安总局' }
  const plan = {
    ...EMPTY_PLAN,
    conflicts: [conflictSpec],
    factions: [factionSpec],
  }
  const generated = new Map<object, GeneratedEntity>([
    [conflictSpec, { type: 'conflict', data: newConflictData(newConflictDescription) }],
  ])
  ;(h.generator as any).planEntitiesFromOutline = async () => ({
    plan,
    logContext: { systemPrompt: '', userMessage: '', rawResult: '', status: 'success', error: '' },
  })
  ;(h.generator as any).generatePlanInBatches = async () => ({
    generated,
    itemCount: 1,
    batchCount: 1,
    retryCount: 0,
    fallbackCount: 0,
    unbatchedGenerationCount: 0,
  })
  return h.generator.generateArrangeDraft(h.projectId, 11, '章纲')
}

describe('AI 编排待确认草稿（arrange_review 补偿回滚）', () => {
  it('生成即提交：决策前新建实体与复用出场已可见，编排投影事件已写账本', async () => {
    const h = createHarness()
    try {
      const factionId = seedFaction(h)
      const draft = await buildDraft(h, factionId, '主角必须在三日内凑齐赎金否则妹妹被转移')

      expect(draft.result.conflictIds).toHaveLength(1)
      expect(h.store.getConflict(draft.result.conflictIds[0])).toBeDefined()
      // 2026-08-12 语义统一：复用实体出场写 appearance 表（chapterSpans 为冻结旧列）
      expect(h.store.listChapterAppearanceIds({
        projectId: h.projectId, chapterNumber: 11, entityType: 'faction',
      })).toEqual([factionId])
      expect(h.store.listChapterAppearanceIds({
        projectId: h.projectId, chapterNumber: 11, entityType: 'conflict',
      })).toEqual(draft.result.conflictIds)
      const arrangeEvent = h.memoryStore
        .listStoryEvents(h.projectId, { chapterNumber: 11 })
        .find((e) => e.title === '章纲编排实体投影')
      expect(arrangeEvent).toBeDefined()
      expect(
        h.memoryStore.listStoryEventEntityRefs(arrangeEvent!.id).map((r) => r.entityId),
      ).toEqual(expect.arrayContaining([factionId]))
    } finally {
      h.db.close()
    }
  })

  it('拒绝（rollback）：新建实体删除、复用出场撤销、编排投影事件删除，且幂等', async () => {
    const h = createHarness()
    try {
      const factionId = seedFaction(h)
      const draft = await buildDraft(h, factionId, '主角必须在三日内凑齐赎金否则妹妹被转移')
      const newConflictId = draft.result.conflictIds[0]

      draft.rollback()
      // 幂等：重复调用不抛错
      draft.rollback()

      expect(h.store.getConflict(newConflictId)).toBeUndefined()
      expect(h.store.listChapterAppearanceIds({
        projectId: h.projectId, chapterNumber: 11, entityType: 'conflict',
      })).toEqual([])
      expect(h.store.getFaction(factionId)!.chapterSpans).toEqual([[1, 10]])
      expect(h.store.listChapterAppearanceIds({
        projectId: h.projectId, chapterNumber: 11, entityType: 'faction',
      })).toEqual([])
      const arrangeEvent = h.memoryStore
        .listStoryEvents(h.projectId, { chapterNumber: 11 })
        .find((e) => e.title === '章纲编排实体投影')
      expect(arrangeEvent).toBeUndefined()
    } finally {
      h.db.close()
    }
  })

  it('确认（commit）：no-op，生成阶段已提交的数据保持原样', async () => {
    const h = createHarness()
    try {
      const factionId = seedFaction(h)
      const draft = await buildDraft(h, factionId, '主角必须在三日内凑齐赎金否则妹妹被转移')
      const newConflictId = draft.result.conflictIds[0]

      draft.commit()

      expect(h.store.getConflict(newConflictId)).toBeDefined()
      expect(h.store.listChapterAppearanceIds({
        projectId: h.projectId, chapterNumber: 11, entityType: 'faction',
      })).toEqual([factionId])
      expect(
        h.memoryStore.listStoryEvents(h.projectId, { chapterNumber: 11 })
          .find((e) => e.title === '章纲编排实体投影'),
      ).toBeDefined()
    } finally {
      h.db.close()
    }
  })
})
