import type { ReactElement } from 'react'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ClockIcon, PlusIcon, PencilIcon, TrashIcon, PlayIcon, PowerIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { getApi, postApi, putApi, deleteApi } from '@/api'

/** Cron 任务类型（与后端一致） */
interface CronJob {
  id: string
  name: string
  agentId: string
  schedule: string
  prompt: string
  enabled: boolean
  lastRunAt: string | null
  lastResult: 'success' | 'error' | null
  timeoutMs: number
  createdAt: string
  lastError?: string | null
}

interface CronJobsResponse {
  jobs: CronJob[]
}

/** 创建/编辑表单数据 */
interface JobFormData {
  name: string
  agentId: string
  schedule: string
  prompt: string
  enabled: boolean
  timeoutMs: number
}

const defaultFormData: JobFormData = {
  name: '',
  agentId: 'default',
  schedule: '0 9 * * *',
  prompt: '',
  enabled: true,
  timeoutMs: 300000,
}

export function CronPage(): ReactElement {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<CronJob | null>(null)
  const [formData, setFormData] = useState<JobFormData>(defaultFormData)
  const [formError, setFormError] = useState<string | null>(null)

  // 查询任务列表
  const jobsQuery = useQuery({
    queryKey: ['cron-jobs'],
    queryFn: () => getApi<CronJobsResponse>('/api/cron/jobs'),
    refetchInterval: 30_000,
  })

  // 创建任务
  const createMutation = useMutation({
    mutationFn: (data: JobFormData) =>
      postApi<CronJob>('/api/cron/jobs', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cron-jobs'] })
      setDialogOpen(false)
    },
  })

  // 更新任务
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<JobFormData> }) =>
      putApi<CronJob>(`/api/cron/jobs/${id}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cron-jobs'] })
      setDialogOpen(false)
    },
  })

  // 删除任务
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteApi<{ removed: boolean }>(`/api/cron/jobs/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cron-jobs'] })
    },
  })

  // 手动触发
  const runMutation = useMutation({
    mutationFn: (id: string) => postApi<{ success: boolean }>(`/api/cron/jobs/${id}/run`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cron-jobs'] })
    },
  })

  // 启用/禁用
  const toggleMutation = useMutation({
    mutationFn: ({ id, enable }: { id: string; enable: boolean }) =>
      postApi<CronJob>(`/api/cron/jobs/${id}/${enable ? 'enable' : 'disable'}`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cron-jobs'] })
    },
  })

  function handleOpenCreate(): void {
    setEditingJob(null)
    setFormData(defaultFormData)
    setFormError(null)
    setDialogOpen(true)
  }

  function handleOpenEdit(job: CronJob): void {
    setEditingJob(job)
    setFormData({
      name: job.name,
      agentId: job.agentId,
      schedule: job.schedule,
      prompt: job.prompt,
      enabled: job.enabled,
      timeoutMs: job.timeoutMs,
    })
    setFormError(null)
    setDialogOpen(true)
  }

  function handleSubmit(): void {
    if (!formData.name.trim()) {
      setFormError('任务名称不能为空')
      return
    }
    if (!formData.schedule.trim()) {
      setFormError('Cron 表达式不能为空')
      return
    }
    if (!formData.prompt.trim()) {
      setFormError('执行 Prompt 不能为空')
      return
    }

    if (editingJob) {
      updateMutation.mutate({ id: editingJob.id, data: formData })
    } else {
      createMutation.mutate(formData)
    }
  }

  function handleDelete(job: CronJob): void {
    if (window.confirm(`确定删除任务 "${job.name}"？`)) {
      deleteMutation.mutate(job.id)
    }
  }

  function handleRun(job: CronJob): void {
    runMutation.mutate(job.id)
  }

  function handleToggle(job: CronJob): void {
    toggleMutation.mutate({ id: job.id, enable: !job.enabled })
  }

  const jobs = jobsQuery.data?.jobs ?? []
  const isSubmitting = createMutation.isPending || updateMutation.isPending

  return (
    <section className="p-6 grid gap-4" aria-label="定时任务">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-subtle text-xs font-[760] m-0">Automation</p>
          <h2 className="text-[22px] font-[780] leading-tight mt-0.5">定时任务</h2>
          <p className="text-xs text-muted-foreground m-0 mt-1">管理 Agent 自动化定时任务</p>
        </div>
        <Button onClick={handleOpenCreate} size="sm">
          <PlusIcon className="size-3.5" />
          创建任务
        </Button>
      </div>

      {/* 任务列表 */}
      {jobsQuery.isLoading && (
        <div className="grid gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-surface-2 border border-border rounded-lg p-3 animate-pulse">
              <div className="h-4 bg-muted/30 rounded w-32 mb-2" />
              <div className="h-3 bg-muted/20 rounded w-48" />
            </div>
          ))}
        </div>
      )}

      {jobsQuery.error && (
        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <p className="text-danger text-xs">
            加载失败: {jobsQuery.error instanceof Error ? jobsQuery.error.message : '未知错误'}
          </p>
        </div>
      )}

      {!jobsQuery.isLoading && jobs.length === 0 && (
        <div className="bg-surface-2 border border-border rounded-lg p-8 grid place-items-center">
          <ClockIcon className="size-8 text-muted-foreground mb-2" />
          <p className="text-muted-foreground text-sm">暂无定时任务</p>
          <Button variant="outline" size="sm" onClick={handleOpenCreate} className="mt-3">
            <PlusIcon className="size-3.5" />
            创建第一个任务
          </Button>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="grid gap-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="bg-surface-2 border border-border rounded-lg p-3 grid gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-[760] truncate">{job.name}</span>
                    <Badge variant={job.enabled ? 'default' : 'secondary'}>
                      {job.enabled ? '已启用' : '已禁用'}
                    </Badge>
                    {job.lastResult && (
                      <Badge variant={job.lastResult === 'success' ? 'default' : 'destructive'}>
                        {job.lastResult === 'success' ? '成功' : '失败'}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <code className="font-mono bg-surface-3 px-1.5 py-0.5 rounded">{job.schedule}</code>
                    <span>Agent: {job.agentId}</span>
                    <span className="tabular-nums">超时: {(job.timeoutMs / 1000).toFixed(0)}s</span>
                  </div>
                  <p className="text-pretty text-xs text-muted-foreground mt-1 line-clamp-2">{job.prompt}</p>
                  <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                    <span>上次执行: {job.lastRunAt ? formatTime(job.lastRunAt) : '未执行'}</span>
                    {job.lastError && (
                      <span className="text-destructive truncate" title={job.lastError}>
                        错误: {job.lastError}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleRun(job)}
                    disabled={runMutation.isPending}
                    title="立即执行"
                  >
                    <PlayIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleToggle(job)}
                    title={job.enabled ? '禁用' : '启用'}
                  >
                    <PowerIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleOpenEdit(job)}
                    title="编辑"
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleDelete(job)}
                    title="删除"
                  >
                    <TrashIcon className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 创建/编辑对话框 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingJob ? '编辑任务' : '创建任务'}</DialogTitle>
            <DialogDescription>
              {editingJob ? '修改定时任务配置' : '创建新的定时任务'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="job-name" className="text-xs">任务名称</Label>
              <Input
                id="job-name"
                value={formData.name}
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="输入任务名称"
              />
            </div>

            <div className="grid gap-1">
              <Label htmlFor="job-schedule" className="text-xs">Cron 表达式</Label>
              <Input
                id="job-schedule"
                value={formData.schedule}
                onChange={(e) => setFormData((prev) => ({ ...prev, schedule: e.target.value }))}
                placeholder="例如：0 9 * * *（每天 9 点）"
              />
              <p className="text-[10px] text-muted-foreground">标准 5 段式：分 时 日 月 周</p>
            </div>

            <div className="grid gap-1">
              <Label htmlFor="job-prompt" className="text-xs">执行 Prompt</Label>
              <textarea
                id="job-prompt"
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm resize-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
                rows={3}
                value={formData.prompt}
                onChange={(e) => setFormData((prev) => ({ ...prev, prompt: e.target.value }))}
                placeholder="输入要执行的 prompt"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label htmlFor="job-agent" className="text-xs">目标 Agent</Label>
                <Input
                  id="job-agent"
                  value={formData.agentId}
                  onChange={(e) => setFormData((prev) => ({ ...prev, agentId: e.target.value }))}
                  placeholder="default"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="job-timeout" className="text-xs">超时（毫秒）</Label>
                <Input
                  id="job-timeout"
                  type="number"
                  value={formData.timeoutMs}
                  onChange={(e) => setFormData((prev) => ({ ...prev, timeoutMs: Number(e.target.value) }))}
                  placeholder="300000"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={formData.enabled}
                onChange={(e) => setFormData((prev) => ({ ...prev, enabled: e.target.checked }))}
                className="size-3.5"
              />
              <span>启用任务</span>
            </label>

            {formError && (
              <p className="text-xs text-destructive">{formError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** 格式化时间 */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  } catch {
    return iso
  }
}
