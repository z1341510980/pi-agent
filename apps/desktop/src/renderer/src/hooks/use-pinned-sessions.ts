import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'pi-agent.pinned-sessions'

/**
 * 持久化读取 localStorage 中的置顶会话 ID 列表。
 * 损坏/缺失时返回空数组。
 */
function readFromStorage(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 过滤非字符串 + 去重（保持顺序）
    const seen = new Set<string>()
    const result: string[] = []
    for (const item of parsed) {
      if (typeof item === 'string' && item.length > 0 && !seen.has(item)) {
        seen.add(item)
        result.push(item)
      }
    }
    return result
  } catch {
    return []
  }
}

function writeToStorage(ids: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 静默失败（隐私模式 / 配额满）
  }
}

export interface UsePinnedSessionsReturn {
  /** 置顶会话 ID 列表（按用户拖拽后的顺序） */
  pinnedOrder: string[]
  /** 判断某个会话是否已置顶 */
  isPinned: (threadId: string) => boolean
  /** 切换置顶状态；新增的置顶会追加到列表末尾 */
  togglePin: (threadId: string) => void
  /** 拖拽排序：把 fromId 移到 toId 的位置（两者必须都已置顶） */
  reorderPinned: (fromId: string, toId: string) => void
}

/**
 * usePinnedSessions：管理置顶会话 ID 列表 + 拖拽顺序，持久化到 localStorage。
 *
 * 设计要点：
 * 1. 仅存储 ID 数组（顺序即用户拖拽后的顺序），不存储会话元数据
 * 2. 跨标签页/窗口通过 'storage' 事件同步
 * 3. 新置顶的会话追加到末尾（最新的在最下面）
 * 4. reorderPinned 用 arrayMove 语义：fromId 移动到 toId 当前位置
 */
export function usePinnedSessions(): UsePinnedSessionsReturn {
  const [pinnedOrder, setPinnedOrder] = useState<string[]>(() => readFromStorage())

  // 持久化
  useEffect(() => {
    writeToStorage(pinnedOrder)
  }, [pinnedOrder])

  // 跨窗口同步
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setPinnedOrder(readFromStorage())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const isPinned = useCallback(
    (threadId: string) => pinnedOrder.includes(threadId),
    [pinnedOrder],
  )

  const togglePin = useCallback((threadId: string) => {
    setPinnedOrder((prev) => {
      if (prev.includes(threadId)) {
        return prev.filter((id) => id !== threadId)
      }
      return [...prev, threadId]
    })
  }, [])

  const reorderPinned = useCallback((fromId: string, toId: string) => {
    setPinnedOrder((prev) => {
      const fromIdx = prev.indexOf(fromId)
      const toIdx = prev.indexOf(toId)
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev
      const next = [...prev]
      // 标准数组移动：先删 from，再插到 to 位置
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
  }, [])

  return {
    pinnedOrder,
    isPinned,
    togglePin,
    reorderPinned,
  }
}
