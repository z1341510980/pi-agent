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

import { useMemo, type ReactElement } from 'react'
import type { NovelRelationship, NovelFaction } from '@/api/novel-client'
import type { TimelineTrack } from './use-timeline-data'
import { buildRelationLines, type LineSegment } from './timeline-logic'

export interface TimelineRelationLayerProps {
  tracks: TimelineTrack[]
  relationships: NovelRelationship[]
  factions: NovelFaction[]
  chapterWidth: number
  trackHeight: number
  maxChapter: number
}

export function TimelineRelationLayer({
  tracks,
  relationships,
  factions,
  chapterWidth,
  trackHeight,
}: TimelineRelationLayerProps): ReactElement {
  // 构建连线（纯函数 + useMemo，避免父组件 state 变化触发重算）
  const lines = useMemo<LineSegment[]>(
    () => buildRelationLines(tracks, relationships, factions, chapterWidth, trackHeight),
    [tracks, relationships, factions, chapterWidth, trackHeight],
  )

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
