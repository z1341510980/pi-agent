/**
 * TimelineRelationLayer：关系连线层
 *
 * SVG 叠加层，绘制三类关系连线：
 * 1. 角色-角色（基于 relationships 数据，颜色按关系类型）
 * 2. 势力-势力（基于 faction.allies / enemies，同盟绿/敌对黑）
 * 3. 角色-势力（基于 faction.leaderId，领袖金色连线）
 *
 * 双向关系会去重，仅当两个片段在章节上有重叠时才画线。
 */

import { type ReactElement } from 'react'
import type { NovelRelationship, NovelFaction } from '@/api/novel-client'
import type { TimelineTrack } from './use-timeline-data'

const RELATION_COLOR: Record<string, string> = {
  family: 'rgba(239, 68, 68, 0.7)',
  friendship: 'rgba(59, 130, 246, 0.7)',
  romance: 'rgba(236, 72, 153, 0.7)',
  rivalry: 'rgba(30, 41, 59, 0.7)',
  mentor: 'rgba(168, 85, 247, 0.7)',
  ally: 'rgba(16, 185, 129, 0.7)',
  leader: 'rgba(217, 119, 6, 0.85)',
}

const RELATION_LABEL: Record<string, string> = {
  family: '亲情',
  friendship: '友情',
  romance: '爱情',
  rivalry: '敌对',
  mentor: '师徒',
  ally: '盟友',
  leader: '领袖',
}

export interface TimelineRelationLayerProps {
  tracks: TimelineTrack[]
  relationships: NovelRelationship[]
  factions: NovelFaction[]
  chapterWidth: number
  trackHeight: number
  maxChapter: number
}

interface LineSegment {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  label: string
  relationType: string
}

interface ClipRange {
  start: number
  end: number
  midX: number
  midY: number
}

export function TimelineRelationLayer({
  tracks,
  relationships,
  factions,
  chapterWidth,
  trackHeight,
}: TimelineRelationLayerProps): ReactElement {
  // 构建 entityId → trackClipRange 映射（character 和 faction 都纳入）
  const trackClipRangeMap = new Map<string, ClipRange>()
  tracks.forEach((track, idx) => {
    if ((track.kind === 'character' || track.kind === 'faction') && track.clips.length > 0) {
      const clip = track.clips[0]
      const midCh = (clip.startChapter + clip.endChapter) / 2
      trackClipRangeMap.set(clip.entityId, {
        start: clip.startChapter,
        end: clip.endChapter,
        midX: (midCh - 0.5) * chapterWidth,
        midY: idx * trackHeight + trackHeight / 2,
      })
    }
  })

  // 构建连线
  const lines: LineSegment[] = []

  // 1. 角色-角色关系连线
  for (const rel of relationships) {
    const a = trackClipRangeMap.get(rel.characterA)
    const b = trackClipRangeMap.get(rel.characterB)
    if (!a || !b) continue
    if (a.end < b.start || b.end < a.start) continue
    const relationType = rel.relationType ?? 'ally'
    const color = RELATION_COLOR[relationType] ?? 'rgba(100, 100, 100, 0.5)'
    const label = RELATION_LABEL[relationType] ?? relationType
    lines.push({
      id: rel.id,
      x1: a.midX, y1: a.midY, x2: b.midX, y2: b.midY,
      color, label, relationType,
    })
  }

  // 2. 势力-势力关系连线（allies/enemies，双向去重）
  const factionPairSeen = new Set<string>()
  for (const f of factions) {
    const fRange = trackClipRangeMap.get(f.id)
    if (!fRange) continue

    // allies → 同盟
    for (const allyId of f.allies ?? []) {
      const allyRange = trackClipRangeMap.get(allyId)
      if (!allyRange) continue
      const key = `${[f.id, allyId].sort().join('|')}|ally`
      if (factionPairSeen.has(key)) continue
      factionPairSeen.add(key)
      if (fRange.end < allyRange.start || allyRange.end < fRange.start) continue
      lines.push({
        id: `faction-ally-${key}`,
        x1: fRange.midX, y1: fRange.midY, x2: allyRange.midX, y2: allyRange.midY,
        color: RELATION_COLOR.ally, label: '同盟', relationType: 'ally',
      })
    }

    // enemies → 敌对
    for (const enemyId of f.enemies ?? []) {
      const enemyRange = trackClipRangeMap.get(enemyId)
      if (!enemyRange) continue
      const key = `${[f.id, enemyId].sort().join('|')}|enemy`
      if (factionPairSeen.has(key)) continue
      factionPairSeen.add(key)
      if (fRange.end < enemyRange.start || enemyRange.end < fRange.start) continue
      lines.push({
        id: `faction-enemy-${key}`,
        x1: fRange.midX, y1: fRange.midY, x2: enemyRange.midX, y2: enemyRange.midY,
        color: RELATION_COLOR.rivalry, label: '敌对', relationType: 'rivalry',
      })
    }
  }

  // 3. 角色-势力 领袖连线（faction.leaderId 指向 character）
  for (const f of factions) {
    if (!f.leaderId) continue
    const fRange = trackClipRangeMap.get(f.id)
    if (!fRange) continue
    const leaderRange = trackClipRangeMap.get(f.leaderId)
    if (!leaderRange) continue
    if (fRange.end < leaderRange.start || leaderRange.end < fRange.start) continue
    lines.push({
      id: `faction-leader-${f.id}-${f.leaderId}`,
      x1: fRange.midX, y1: fRange.midY, x2: leaderRange.midX, y2: leaderRange.midY,
      color: RELATION_COLOR.leader, label: '领袖', relationType: 'leader',
    })
  }

  if (lines.length === 0) {
    return (
      <div className="tl-relation-layer tl-relation-layer-empty" style={{ height: '100%' }}>
        无关系连线
      </div>
    )
  }

  // 计算 SVG 范围
  const maxX = Math.max(...lines.flatMap((l) => [l.x1, l.x2])) + 20
  const maxY = Math.max(...lines.flatMap((l) => [l.y1, l.y2])) + 20

  return (
    <svg
      className="tl-relation-layer"
      style={{ pointerEvents: 'none' }}
      width={maxX}
      height={maxY}
    >
      {lines.map((line) => {
        // 控制点（贝塞尔曲线中点偏移）
        const midX = (line.x1 + line.x2) / 2
        const midY = (line.y1 + line.y2) / 2
        const offset = Math.abs(line.y2 - line.y1) * 0.3
        const cx = midX
        const cy = midY - offset
        return (
          <g key={line.id}>
            <path
              d={`M ${line.x1} ${line.y1} Q ${cx} ${cy} ${line.x2} ${line.y2}`}
              stroke={line.color}
              strokeWidth={1.5}
              fill="none"
              strokeDasharray="4 2"
            />
            <text
              x={cx}
              y={cy}
              fill={line.color}
              fontSize={10}
              textAnchor="middle"
              dy={-2}
            >
              {line.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
