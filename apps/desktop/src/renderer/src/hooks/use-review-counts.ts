/**
 * useReviewCounts：审校中心全局待办计数
 *
 * 待确认事件（AI 提取队列）+ 待审实体（Memory 候选）两个轻量轮询查询，
 * 供右栏「审校」Tab 角标与审校中心入口列表共用（react-query 按 key 去重，
 * 多处消费不会产生重复请求）。
 */
import { useQuery } from '@tanstack/react-query'
import { listEntityCandidates, listPendingEvents } from '@/api/novel-client'

export interface ReviewCounts {
  /** AI 提取待确认事件数 */
  pendingEventCount: number
  /** Memory 待审实体候选数 */
  candidateCount: number
  /** 两者之和（Tab 角标用） */
  total: number
}

const EMPTY: ReviewCounts = { pendingEventCount: 0, candidateCount: 0, total: 0 }

export function useReviewCounts(projectId: string | null): ReviewCounts {
  const eventsQuery = useQuery({
    queryKey: ['novel-pending-events-count', projectId],
    queryFn: async () => {
      if (!projectId) return 0
      const res = await listPendingEvents(projectId)
      return res.items.length
    },
    enabled: !!projectId,
    refetchInterval: 60_000,
  })
  const candidatesQuery = useQuery({
    queryKey: ['novel-entity-candidates-count', projectId],
    queryFn: async () => {
      if (!projectId) return 0
      const res = await listEntityCandidates(projectId)
      return res.pendingCount
    },
    enabled: !!projectId,
    refetchInterval: 60_000,
  })

  const pendingEventCount = eventsQuery.data ?? 0
  const candidateCount = candidatesQuery.data ?? 0
  if (pendingEventCount === 0 && candidateCount === 0) return EMPTY
  return { pendingEventCount, candidateCount, total: pendingEventCount + candidateCount }
}
