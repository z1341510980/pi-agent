/**
 * LLM 相似实体扫描 SSE Hook
 *
 * 与 use-novel-creation-flow 共用同一套 ag-ui 技术栈（parseSseStream），
 * 但流程更简单：只有扫描进度 + 最终报告，无检查点、无 LLM token 流。
 *
 * 后端端点：
 *   POST /api/plugins/novel/projects/:projectId/entities/similarity-scan
 *
 * 流程：
 * 1. SSE 推送 CUSTOM(novel:progress) 扫描进度（preparing/generating/parsing/completed）
 * 2. SSE 推送 CUSTOM(novel:result) 最终报告（含 SimilarityScanReport），流结束
 * 3. 前端拿到 report 后弹框让用户多选，用户勾选后调用 mergeSimilarityEntities 执行合并
 *    （合并是独立 REST POST，不走 SSE）
 *
 * ag-ui 事件格式：
 *   - { type: 'RUN_STARTED' }                              流开始
 *   - { type: 'CUSTOM', name: 'novel:progress', value }    扫描进度
 *   - { type: 'CUSTOM', name: 'novel:result',  value }     扫描报告（流结束）
 *   - { type: 'RUN_FINISHED' }                             流结束
 *   - { type: 'RUN_ERROR', message }                       错误
 */

import { useCallback, useRef, useState } from 'react'
import { browserConfig } from '@repo/config/browser'
import { parseSseStream } from '@/api/agui-client'
import { mergeSimilarityEntities, type SimilarityGroup, type SimilarityScanReport, type SimilarityScanProgressEvent } from '@/api/novel-client'
import type { BaseEvent, CustomEvent } from '@repo/protocol/events'

export type SimilarityScanPhase = 'idle' | 'scanning' | 'completed' | 'cancelled' | 'error'

export interface SimilarityScanState {
  phase: SimilarityScanPhase
  isScanning: boolean
  /** 扫描进度事件列表（用于进度气泡展示） */
  progressEvents: SimilarityScanProgressEvent[]
  /** 扫描完成后的报告（含全部相似组，未过滤） */
  report: SimilarityScanReport | null
  error: string | null
  /** 合并执行中（用户确认后调 REST） */
  isMerging: boolean
}

export interface UseNovelSimilarityScan extends SimilarityScanState {
  /** 启动相似度扫描（SSE 流） */
  startScan: (projectId: string) => Promise<void>
  /** 取消扫描（abort） */
  cancel: () => void
  /** 执行合并（用户在弹框中勾选的组） */
  mergeSelected: (projectId: string, groups: SimilarityGroup[]) => Promise<{ totalMerged: number }>
  /** 重置状态到 idle */
  reset: () => void
}

export function useNovelSimilarityScan(): UseNovelSimilarityScan {
  const [phase, setPhase] = useState<SimilarityScanPhase>('idle')
  const [isScanning, setIsScanning] = useState(false)
  const [progressEvents, setProgressEvents] = useState<SimilarityScanProgressEvent[]>([])
  const [report, setReport] = useState<SimilarityScanReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isMerging, setIsMerging] = useState(false)

  const abortControllerRef = useRef<AbortController | null>(null)

  /** 处理单条 ag-ui 事件 */
  const handleEvent = useCallback((event: BaseEvent): void => {
    if (event.type === 'CUSTOM') {
      const custom = event as CustomEvent
      switch (custom.name) {
        case 'novel:progress': {
          // 扫描进度（preparing/generating/parsing/completed/fallback）
          const evt = custom.value as SimilarityScanProgressEvent
          if (evt && typeof evt === 'object' && 'phase' in evt) {
            setProgressEvents((prev) => [...prev, evt])
          }
          return
        }
        case 'novel:result': {
          // 扫描完成，推送 report
          const result = custom.value as { status?: string; report?: SimilarityScanReport }
          if (result?.report) {
            setReport(result.report)
          }
          setPhase('completed')
          setIsScanning(false)
          return
        }
      }
      return
    }
    if (event.type === 'RUN_FINISHED') {
      // 流结束兜底：如果 result 事件已处理则 no-op，否则关闭 isScanning
      setIsScanning(false)
      return
    }
    if (event.type === 'RUN_ERROR') {
      const errEvent = event as { type: 'RUN_ERROR'; message: string }
      setError(errEvent.message || '扫描失败')
      setPhase('error')
      setIsScanning(false)
      return
    }
  }, [])

  /** 执行 SSE 流 */
  const runScan = useCallback(
    async (url: string, controller: AbortController): Promise<void> => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({}),
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`相似度扫描启动失败: HTTP ${response.status} ${response.statusText}`)
        }
        if (!response.body) {
          throw new Error('响应体为空，无法读取 SSE 流')
        }

        await parseSseStream(response.body, handleEvent)
      } catch (err) {
        if (controller.signal.aborted) {
          setPhase('cancelled')
          setIsScanning(false)
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setPhase('error')
        setIsScanning(false)
      }
    },
    [handleEvent],
  )

  const startScan = useCallback(
    async (projectId: string): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      // 重置状态
      setPhase('scanning')
      setProgressEvents([])
      setReport(null)
      setError(null)
      setIsScanning(true)

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/entities/similarity-scan`
      await runScan(url, controller)

      // 流结束后清理 controller（无论成功/失败/取消）
      abortControllerRef.current = null
    },
    [runScan],
  )

  const cancel = useCallback((): void => {
    if (!abortControllerRef.current) return
    abortControllerRef.current.abort()
  }, [])

  const mergeSelected = useCallback(
    async (projectId: string, groups: SimilarityGroup[]): Promise<{ totalMerged: number }> => {
      if (groups.length === 0) return { totalMerged: 0 }
      setIsMerging(true)
      try {
        const result = await mergeSimilarityEntities(projectId, groups)
        return result
      } finally {
        setIsMerging(false)
      }
    },
    [],
  )

  const reset = useCallback((): void => {
    setPhase('idle')
    setIsScanning(false)
    setProgressEvents([])
    setReport(null)
    setError(null)
  }, [])

  return {
    phase,
    isScanning,
    progressEvents,
    report,
    error,
    isMerging,
    startScan,
    cancel,
    mergeSelected,
    reset,
  }
}
