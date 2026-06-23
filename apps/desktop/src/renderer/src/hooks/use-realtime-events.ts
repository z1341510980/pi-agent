import { useState, useCallback } from 'react'
import type { NotificationPayload, DevLogPayload, UsageUpdatePayload } from './use-websocket'

/** 通知最大保留数量 */
const MAX_NOTIFICATIONS = 100
/** DevLog 最大保留数量 */
const MAX_DEVLOGS = 200

/**
 * useRealtimeEvents：实时事件管理 hook
 *
 * 统一管理 WebSocket 推送的 notification、devlog、usage_update 事件
 * - 通知：最多保留 100 条，新的在前
 * - DevLog：最多保留 200 条，按时间顺序
 * - 用量：累加统计
 */
export function useRealtimeEvents() {
  const [notifications, setNotifications] = useState<NotificationPayload[]>([])
  const [devLogs, setDevLogs] = useState<DevLogPayload[]>([])
  const [usageUpdates, setUsageUpdates] = useState<UsageUpdatePayload[]>([])
  const [totalUsage, setTotalUsage] = useState({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    callCount: 0,
  })

  const addNotification = useCallback((notification: NotificationPayload) => {
    setNotifications((prev) => {
      const next = [notification, ...prev]
      // 超过上限时移除最旧的（数组末尾）
      if (next.length > MAX_NOTIFICATIONS) {
        return next.slice(0, MAX_NOTIFICATIONS)
      }
      return next
    })
  }, [])

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const dismissAllNotifications = useCallback(() => {
    setNotifications([])
  }, [])

  const addDevLog = useCallback((log: DevLogPayload) => {
    setDevLogs((prev) => {
      const next = [...prev, log]
      // 超过上限时移除最旧的（数组开头）
      if (next.length > MAX_DEVLOGS) {
        return next.slice(next.length - MAX_DEVLOGS)
      }
      return next
    })
  }, [])

  const clearDevLogs = useCallback(() => {
    setDevLogs([])
  }, [])

  const addUsageUpdate = useCallback((usage: UsageUpdatePayload) => {
    setUsageUpdates((prev) => {
      const next = [...prev, usage]
      if (next.length > MAX_NOTIFICATIONS) {
        return next.slice(next.length - MAX_NOTIFICATIONS)
      }
      return next
    })
    setTotalUsage((prev) => ({
      inputTokens: prev.inputTokens + usage.inputTokens,
      outputTokens: prev.outputTokens + usage.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: prev.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      cost: prev.cost + (usage.cost ?? 0),
      callCount: prev.callCount + 1,
    }))
  }, [])

  return {
    notifications,
    devLogs,
    usageUpdates,
    totalUsage,
    addNotification,
    dismissNotification,
    dismissAllNotifications,
    addDevLog,
    clearDevLogs,
    addUsageUpdate,
  }
}

export type UseRealtimeEventsReturn = ReturnType<typeof useRealtimeEvents>
