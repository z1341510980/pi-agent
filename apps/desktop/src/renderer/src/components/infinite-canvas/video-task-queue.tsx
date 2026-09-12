import { useMemo, useState, type ReactElement } from 'react'
import { ListVideo, RefreshCw, X } from 'lucide-react'

import type { CanvasVideoTask } from '@/api/infinite-canvas-client'
import { cn } from '@/lib/utils'
import type { CanvasTheme } from './canvas-theme'

export interface VideoTaskQueueProps {
  theme: CanvasTheme
  projectId: string
  tasks: CanvasVideoTask[]
  /** nodeId → 节点标题（工作区由画布节点构建）；缺项表示节点已删除。 */
  nodeTitles: Map<string, string>
  onFocusNode: (nodeId: string) => void
  onRetry: (nodeId: string) => void | Promise<void>
  onRefresh: () => void
  onClose: () => void
  loading: boolean
}

const STATUS_LABELS: Record<CanvasVideoTask['status'], string> = {
  running: '生成中',
  success: '已完成',
  failed: '失败',
  timeout: '已超时'
}

function formatTaskTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function VideoTaskRow({
  task,
  theme,
  nodeTitles,
  retrying,
  onLocate,
  onRetry
}: {
  task: CanvasVideoTask
  theme: CanvasTheme
  nodeTitles: Map<string, string>
  retrying: boolean
  onLocate: (nodeId: string) => void
  onRetry: (task: CanvasVideoTask) => void
}): ReactElement {
  const running = task.status === 'running'
  const settled = task.status === 'failed' || task.status === 'timeout'
  const nodeId = task.nodeId
  const nodeAvailable = nodeId !== null && nodeTitles.has(nodeId)
  const nodeTitle = nodeId === null ? '未关联节点' : (nodeTitles.get(nodeId) ?? '节点已删除')
  return (
    <li className="rounded-xl border p-3" style={{ borderColor: theme.toolbar.border }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn('size-2 shrink-0 rounded-full', settled && 'bg-red-500')}
            style={
              settled
                ? undefined
                : { background: running ? theme.node.activeStroke : theme.node.muted }
            }
          />
          <span className="shrink-0 text-xs font-medium">
            {STATUS_LABELS[task.status]}
            {running && task.progress ? ` ${task.progress}` : ''}
          </span>
          <span className="truncate text-xs opacity-60" title={nodeTitle}>
            {nodeTitle}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {nodeId !== null && (
            <button
              type="button"
              disabled={!nodeAvailable}
              className="rounded-full border px-2.5 py-1 text-[11px] disabled:opacity-40"
              style={{ borderColor: theme.toolbar.border }}
              onClick={() => onLocate(nodeId)}
            >
              定位节点
            </button>
          )}
          {settled && (
            <button
              type="button"
              disabled={retrying || !nodeAvailable}
              className="rounded-full border px-2.5 py-1 text-[11px] disabled:opacity-40"
              style={{ borderColor: theme.toolbar.border }}
              onClick={() => onRetry(task)}
            >
              重新获取
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px] opacity-50">
        {task.model && <span className="truncate">{task.model}</span>}
        <span className="tabular-nums">{formatTaskTime(task.createdAt)}</span>
      </div>
      {settled && task.error && (
        <p className="mt-1 truncate text-[11px] text-red-500" title={task.error}>
          {task.error}
        </p>
      )}
    </li>
  )
}

export function VideoTaskQueue({
  theme,
  tasks,
  nodeTitles,
  onFocusNode,
  onRetry,
  onRefresh,
  onClose,
  loading
}: VideoTaskQueueProps): ReactElement {
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set())

  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => b.createdAt - a.createdAt), [tasks])

  const summary = useMemo(() => {
    let running = 0
    let success = 0
    let failed = 0
    for (const task of tasks) {
      if (task.status === 'running') running += 1
      else if (task.status === 'success') success += 1
      else failed += 1
    }
    return { running, success, failed }
  }, [tasks])

  const handleRetry = (task: CanvasVideoTask): void => {
    if (!task.nodeId || retryingIds.has(task.id)) return
    setRetryingIds((current) => new Set(current).add(task.id))
    void Promise.resolve(onRetry(task.nodeId))
      .catch(() => undefined)
      .finally(() => {
        setRetryingIds((current) => {
          const next = new Set(current)
          next.delete(task.id)
          return next
        })
      })
  }

  return (
    <div
      className="fixed inset-0 z-[130] grid place-items-center bg-black/35 p-5"
      onClick={onClose}
    >
      <div
        className="flex h-[70vh] w-full max-w-2xl flex-col rounded-2xl border p-4 shadow-2xl"
        style={{
          background: theme.toolbar.panel,
          borderColor: theme.toolbar.border,
          color: theme.node.text
        }}
        data-canvas-no-zoom
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ListVideo className="size-4" />
            任务队列
            {tasks.length > 0 && (
              <span className="ml-1 text-xs font-normal opacity-45">
                生成中 {summary.running} · 完成 {summary.success} · 失败 {summary.failed}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs disabled:opacity-45"
              style={{ borderColor: theme.toolbar.border }}
              onClick={onRefresh}
            >
              <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
              刷新
            </button>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="grid size-7 place-items-center rounded-lg opacity-55 hover:opacity-100"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div
          className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto"
          onWheel={(event) => event.stopPropagation()}
        >
          {sortedTasks.length ? (
            <ul className="flex flex-col gap-2">
              {sortedTasks.map((task) => (
                <VideoTaskRow
                  key={task.id}
                  task={task}
                  theme={theme}
                  nodeTitles={nodeTitles}
                  retrying={retryingIds.has(task.id)}
                  onLocate={onFocusNode}
                  onRetry={handleRetry}
                />
              ))}
            </ul>
          ) : (
            <p className="grid place-items-center p-16 text-sm opacity-55">暂无视频生成任务</p>
          )}
        </div>
      </div>
    </div>
  )
}
