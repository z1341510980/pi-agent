/**
 * useCanvasNodeDeletion：画布节点删除的唯一实现（P2-2b）
 *
 * 此前 novel-toolbar 与 novel-canvas 各持有一份几乎相同的删除逻辑，
 * 行为漂移风险高。现在两处共用本 hook：
 * - API 删除 + 本地 store 同步（6 类实体 switch）
 * - 节点位置清理（best-effort，失败不阻塞主流程）
 * - 确认弹窗与 group 类型短路
 */
import { useCallback } from 'react'
import {
  deleteCharacter,
  deleteConflict,
  deleteForeshadow,
  deleteFaction,
  deleteLocation,
  deleteWorldElement,
  deleteNodePosition,
  type NovelNodeTypeName,
} from '@/api/novel-client'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'

export interface UseCanvasNodeDeletionOptions {
  /** 删除成功后的附加回调（如画布侧的节点状态清理） */
  onDeleted?: () => void
}

export interface UseCanvasNodeDeletionResult {
  /**
   * 删除一个实体节点。
   * @returns 是否实际执行了删除（false = 无项目/group/取消/失败）
   */
  deleteNode: (targetId: string, targetType: string) => Promise<boolean>
}

export function useCanvasNodeDeletion({ onDeleted }: UseCanvasNodeDeletionOptions = {}): UseCanvasNodeDeletionResult {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const removeCharacter = useNovelDataStore((s) => s.removeCharacter)
  const removeConflict = useNovelDataStore((s) => s.removeConflict)
  const removeForeshadow = useNovelDataStore((s) => s.removeForeshadow)
  const removeFaction = useNovelDataStore((s) => s.removeFaction)
  const removeLocation = useNovelDataStore((s) => s.removeLocation)
  const removeWorldElement = useNovelDataStore((s) => s.removeWorldElement)
  const removeNodePosition = useNovelDataStore((s) => s.removeNodePosition)
  const clearSelection = useNovelUiStore((s) => s.clearSelection)

  const deleteNode = useCallback(async (targetId: string, targetType: string): Promise<boolean> => {
    if (!currentProjectId || !targetId) return false
    // group 节点不对应持久化实体
    if (targetType === 'group') return false
    if (!window.confirm('确认删除此节点？相关数据将被永久移除。')) return false
    try {
      switch (targetType) {
        case 'character':
          await deleteCharacter(targetId)
          removeCharacter(targetId)
          break
        case 'conflict':
          await deleteConflict(targetId)
          removeConflict(targetId)
          break
        case 'foreshadow':
          await deleteForeshadow(targetId)
          removeForeshadow(targetId)
          break
        case 'faction':
          await deleteFaction(targetId)
          removeFaction(targetId)
          break
        case 'location':
          await deleteLocation(targetId)
          removeLocation(targetId)
          break
        case 'world_element':
          await deleteWorldElement(targetId)
          removeWorldElement(targetId)
          break
        default:
          return false
      }
      // 删除节点位置（best-effort）
      try {
        await deleteNodePosition(currentProjectId, targetType as NovelNodeTypeName, targetId)
      } catch {
        // 位置删除失败不阻塞主流程
      }
      removeNodePosition(targetType as NovelNodeTypeName, targetId)
      clearSelection()
      onDeleted?.()
      return true
    } catch {
      // 静默失败（可在通知中心提示）
      return false
    }
  }, [
    currentProjectId,
    removeCharacter,
    removeConflict,
    removeForeshadow,
    removeFaction,
    removeLocation,
    removeWorldElement,
    removeNodePosition,
    clearSelection,
    onDeleted,
  ])

  return { deleteNode }
}
