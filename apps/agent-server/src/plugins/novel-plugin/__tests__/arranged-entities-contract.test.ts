/**
 * ArrangedEntity 契约往返测试。
 *
 * 覆盖「HTTP 请求体 → zod 校验 → 映射 → prompt 文本」整条链路，
 * 断言**每一个字段都真的到达了 Writer**。
 *
 * 这条测试存在的理由：`itemIds` 与 `characterFunctions` 曾经在类型里有、
 * prompt-builder 也实现了消费逻辑，但传输层 schema 漏了它们，于是两段
 * prompt 永远不渲染。当时的单测直接调 builder，绕过路由，所以全绿。
 *
 * 往 ArrangedEntity 加字段时，请在 §字段全覆盖 里补一条断言。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import {
  arrangedEntitiesSchema,
  creationFlowBodySchema,
  parseArrangedEntities,
  findForeignArrangedEntities,
} from '../routes/arranged-entities-contract.js'
import type { ArrangedEntity } from '../core/types.js'
import {
  createNovelFixture,
  createPromptStores,
  FIXTURE_IDS,
  FIXTURE_TARGET_CHAPTER,
  type NovelFixture,
} from './fixtures/novel-fixture.js'

describe('ArrangedEntity 传输层契约', () => {
  let fx: NovelFixture
  let builder: NovelPromptBuilder

  beforeAll(() => {
    fx = createNovelFixture()
    builder = new NovelPromptBuilder(
      new PromptManager(fx.db, process.cwd()),
      createPromptStores(fx.store) as never,
      fx.memoryStore,
    )
  })

  afterAll(() => fx.close())

  /** 模拟真实请求体（JSON，字段可缺省） */
  const rawBody = {
    arrangedEntities: {
      characterIds: [FIXTURE_IDS.protagonist, FIXTURE_IDS.scientist],
      conflictIds: [FIXTURE_IDS.conflictMain],
      foreshadowIds: [FIXTURE_IDS.foreshadowPlanted],
      clueIds: [FIXTURE_IDS.clue],
      factionIds: [FIXTURE_IDS.faction],
      locationIds: [FIXTURE_IDS.location],
      itemIds: [FIXTURE_IDS.item],
      narrativeIds: [],
      characterFunctions: [
        { characterId: FIXTURE_IDS.protagonist, function: 'change_judgment', note: '把失控读成结构' },
        { characterId: FIXTURE_IDS.scientist, function: 'reveal_world_rule' },
      ],
    },
  }

  function roundTrip(body: unknown): ArrangedEntity {
    const parsed = creationFlowBodySchema.parse(body)
    const arranged = parseArrangedEntities(parsed)
    expect(arranged).toBeDefined()
    return arranged!
  }

  function promptFor(arranged: ArrangedEntity): string {
    return builder.buildChapterContextShared(
      fx.projectId,
      FIXTURE_TARGET_CHAPTER,
      fx.narrativeTask,
      fx.constraints,
      arranged,
    )
  }

  // ── §字段全覆盖：每个字段都必须在 prompt 里留下痕迹 ──

  it('schema 键集与 ArrangedEntity 完全一致', () => {
    // 编译期已有断言（arranged-entities-contract.ts 的 _schemaCoversType），
    // 这里再加运行时检查，覆盖"类型改了但 schema 用 any 糊过去"的情况。
    const schemaKeys = Object.keys(arrangedEntitiesSchema.shape).sort()
    const typeKeys: Array<keyof ArrangedEntity> = [
      'characterIds', 'conflictIds', 'foreshadowIds', 'clueIds',
      'factionIds', 'locationIds', 'itemIds', 'narrativeIds', 'characterFunctions',
    ]
    expect(schemaKeys).toEqual([...typeKeys].sort())
  })

  it('请求体的所有字段都通过映射保留下来', () => {
    const arranged = roundTrip(rawBody)
    expect(arranged).toEqual(rawBody.arrangedEntities)
  })

  it('角色到达 prompt：角色短卡 + 本章作用', () => {
    const prompt = promptFor(roundTrip(rawBody))
    expect(prompt).toContain('### 角色短卡')
    expect(prompt).toContain('叶明远')
    expect(prompt).toContain('沈维章')
    // characterFunctions（本章功能位）——曾经因 schema 缺字段而永不渲染
    expect(prompt).toContain('本章作用：改变主角判断（把失控读成结构）')
    expect(prompt).toContain('本章作用：暴露世界规则')
  })

  it('物品到达 prompt：本章登场物品约束', () => {
    const prompt = promptFor(roundTrip(rawBody))
    // itemIds——同样曾经是死分支
    expect(prompt).toContain('本章登场物品')
    expect(prompt).toContain('鱼环形玉佩')
  })

  it('冲突 / 伏笔 / 线索 / 势力 / 地点都到达 prompt', () => {
    const prompt = promptFor(roundTrip(rawBody))
    expect(prompt).toContain('### 本章冲突')
    expect(prompt).toContain('### 本章伏笔')
    expect(prompt).toContain('本章线索')
    expect(prompt).toContain('### 登场势力')
    expect(prompt).toContain('国安总局')
    expect(prompt).toContain('### 场景地点')
    expect(prompt).toContain('潼关杂役坑')
  })

  // ── §缺省与容错 ──

  it('字段缺省时补空数组，不产生 undefined', () => {
    const arranged = roundTrip({ arrangedEntities: { characterIds: [FIXTURE_IDS.protagonist] } })
    expect(arranged).toEqual({
      characterIds: [FIXTURE_IDS.protagonist],
      conflictIds: [],
      foreshadowIds: [],
      clueIds: [],
      factionIds: [],
      locationIds: [],
      itemIds: [],
      narrativeIds: [],
      characterFunctions: [],
    })
  })

  it('整个 arrangedEntities 缺省时返回 undefined（走无编排分支）', () => {
    expect(parseArrangedEntities(creationFlowBodySchema.parse({}))).toBeUndefined()
    expect(parseArrangedEntities(creationFlowBodySchema.parse(undefined))).toBeUndefined()
  })

  it('未知功能位被 zod 拒绝', () => {
    expect(() => creationFlowBodySchema.parse({
      arrangedEntities: { characterFunctions: [{ characterId: 'x', function: 'not_a_function' }] },
    })).toThrow()
  })

  // ── §归属校验 ──

  it('本项目实体全部通过归属校验', () => {
    expect(findForeignArrangedEntities(fx.store, fx.projectId, roundTrip(rawBody))).toEqual([])
  })

  it('外部/不存在的实体被逐类识别（含 itemIds 与 characterFunctions）', () => {
    const invalid = findForeignArrangedEntities(fx.store, fx.projectId, {
      characterIds: ['ghost-char'],
      conflictIds: ['ghost-conflict'],
      foreshadowIds: ['ghost-foreshadow'],
      clueIds: ['ghost-clue'],
      factionIds: ['ghost-faction'],
      locationIds: ['ghost-location'],
      itemIds: ['ghost-item'],
      characterFunctions: [{ characterId: 'ghost-fn', function: 'open_phase' }],
    })
    expect(invalid).toEqual([
      'character:ghost-char',
      'conflict:ghost-conflict',
      'foreshadow:ghost-foreshadow',
      'clue:ghost-clue',
      'faction:ghost-faction',
      'location:ghost-location',
      'item:ghost-item',
      'characterFunction:ghost-fn',
    ])
  })

  it('可选字段缺省时归属校验不炸（兼容旧版矩阵快照）', () => {
    expect(findForeignArrangedEntities(fx.store, fx.projectId, {
      characterIds: [FIXTURE_IDS.protagonist],
      conflictIds: [],
      foreshadowIds: [],
      factionIds: [],
      locationIds: [],
    })).toEqual([])
  })
})
