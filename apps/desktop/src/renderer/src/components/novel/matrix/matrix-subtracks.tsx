/**
 * MatrixSubtracks：实体行下方内联展开的子轨道组
 *
 * 矩阵重设计（2026-07-22）要点：
 * - 数据由父级统一供给（tracks: SubtrackDef[]，来自共享的 matrix-aggregation
 *   单请求投影），本组件不再自行发请求 —— 修复"N 个展开实体 = N 次全量请求"
 * - 渲染编码与折叠态同一套视觉语言：enum 色块 / sparkline / 数字徽标 / 圆点
 * - hover 详情统一走 MatrixHoverCard（data-hc-*），替代原 CSS group-hover 气泡
 * - 空轨道折叠；行高 26px（MATRIX_LAYOUT.subtrackHeight）
 */

import { type CSSProperties, type ReactElement } from 'react'
import {
  MATRIX_LAYOUT,
  gridlineBackgroundImage,
  type SubtrackDef,
} from './matrix-model'

const SUB_H = MATRIX_LAYOUT.subtrackHeight

export interface MatrixSubtracksProps {
  tracks: SubtrackDef[]
  cellWidth: number
  sidebarWidth: number
  playheadChapter: number
}

export function MatrixSubtracks({
  tracks, cellWidth, sidebarWidth, playheadChapter,
}: MatrixSubtracksProps): ReactElement {
  // 空数据：单行占位（保持横向滚动同步）
  if (tracks.length === 0) {
    return (
      <div className="relative flex border-b border-border/10 bg-primary/[0.03]" style={{ height: SUB_H }}>
        <div
          className="sticky left-0 z-30 flex items-center gap-1.5 px-2 border-r border-border/40 shrink-0 bg-surface-1"
          style={{ width: sidebarWidth }}
        >
          <span className="text-[10px] text-hint/70 truncate pl-8">子轨道</span>
        </div>
        <div className="relative flex-1" style={{ backgroundImage: gridlineBackgroundImage(cellWidth) }}>
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-hint/70 pointer-events-none">
            暂无变化记录
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-primary/[0.03] animate-[subtrack-enter_180ms_ease-out]">
      {tracks.map((track) => (
        <SubtrackRow
          key={track.key}
          track={track}
          cellWidth={cellWidth}
          sidebarWidth={sidebarWidth}
          playheadChapter={playheadChapter}
        />
      ))}
    </div>
  )
}

// ── 单条子轨道行 ──

interface SubtrackRowProps {
  track: SubtrackDef
  cellWidth: number
  sidebarWidth: number
  playheadChapter: number
}

function SubtrackRow({
  track, cellWidth, sidebarWidth, playheadChapter,
}: SubtrackRowProps): ReactElement | null {
  const hasData = track.bands.length > 0
    || (track.curve && track.curve.length >= 2)
    || (track.nodes && track.nodes.length > 0)
  if (!hasData) return null

  return (
    <div
      className="relative flex border-b border-border/10 last:border-b-0"
      style={{ height: SUB_H }}
    >
      {/* 左侧 sticky 列：轨道标签 + enum 图例 */}
      <div
        className="sticky left-0 z-30 flex items-center gap-1.5 pr-2 pl-9 border-r border-border/40 shrink-0 bg-surface-1"
        style={{ width: sidebarWidth }}
      >
        <span className="w-1 h-1 rounded-full shrink-0 opacity-70" style={{ background: track.color }} />
        <span className="text-[10px] text-subtle truncate">{track.label}</span>
        {track.legend && track.legend.length > 0 && (
          <span className="flex items-center gap-1 ml-auto shrink-0">
            {track.legend.map((item, i) => (
              <span key={i} className="flex items-center gap-0.5">
                <span className="w-2 h-2 rounded-sm" style={{ background: item.fill }} />
                <span className="text-[9px] text-hint/70 truncate max-w-[40px]">{item.label}</span>
              </span>
            ))}
          </span>
        )}
      </div>

      {/* 右侧轨道主体：网格背景 + 编码层 + hover 热区 */}
      <div
        className="relative flex-1"
        style={{ backgroundImage: gridlineBackgroundImage(cellWidth) }}
      >
        {/* 播放头列高亮 */}
        <div
          aria-hidden="true"
          className="absolute top-0 bottom-0 pointer-events-none bg-amber-500/[0.06]"
          style={{ left: (playheadChapter - 1) * cellWidth, width: cellWidth }}
        />
        <SubtrackOverlay track={track} cellWidth={cellWidth} trackHeight={SUB_H} />
      </div>
    </div>
  )
}

// ── 编码层 + hover 热区 ──
// 默认纯视觉编码（无文字标签），hover 走 MatrixHoverCard（data-hc-*）

interface SubtrackOverlayProps {
  track: SubtrackDef
  cellWidth: number
  trackHeight: number
}

function SubtrackOverlay({ track, cellWidth, trackHeight }: SubtrackOverlayProps): ReactElement | null {
  const hasBands = track.bands.length > 0
  const hasCurve = !!(track.curve && track.curve.length >= 2)
  const hasNodes = !!(track.nodes && track.nodes.length > 0)
  if (!hasBands && !hasCurve && !hasNodes) return null

  const xCenter = (ch: number): number => (ch - 1) * cellWidth + cellWidth / 2
  const xLeft = (ch: number): number => (ch - 1) * cellWidth
  const midY = trackHeight / 2
  const svgWidth = maxCh(track) * cellWidth

  const svgStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    pointerEvents: 'none',
    overflow: 'visible',
  }

  const isSetType = track.nodes?.some((n) => n.badge != null) ?? false

  return (
    <div className="absolute inset-0">
      <svg width={svgWidth} height={trackHeight} style={svgStyle} aria-hidden="true">
        {/* enum/level：连续色块 + 变化交界竖线 */}
        {track.bands.map((band, idx) => {
          const x = xLeft(band.startCh)
          const width = (band.endCh - band.startCh + 1) * cellWidth
          return (
            <g key={`band-${idx}`}>
              <rect x={x + 1} y={5} width={Math.max(0, width - 2)} height={trackHeight - 10} rx={3} fill={band.fill} />
              {idx > 0 && (
                <line x1={x} y1={5} x2={x} y2={trackHeight - 5} stroke="rgba(115,115,115,0.35)" strokeWidth={2} />
              )}
            </g>
          )
        })}

        {/* number：sparkline */}
        {hasCurve && track.curve && (() => {
          const pad = 5
          const h = trackHeight - pad * 2
          const points = track.curve.map((p) => ({ x: xCenter(p.ch), y: pad + (1 - p.value) * h }))
          const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
          return (
            <g>
              <path d={path} fill="none" stroke={track.color} strokeWidth={1.5} opacity={0.8} strokeLinejoin="round" strokeLinecap="round" />
              {points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={2} fill={track.color} />
              ))}
            </g>
          )
        })()}

        {/* nodes：set 徽标 / text 圆点 / enum 变化点 */}
        {track.nodes?.map((node, idx) => {
          const x = xCenter(node.ch)
          if (node.badge != null) {
            return (
              <g key={`node-${idx}`}>
                <circle cx={x} cy={midY} r={8} fill={node.color} />
                <text x={x} y={midY} textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill="#fff">
                  {node.badge > 99 ? '99+' : node.badge}
                </text>
              </g>
            )
          }
          if (isSetType) return null
          if (hasCurve) return null // number 数据点已在 curve 中渲染
          return <circle key={`node-${idx}`} cx={x} cy={midY} r={3} fill={node.color} />
        })}
      </svg>

      {/* hover 热区（data-hc-* → MatrixHoverCard） */}
      {track.bands.map((band, idx) => {
        const prev = idx > 0 ? track.bands[idx - 1] : null
        return (
          <div
            key={`hot-band-${idx}`}
            className="absolute top-0 bottom-0 cursor-pointer"
            style={{ left: xLeft(band.startCh), width: (band.endCh - band.startCh + 1) * cellWidth }}
            data-hc-dim={track.label}
            data-hc-ch={`${band.startCh} – ${band.endCh}`}
            data-hc-before={prev?.valueKey ?? ''}
            data-hc-after={band.valueKey ?? band.label ?? ''}
            data-hc-color={track.color}
          />
        )
      })}
      {track.nodes?.map((node, idx) => (
        <div
          key={`hot-node-${idx}`}
          className="absolute top-0 bottom-0 cursor-pointer"
          style={{ left: xLeft(node.ch), width: cellWidth }}
          data-hc-dim={track.label}
          data-hc-ch={String(node.ch)}
          data-hc-before={node.before ?? ''}
          data-hc-after={node.badge != null ? `${node.badge} 项` : node.label}
          data-hc-desc={node.desc ?? ''}
          data-hc-color={track.color}
        />
      ))}
    </div>
  )
}

function maxCh(track: SubtrackDef): number {
  return Math.max(
    track.bands.reduce((m, b) => Math.max(m, b.endCh), 0),
    track.curve?.reduce((m, p) => Math.max(m, p.ch), 0) ?? 0,
    track.nodes?.reduce((m, n) => Math.max(m, n.ch), 0) ?? 0,
    1,
  )
}
