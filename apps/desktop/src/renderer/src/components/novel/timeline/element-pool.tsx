/**
 * ElementPool：元素池组件
 *
 * 列出尚未放置到时间轴上的元素，支持原生 HTML5 拖拽。
 * 拖入时间轴后，调用对应 API 创建记录并刷新数据。
 *
 * 元素类型：
 * - 角色：无 characterHistory 记录 → 拖入后创建历史记录
 * - 冲突：firstChapter 为 null → 拖入后更新 firstChapter
 * - 伏笔：firstChapter 为 null → 拖入后更新 firstChapter
 * - 势力：firstChapter 为 null → 拖入后更新 firstChapter
 * - 地点：appearChapters 为空 → 拖入后追加章节到 appearChapters
 *
 * 世界要素不在此池（固定轨道，始终显示）
 */

import { type ReactElement } from 'react'
import type {
  NovelCharacter,
  NovelConflict,
  NovelForeshadow,
  NovelFaction,
  NovelLocation,
} from '@/api/novel-client'

/** 元素池项的拖拽数据载荷 */
export interface PoolDragPayload {
  kind: 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location'
  id: string
  name: string
}

export const POOL_DRAG_MIME = 'application/x-novel-pool-item'

export interface ElementPoolProps {
  characters: NovelCharacter[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
}

// 颜色映射（与 timeline-styles.css 保持一致）
const KIND_COLOR: Record<PoolDragPayload['kind'], string> = {
  character: 'rgb(59, 130, 246)',
  conflict: 'rgb(244, 63, 94)',
  foreshadow: 'rgb(245, 158, 11)',
  faction: 'rgb(168, 85, 247)',
  location: 'rgb(6, 182, 212)',
}

const KIND_LABEL: Record<PoolDragPayload['kind'], string> = {
  character: '角色',
  conflict: '冲突',
  foreshadow: '伏笔',
  faction: '势力',
  location: '地点',
}

interface PoolItemProps {
  payload: PoolDragPayload
}

function PoolItem({ payload }: PoolItemProps): ReactElement {
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>): void => {
    e.dataTransfer.setData(POOL_DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      className="novel-element-pool-item"
      draggable
      onDragStart={handleDragStart}
      title={`拖入时间轴以放置「${payload.name}」`}
    >
      <span
        className="pool-item-dot"
        style={{ background: KIND_COLOR[payload.kind] }}
      />
      <span className="pool-item-name">{payload.name}</span>
      <span className="text-[9px] text-muted-foreground">{KIND_LABEL[payload.kind]}</span>
    </div>
  )
}

export function ElementPool({
  characters,
  conflicts,
  foreshadows,
  factions,
  locations,
}: ElementPoolProps): ReactElement {
  const total =
    characters.length + conflicts.length + foreshadows.length + factions.length + locations.length

  return (
    <aside className="novel-element-pool">
      <div className="novel-element-pool-header">
        元素池 {total > 0 && <span className="ml-1 text-muted-foreground">({total})</span>}
      </div>
      <div className="novel-element-pool-body">
        {total === 0 ? (
          <div className="novel-element-pool-empty">
            所有元素已放置到轨道
          </div>
        ) : (
          <>
            {characters.length > 0 && (
              <>
                <div className="novel-element-pool-group-title">角色</div>
                {characters.map((c) => (
                  <PoolItem
                    key={`char-${c.id}`}
                    payload={{ kind: 'character', id: c.id, name: c.name }}
                  />
                ))}
              </>
            )}
            {conflicts.length > 0 && (
              <>
                <div className="novel-element-pool-group-title">冲突</div>
                {conflicts.map((c) => (
                  <PoolItem
                    key={`conf-${c.id}`}
                    payload={{ kind: 'conflict', id: c.id, name: c.description }}
                  />
                ))}
              </>
            )}
            {foreshadows.length > 0 && (
              <>
                <div className="novel-element-pool-group-title">伏笔</div>
                {foreshadows.map((f) => (
                  <PoolItem
                    key={`fore-${f.id}`}
                    payload={{ kind: 'foreshadow', id: f.id, name: f.description }}
                  />
                ))}
              </>
            )}
            {factions.length > 0 && (
              <>
                <div className="novel-element-pool-group-title">势力</div>
                {factions.map((f) => (
                  <PoolItem
                    key={`fac-${f.id}`}
                    payload={{ kind: 'faction', id: f.id, name: f.name }}
                  />
                ))}
              </>
            )}
            {locations.length > 0 && (
              <>
                <div className="novel-element-pool-group-title">地点</div>
                {locations.map((l) => (
                  <PoolItem
                    key={`loc-${l.id}`}
                    payload={{ kind: 'location', id: l.id, name: l.name }}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
