import { type TargetPlatform } from '@/api/novel-client'

// ── 通用节点类型（用于删除等操作；拖拽已统一走 @dnd-kit useDraggable）──

export type DraggableEntityType = 'character' | 'chapter' | 'foreshadow' | 'conflict' | 'clue' | 'faction' | 'location' | 'world_element' | 'info_layer' | 'item'

// ── 目标平台选项（与 novel-detail-panel.tsx 保持一致）──

export const SIDEBAR_PLATFORM_OPTIONS: { value: TargetPlatform | '__none__'; label: string }[] = [
  { value: '__none__', label: '未设定' },
  { value: 'fanqie', label: '番茄' },
  { value: 'qidian', label: '起点' },
  { value: 'zhihu_yanyan', label: '知乎盐言' },
  { value: 'general', label: '通用' },
]
