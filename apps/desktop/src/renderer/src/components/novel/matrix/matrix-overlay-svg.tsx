/**
 * matrix-overlay-svg：关系叠加层 SVG
 *
 * 在矩阵上方绘制角色间关系连线（贝塞尔曲线 + 关系类型标签）。
 * 由 matrix-view 在 showRelationshipOverlay 开启时渲染。
 */

import { useMemo, type ReactElement } from 'react'
import type { NovelRelationship } from '@/api/novel-client'

function relationshipColor(alignment: string): string {
  switch (alignment) {
    case 'ally':
    case 'temporary_ally':
      return 'rgba(34,197,94,0.45)'
    case 'opponent':
    case 'temporary_opponent':
      return 'rgba(239,68,68,0.45)'
    case 'neutral':
      return 'rgba(115,115,115,0.35)'
    default:
      return 'rgba(59,130,246,0.35)'
  }
}

export interface RelationshipOverlayProps {
  relationships: NovelRelationship[]
  /** T02-6 事件参与派生边：同一 StoryEvent 内实体两两成对（浅色虚线，无标签） */
  eventEdges?: Array<{ eventId: string; chapterNumber: number; from: string; to: string }>
  entityRowY: Map<string, number>
  chapterColumnX: (chapter: number) => number
  visibleRange: { start: number; end: number }
  cellWidth: number
  sidebarWidth: number
}

export function RelationshipOverlay({
  relationships, eventEdges = [], entityRowY, chapterColumnX, visibleRange, cellWidth, sidebarWidth,
}: RelationshipOverlayProps): ReactElement | null {
  const visibleRelations = useMemo(() => {
    const out: Array<{ rel: NovelRelationship; x: number; y1: number; y2: number; color: string }> = []
    for (const rel of relationships) {
      const y1 = entityRowY.get(rel.characterA)
      const y2 = entityRowY.get(rel.characterB)
      if (y1 == null || y2 == null) continue
      const chapter = rel.lastUpdatedChapter ?? Math.floor((visibleRange.start + visibleRange.end) / 2)
      if (chapter < visibleRange.start || chapter > visibleRange.end) continue
      const x = chapterColumnX(chapter)
      out.push({ rel, x, y1, y2, color: relationshipColor(rel.alignment) })
      if (out.length >= 50) break
    }
    return out
  }, [relationships, entityRowY, chapterColumnX, visibleRange])

  // 事件参与派生边：同事件实体对按事件章节定位，浅色虚线（无标签）；
  // 与结构化关系去重（同一实体对已由结构化边覆盖则跳过）
  const visibleEventEdges = useMemo(() => {
    const structuredPairs = new Set(
      relationships.map((r) => [r.characterA, r.characterB].sort().join('|')),
    )
    const out: Array<{ key: string; x: number; y1: number; y2: number }> = []
    const seen = new Set<string>()
    for (const edge of eventEdges) {
      const y1 = entityRowY.get(edge.from)
      const y2 = entityRowY.get(edge.to)
      if (y1 == null || y2 == null) continue
      if (edge.chapterNumber < visibleRange.start || edge.chapterNumber > visibleRange.end) continue
      const pairKey = [edge.from, edge.to].sort().join('|')
      if (structuredPairs.has(pairKey) || seen.has(pairKey)) continue
      seen.add(pairKey)
      const x = chapterColumnX(edge.chapterNumber)
      out.push({ key: edge.eventId + pairKey, x, y1, y2 })
      if (out.length >= 100) break
    }
    return out
  }, [eventEdges, relationships, entityRowY, chapterColumnX, visibleRange])

  if (visibleRelations.length === 0 && visibleEventEdges.length === 0) return null

  const svgLeft = sidebarWidth + (visibleRange.start - 1) * cellWidth
  const svgWidth = (visibleRange.end - visibleRange.start + 1) * cellWidth

  return (
    <svg
      className="absolute pointer-events-none z-[15]"
      style={{ left: svgLeft, top: 0, width: svgWidth, height: '100%' }}
      aria-hidden="true"
    >
      {visibleEventEdges.map(({ key, x, y1, y2 }) => {
        const innerX = x - svgLeft
        const path = `M ${innerX},${y1} C ${innerX + 50},${y1} ${innerX - 50},${y2} ${innerX},${y2}`
        return (
          <path
            key={key}
            d={path}
            fill="none"
            stroke="rgba(96,165,250,0.35)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )
      })}
      {visibleRelations.map(({ rel, x, y1, y2, color }) => {
        const innerX = x - svgLeft
        const midY = (y1 + y2) / 2
        const path = `M ${innerX},${y1} C ${innerX + 50},${y1} ${innerX - 50},${y2} ${innerX},${y2}`
        return (
          <g key={rel.id}>
            <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
            {rel.relationType && (
              <text
                x={innerX}
                y={midY}
                fill={color.replace(/[\d.]+\)$/, '0.85)')}
                fontSize={10}
                textAnchor="middle"
                dominantBaseline="middle"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {rel.relationType}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
