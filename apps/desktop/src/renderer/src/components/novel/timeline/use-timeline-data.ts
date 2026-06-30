/**
 * useTimelineData：将小说数据转换为自研时间轴所需的 Track[] 格式
 *
 * 数据模型：
 * - Track：一条轨道。每个已放置元素独立一条 track（拖入后自动新增一行）；
 *   类型无元素时展示一条空占位轨道（保持轨道结构完整）。
 * - Clip：轨道上的片段块，start/end 为章节号（1-based）
 *
 * 与旧版（@xzdarcy TimelineRow）的区别：
 * - 不再依赖第三方库类型
 * - Track 自带 header 信息（icon/label/visible/locked），供轨道头部控件使用
 * - Clip 自带 entityId/entityType/name，无需 lookup 反查
 */

import { useMemo } from 'react'
import type {
  NovelCharacter,
  NovelChapter,
  NovelConflict,
  NovelForeshadow,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
  NovelCharacterHistory,
  ConflictTier,
} from '@/api/novel-client'
import { groupContiguousSpans } from './timeline-logic'

// ── 自研数据类型 ──

/** 片段块（剪辑编辑器中的 clip） */
export interface TimelineClip {
  /** 唯一 ID（用于 React key） */
  id: string
  /** 起始章节号（1-based，包含） */
  startChapter: number
  /** 结束章节号（1-based，包含；等于 start 时为单章片段） */
  endChapter: number
  /** 视觉类型（用于 CSS 着色） */
  effectId: string
  /** 关联实体类型（点击时联动右侧详情面板） */
  entityType: 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location' | 'world_element'
  /** 关联实体 ID */
  entityId: string
  /** 显示名称（片段块内文字） */
  label: string
  /** 副标签（如"主角"/"主要"/"已回收"等小标签） */
  tag?: string
}

/** 轨道（剪辑编辑器中的 track） */
export interface TimelineTrack {
  /** 唯一 ID */
  id: string
  /** 轨道类型（用于头部图标） */
  kind: 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location' | 'world_element'
  /** 轨道头部显示名称 */
  label: string
  /** 轨道头部副标签（如"主要冲突"/"次要冲突"） */
  subLabel?: string
  /** 该轨道的片段列表 */
  clips: TimelineClip[]
}

export interface UseTimelineDataResult {
  tracks: TimelineTrack[]
  /** 未在轨道上出现的元素（元素池用） */
  poolCharacters: NovelCharacter[]
  poolConflicts: NovelConflict[]
  poolForeshadows: NovelForeshadow[]
  poolFactions: NovelFaction[]
  poolLocations: NovelLocation[]
}

export function useTimelineData(params: {
  characters: NovelCharacter[]
  chapters: NovelChapter[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  worldElements: NovelWorldElement[]
  characterHistory: NovelCharacterHistory[]
}): UseTimelineDataResult {
  const { characters, chapters, conflicts, foreshadows, factions, locations, worldElements, characterHistory } = params

  return useMemo(() => {
    const tracks: TimelineTrack[] = []
    const poolCharacters: NovelCharacter[] = []
    const poolConflicts: NovelConflict[] = []
    const poolForeshadows: NovelForeshadow[] = []
    const poolFactions: NovelFaction[] = []
    const poolLocations: NovelLocation[] = []
    const chapterCount = Math.max(chapters.length, 1)

    // ── 角色轨道（每个有历史的角色一条 track；按连续跨度分组生成 N 个 clip；末尾始终追加一条空占位供继续拖入）──
    for (const character of characters) {
      const history = characterHistory.filter((h) => h.characterId === character.id)
      if (history.length === 0) {
        poolCharacters.push(character)
        continue
      }
      const chapterNumbers = history
        .map((h) => h.chapterNumber)
        .filter((n): n is number => n != null)
      if (chapterNumbers.length === 0) {
        poolCharacters.push(character)
        continue
      }
      const isProtagonist = character.isProtagonist
      const effectId = isProtagonist ? 'character-protagonist' : 'character-secondary'
      const tag = isProtagonist ? '主角' : undefined
      // A1：按连续跨度分组——相邻章节归为同一段，断开处分新段，使剃刀切分后能渲染多个 clip
      const spans = groupContiguousSpans(chapterNumbers)
      const clips = spans.map((span, i) => ({
        id: `character-clip:${character.id}:${i}`,
        startChapter: span.start,
        endChapter: span.end,
        effectId,
        entityType: 'character' as const,
        entityId: character.id,
        label: character.name,
        tag,
      }))
      tracks.push({
        id: `character:${character.id}`,
        kind: 'character',
        label: character.name,
        subLabel: isProtagonist ? '主角' : '配角',
        clips,
      })
    }
    // 始终追加一条空占位轨道，供用户继续拖入新角色
    tracks.push({
      id: 'character-placeholder',
      kind: 'character',
      label: '角色',
      subLabel: '拖入元素池',
      clips: [],
    })

    // ── 冲突轨道（按 tier 分 3 组；每个已放置冲突独立一条 track；每个 tier 末尾始终追加空占位）──
    const tierConfig: Array<{ tier: ConflictTier; effectId: string; label: string; subLabel: string }> = [
      { tier: 'main', effectId: 'conflict-main', label: '主要冲突', subLabel: 'main' },
      { tier: 'secondary', effectId: 'conflict-secondary', label: '次要冲突', subLabel: 'secondary' },
      { tier: 'goal', effectId: 'conflict-goal', label: '主角目的', subLabel: 'goal' },
    ]
    for (const { tier, effectId, label, subLabel } of tierConfig) {
      const tierConflicts = conflicts.filter((c) => (c.tier ?? 'secondary') === tier)
      const placedConflicts: NovelConflict[] = []
      for (const c of tierConflicts) {
        if (c.firstChapter == null) {
          poolConflicts.push(c)
        } else {
          placedConflicts.push(c)
        }
      }
      // 每个已放置冲突独立一条 track
      for (const c of placedConflicts) {
        tracks.push({
          id: `conflict:${c.id}`,
          kind: 'conflict',
          label: c.description,
          subLabel,
          clips: [{
            id: `conflict-clip:${c.id}`,
            startChapter: c.firstChapter!,
            endChapter: c.lastChapter ?? c.firstChapter!,
            effectId,
            entityType: 'conflict' as const,
            entityId: c.id,
            label: c.description,
          }],
        })
      }
      // 每个 tier 末尾始终追加空占位，供继续拖入
      tracks.push({
        id: `conflict-tier-placeholder:${tier}`,
        kind: 'conflict',
        label,
        subLabel,
        clips: [],
      })
    }

    // ── 伏笔轨道（每个已放置伏笔独立一条 track；末尾始终追加空占位）──
    const placedForeshadows: NovelForeshadow[] = []
    for (const f of foreshadows) {
      if (f.firstChapter == null) {
        poolForeshadows.push(f)
      } else {
        placedForeshadows.push(f)
      }
    }
    for (const f of placedForeshadows) {
      tracks.push({
        id: `foreshadow:${f.id}`,
        kind: 'foreshadow',
        label: f.description,
        subLabel: f.recoverByChapter ? '已回收' : '待回收',
        clips: [{
          id: `foreshadow-clip:${f.id}`,
          startChapter: f.firstChapter!,
          endChapter: f.recoverByChapter ?? f.firstChapter!,
          effectId: f.recoverByChapter ? 'foreshadow-resolved' : 'foreshadow-pending',
          entityType: 'foreshadow' as const,
          entityId: f.id,
          label: f.description,
          tag: f.recoverByChapter ? '已回收' : '待回收',
        }],
      })
    }
    tracks.push({
      id: 'foreshadow-placeholder',
      kind: 'foreshadow',
      label: '伏笔',
      subLabel: '拖入元素池',
      clips: [],
    })

    // ── 势力轨道（每个已放置势力独立一条 track；末尾始终追加空占位）──
    const placedFactions: NovelFaction[] = []
    for (const f of factions) {
      if (f.firstChapter == null) {
        poolFactions.push(f)
      } else {
        placedFactions.push(f)
      }
    }
    for (const f of placedFactions) {
      tracks.push({
        id: `faction:${f.id}`,
        kind: 'faction',
        label: f.name,
        clips: [{
          id: `faction-clip:${f.id}`,
          startChapter: f.firstChapter!,
          endChapter: f.lastChapter ?? f.firstChapter!,
          effectId: 'faction',
          entityType: 'faction' as const,
          entityId: f.id,
          label: f.name,
        }],
      })
    }
    tracks.push({
      id: 'faction-placeholder',
      kind: 'faction',
      label: '势力',
      subLabel: '拖入元素池',
      clips: [],
    })

    // ── 地点轨道（每个已放置地点独立一条 track；末尾始终追加空占位）──
    const placedLocations: NovelLocation[] = []
    for (const l of locations) {
      if (!l.appearChapters || l.appearChapters.length === 0) {
        poolLocations.push(l)
      } else {
        placedLocations.push(l)
      }
    }
    for (const l of placedLocations) {
      const appearChapters = (l.appearChapters ?? []).slice().sort((a, b) => a - b)
      tracks.push({
        id: `location:${l.id}`,
        kind: 'location',
        label: l.name,
        clips: appearChapters.map((ch, i) => ({
          id: `location-clip:${l.id}:${i}`,
          startChapter: ch,
          endChapter: ch,
          effectId: 'location',
          entityType: 'location' as const,
          entityId: l.id,
          label: l.name,
        })),
      })
    }
    tracks.push({
      id: 'location-placeholder',
      kind: 'location',
      label: '地点',
      subLabel: '拖入元素池',
      clips: [],
    })

    // ── 世界要素轨道（每个世界要素独立一条 track；末尾始终追加空占位）──
    for (const w of worldElements) {
      tracks.push({
        id: `world-element:${w.id}`,
        kind: 'world_element',
        label: w.name,
        clips: [{
          id: `world-element-clip:${w.id}`,
          startChapter: 1,
          endChapter: chapterCount,
          effectId: 'world-element',
          entityType: 'world_element' as const,
          entityId: w.id,
          label: w.name,
        }],
      })
    }
    tracks.push({
      id: 'world-element-placeholder',
      kind: 'world_element',
      label: '世界要素',
      subLabel: '拖入元素池',
      clips: [],
    })

    return { tracks, poolCharacters, poolConflicts, poolForeshadows, poolFactions, poolLocations }
  }, [characters, chapters, conflicts, foreshadows, factions, locations, worldElements, characterHistory])
}
