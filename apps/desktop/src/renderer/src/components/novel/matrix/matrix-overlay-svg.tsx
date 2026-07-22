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
  entityRowY: Map<string, number>
  chapterColumnX: (chapter: number) => number
  visibleRange: { start: number; end: number }
  cellWidth: number
  sidebarWidth: number
}

export function RelationshipOverlay({
  relationships, entityRowY, chapterColumnX, visibleRange, cellWidth, sidebarWidth,
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

  if (visibleRelations.length === 0) return null

  const svgLeft = sidebarWidth + (visibleRange.start - 1) * cellWidth
  const svgWidth = (visibleRange.end - visibleRange.start + 1) * cellWidth

  return (
    <svg
      className="absolute pointer-events-none z-[15]"
      style={{ left: svgLeft, top: 0, width: svgWidth, height: '100%' }}
      aria-hidden="true"
    >
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
