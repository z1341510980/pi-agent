/**
 * 实体查询策略：消除 RelationshipGraph 中的 switch(entityType) 分发
 *
 * 每个策略封装一种实体类型的 3 项查询能力：
 * - getProjectId：根据实体 ID 反查所属项目
 * - getName：取展示用名称（描述类实体取前 40 字符）
 * - getChapters：聚合该实体在所有章节中的出现记录
 *
 * 不持久化派生数据，每次调用都基于 store 现状计算。
 * Clue 策略单独存在：NovelNodeType 暂未含 'clue'，但 NovelClue 是有效图节点。
 */
import type { NovelStore } from './novel-store.js'
import type { NovelNodeType } from '@repo/shared/novel'

/** 关系图查询用的实体类型（NovelNodeType 扩展 'clue'） */
export type GraphEntityType = NovelNodeType | 'clue'

/** 实体查询策略接口 */
export interface EntityStrategy {
  readonly type: GraphEntityType
  /** 查找实体所属项目 ID */
  getProjectId(entityId: string): string | null
  /** 获取实体显示名称 */
  getName(entityId: string): string | null
  /** 收集实体出现的所有章节号 */
  getChapters(projectId: string, entityId: string): number[]
}

/** 展开 [[1,3],[5,7]] 为 [1,2,3,5,6,7] */
function expandSpans(spans: Array<[number, number]>): number[] {
  const result: number[] = []
  for (const [start, end] of spans) {
    for (let i = start; i <= end; i++) result.push(i)
  }
  return result
}

export class CharacterStrategy implements EntityStrategy {
  readonly type = 'character' as const
  constructor(private readonly store: NovelStore) {}
  getProjectId(id: string): string | null {
    return this.store.getCharacter(id)?.projectId ?? null
  }
  getName(id: string): string | null {
    return this.store.getCharacter(id)?.name ?? null
  }
  getChapters(projectId: string, entityId: string): number[] {
    return this.store
      .listCharacterHistory(projectId, entityId)
      .map((h) => h.chapterNumber)
      .filter((n): n is number => n !== null)
  }
}

export class ConflictStrategy implements EntityStrategy {
  readonly type = 'conflict' as const
  constructor(private readonly store: NovelStore) {}
  getProjectId(id: string): string | null {
    return this.store.getConflict(id)?.projectId ?? null
  }
  getName(id: string): string | null {
    return this.store.getConflict(id)?.description.slice(0, 40) ?? null
  }
  getChapters(_projectId: string, entityId: string): number[] {
    const c = this.store.getConflict(entityId)
    return c ? expandSpans(c.chapterSpans) : []
  }
}

export class ForeshadowStrategy implements EntityStrategy {
  readonly type = 'foreshadow' as const
  constructor(private readonly store: NovelStore) {}
  getProjectId(id: string): string | null {
    return this.store.getForeshadow(id)?.projectId ?? null
  }
  getName(id: string): string | null {
    return this.store.getForeshadow(id)?.description.slice(0, 40) ?? null
  }
  getChapters(_projectId: string, entityId: string): number[] {
    const f = this.store.getForeshadow(entityId)
    if (!f) return []
    const beatChapters = (f.beats ?? []).map((b) => b.chapter)
    return [...beatChapters, ...expandSpans(f.chapterSpans)]
  }
}

export class FactionStrategy implements EntityStrategy {
  readonly type = 'faction' as const
  constructor(private readonly store: NovelStore) {}
  getProjectId(id: string): string | null {
    return this.store.getFaction(id)?.projectId ?? null
  }
  getName(id: string): string | null {
    return this.store.getFaction(id)?.name ?? null
  }
  getChapters(_projectId: string, entityId: string): number[] {
    const f = this.store.getFaction(entityId)
    return f ? expandSpans(f.chapterSpans) : []
  }
}

export class LocationStrategy implements EntityStrategy {
  readonly type = 'location' as const
  constructor(private readonly store: NovelStore) {}
  getProjectId(id: string): string | null {
    return this.store.getLocation(id)?.projectId ?? null
  }
  getName(id: string): string | null {
    return this.store.getLocation(id)?.name ?? null
  }
  getChapters(_projectId: string, entityId: string): number[] {
    return this.store.getLocation(entityId)?.appearChapters ?? []
  }
}

export class WorldElementStrategy implements EntityStrategy {
  readonly type = 'world_element' as const
  constructor(private readonly store: NovelStore) {}
  getProjectId(id: string): string | null {
    return this.store.getWorldElement(id)?.projectId ?? null
  }
  getName(id: string): string | null {
    return this.store.getWorldElement(id)?.name ?? null
  }
  getChapters(): number[] {
    // world_element 无章节跨度数据
    return []
  }
}

export class ClueStrategy implements EntityStrategy {
  readonly type = 'clue' as const
  constructor(private readonly store: NovelStore) {}
  getProjectId(id: string): string | null {
    return this.store.getClue(id)?.projectId ?? null
  }
  getName(id: string): string | null {
    return this.store.getClue(id)?.description.slice(0, 40) ?? null
  }
  getChapters(_projectId: string, entityId: string): number[] {
    const clue = this.store.getClue(entityId)
    return clue ? expandSpans(clue.chapterSpans) : []
  }
}

/** 策略表：按 GraphEntityType 索引 */
export type EntityStrategyMap = ReadonlyMap<GraphEntityType, EntityStrategy>

/** 创建策略表，注入 store 实例 */
export function createEntityStrategies(store: NovelStore): EntityStrategyMap {
  return new Map<GraphEntityType, EntityStrategy>([
    ['character', new CharacterStrategy(store)],
    ['conflict', new ConflictStrategy(store)],
    ['foreshadow', new ForeshadowStrategy(store)],
    ['faction', new FactionStrategy(store)],
    ['location', new LocationStrategy(store)],
    ['world_element', new WorldElementStrategy(store)],
    ['clue', new ClueStrategy(store)],
  ])
}
