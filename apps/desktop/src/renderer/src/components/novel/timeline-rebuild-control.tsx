import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiClientError } from '@/api/http-client'
import {
  applyTimelineRebuildStep,
  completeTimelineRebuildJob,
  getTimelineRebuildJob,
  getTimelineRebuildPreview,
  resumeTimelineRebuildJob,
  startTimelineRebuild,
  type TimelineRebuildJob,
  type TimelineRebuildPreview,
} from '@/api/novel-client'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import type { NovelAgentModelRef } from '@/stores/novel-ui-store'

interface TimelineRebuildControlProps {
  projectId: string | null
  selectedModel: NovelAgentModelRef | null
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    const details = error.details as {
      blockedReasons?: unknown
      preview?: { blockedReasons?: unknown }
    } | undefined
    const reasons = Array.isArray(details?.blockedReasons)
      ? details.blockedReasons
      : Array.isArray(details?.preview?.blockedReasons)
        ? details.preview.blockedReasons
        : []
    const text = reasons.filter((item): item is string => typeof item === 'string').join('；')
    return text || error.message
  }
  return error instanceof Error ? error.message : '未知错误'
}

function isActiveJob(job: TimelineRebuildJob | null): boolean {
  return job?.status === 'queued' || job?.status === 'running'
}

/** 隔离分析全部完成：没有 pending/replaying 步骤，等待用户逐章应用。 */
function isAnalysisPhaseDone(job: TimelineRebuildJob | null): boolean {
  if (!job || job.steps.length === 0) return false
  return job.steps.every(step => step.status === 'ready_to_apply' || step.status === 'applied')
}

/**
 * 项目级时间线重建入口。
 *
 * 该控件放在工作台顶栏而不是正文编辑器内，保证切换到矩阵/关系图布局、
 * 编辑器重新挂载或正文加载失败时，待修复入口仍然可见。
 */
export function TimelineRebuildControl({ projectId, selectedModel }: TimelineRebuildControlProps): ReactElement | null {
  const [job, setJob] = useState<TimelineRebuildJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const jobRef = useRef<TimelineRebuildJob | null>(null)
  const readErrorRef = useRef<string | null>(null)

  const updateJob = useCallback((next: TimelineRebuildJob | null): void => {
    jobRef.current = next
    setJob(next)
  }, [])

  const syncPreview = useCallback(async (): Promise<TimelineRebuildPreview | null> => {
    if (!projectId) {
      updateJob(null)
      setError(null)
      readErrorRef.current = null
      return null
    }
    try {
      const next = await getTimelineRebuildPreview(projectId)
      if (next.latestJob) updateJob(next.latestJob)
      readErrorRef.current = null
      // 预览成功只清掉读取错误；失败任务的错误由 job 状态继续显示。
      setError((current) => jobRef.current?.status === 'failed' ? current : null)
      return next
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === 'NOT_FOUND') {
        readErrorRef.current = null
        if (jobRef.current?.status !== 'failed' && jobRef.current?.status !== 'cancelled') setError(null)
        return null
      }
      readErrorRef.current = errorMessage(cause)
      setError(readErrorRef.current)
      return null
    }
  }, [projectId, updateJob])

  useEffect(() => {
    updateJob(null)
    setError(null)
    readErrorRef.current = null
    void syncPreview()
  }, [projectId, syncPreview, updateJob])

  useEffect(() => {
    if (!projectId || !job || !isActiveJob(job) || isAnalysisPhaseDone(job)) return
    const jobId = job.id
    let cancelled = false

    const syncJob = async (): Promise<void> => {
      try {
        const next = await getTimelineRebuildJob(projectId, jobId)
        if (cancelled) return
        updateJob(next)
        if (next.status === 'failed') setError(next.error ?? '时间线重建失败')
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause))
      }
    }

    void syncJob()
    const timer = window.setInterval(() => void syncJob(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [job?.id, job?.status, projectId, updateJob])

  const handleStart = useCallback(async (): Promise<void> => {
    if (!projectId || busy) return
    setBusy(true)
    try {
      let nextPreview = await syncPreview()
      if (!nextPreview) {
        const message = readErrorRef.current ?? error
        if (message) {
          setError(message)
          toastError('时间线状态读取失败', message)
        } else {
          toastSuccess('时间线正常', '当前项目没有待修复的时间线。')
        }
        return
      }
      if (!nextPreview.automaticRebuildAvailable) {
        const message = nextPreview.blockedReasons.join('；') || '当前项目不满足安全自动重建条件'
        setError(message)
        toastError('时间线暂时不能重建', message)
        return
      }

      const modelLabel = selectedModel
        ? `${selectedModel.provider}/${selectedModel.modelId}`
        : '项目默认模型或 Agent 默认模型'
      const confirmed = window.confirm(
        `将从第 ${nextPreview.startChapterNumber} 章起顺序重建 ${nextPreview.affectedChapters.length} 章，预计 ${nextPreview.estimatedLlmCalls} 次模型调用。\n\n本次模型：${modelLabel}\n\n确认继续？`,
      )
      if (!confirmed) return

      setError(null)
      if (jobRef.current && (jobRef.current.status === 'failed' || jobRef.current.status === 'cancelled')) {
        try {
          const resumed = await resumeTimelineRebuildJob(projectId, jobRef.current.id)
          updateJob(resumed)
          toastSuccess('已恢复时间线修复', '将从最近一次安全检查点继续；如果仍失败，可再次重试。')
          return
        } catch (resumeCause) {
          const resumeMessage = errorMessage(resumeCause)
          if (!resumeMessage.includes('已变化')) throw resumeCause
          // 旧任务的步骤范围/锁定版本已过期（期间又改写或回滚过正文），
          // 刷新预览后回退到新建任务，避免用旧正文做隔离分析。
          nextPreview = await syncPreview()
          if (!nextPreview || !nextPreview.automaticRebuildAvailable) {
            const message = nextPreview
              ? nextPreview.blockedReasons.join('；') || '当前项目不满足安全自动重建条件'
              : readErrorRef.current ?? '时间线状态读取失败'
            setError(message)
            toastError('时间线暂时不能重建', message)
            return
          }
        }
      }
      const nextJob = await startTimelineRebuild(projectId, nextPreview.confirmationToken, selectedModel)
      updateJob(nextJob)
      toastSuccess('已启动时间线修复', '后台正在按章节顺序分析；分析完成后请回到此处应用重建结果。')
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      // 启动失败不能清理 preview/job，保证用户仍能点击重试。
      toastError('时间线修复失败', message)
    } finally {
      setBusy(false)
    }
  }, [busy, error, projectId, selectedModel, syncPreview, updateJob])

  /**
   * 隔离分析完成后的应用闭环：按章节顺序把 ready_to_apply 步骤逐章落库，
   * 全部应用后完成任务并解除创作/发布闸门。
   */
  const handleApplyAll = useCallback(async (): Promise<void> => {
    if (!projectId || busy) return
    let current = jobRef.current
    if (!current) return
    setBusy(true)
    try {
      for (;;) {
        const next = current.steps.find(step => step.status === 'ready_to_apply')
        if (!next) break
        current = await applyTimelineRebuildStep(projectId, current.id, next.chapterId, next.contentRevisionId)
        updateJob(current)
      }
      if (current.steps.every(step => step.status === 'applied')) {
        const completed = await completeTimelineRebuildJob(projectId, current.id)
        updateJob(completed)
        toastSuccess('时间线重建完成', '派生状态已按重放结果恢复，创作与发布闸门已解除。')
      }
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      toastError('应用重建结果失败', message)
    } finally {
      setBusy(false)
    }
  }, [busy, projectId, updateJob])

  // 项目级入口始终可见，避免一次临时请求失败或切换布局后用户失去修复入口。
  const visible = !!projectId
  if (!visible) return null

  const failed = job?.status === 'failed' || !!error
  const applyMode = !!job && job.status === 'running' && job.steps.some(step => step.status === 'ready_to_apply')
  const label = busy
    ? applyMode
      ? '应用重建结果…'
      : '检查时间线…'
    : job?.status === 'failed'
      ? '重试时间线修复'
      : job?.status === 'cancelled'
            ? '继续时间线修复'
        : applyMode
          ? `应用重建 ${job.completed}/${job.steps.length}`
          : job && isActiveJob(job)
            ? `时间线 ${job.completed}/${job.steps.length}`
            : failed
              ? '查看时间线错误'
              : '检查时间线'

  return (
    <div className="flex min-w-0 items-center gap-1">
      {error && (
        <span className="hidden max-w-[220px] truncate text-[10px] text-destructive xl:inline" title={error}>
          {error}
        </span>
      )}
      <Button
        type="button"
        size="sm"
        variant={applyMode ? 'default' : failed ? 'destructive' : 'outline'}
        className="h-7 gap-1 px-2 text-[11px]"
        onClick={() => void (applyMode ? handleApplyAll() : handleStart())}
        disabled={busy}
        title={error ?? (applyMode ? '按章节顺序应用隔离重放结果并完成重建' : '查看并启动项目级时间线重建')}
      >
        {busy ? <LoaderCircle className="size-3 animate-spin" /> : applyMode ? <CheckCircle2 className="size-3" /> : failed ? <RefreshCw className="size-3" /> : job?.status === 'cancelled' ? <RotateCcw className="size-3" /> : <AlertTriangle className="size-3" />}
        <span>{label}</span>
      </Button>
    </div>
  )
}
