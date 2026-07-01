import { useEffect, useState, type ReactElement } from 'react'
import { DownloadIcon, RefreshCwIcon, CheckCircle2Icon, AlertCircleIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * 更新状态（与 preload 暴露的类型保持一致）
 * 这里本地重新声明，避免直接 import preload 模块（preload 在主进程上下文）。
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; info: UpdateInfo }
  | { state: 'not-available' }
  | { state: 'downloading'; progress: ProgressInfo | null }
  | { state: 'downloaded'; info: UpdateInfo }
  | { state: 'error'; message: string }

/** 更新信息 */
export interface UpdateInfo {
  version: string
  releaseDate: string | null
  releaseNotes: string | null
}

/** 下载进度信息 */
export interface ProgressInfo {
  total: number
  delta: number
  transferred: number
  percent: number
  bytesPerSecond: number
}

interface UpdateDialogProps {
  /** 当前更新状态 */
  status: UpdateStatus
  /** 是否显示对话框 */
  open: boolean
  /** 关闭对话框 */
  onOpenChange: (open: boolean) => void
  /** 触发下载 */
  onDownload: () => void
  /** 退出并安装 */
  onInstall: () => void
}

/**
 * 格式化字节大小为可读字符串
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`
}

/**
 * 格式化下载速度
 */
function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '-'
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * 更新对话框
 *
 * 设计参考：docs/FRONTEND_DESIGN_SYSTEM.md §6.5、docs/ARCHITECTURE.md §18
 *
 * 状态流转：
 * - available → 用户点击「立即更新」→ downloading → downloaded → 用户点击「退出并安装」
 * - 任意阶段出错 → 显示错误提示
 *
 * 该组件为受控组件，由父组件管理 open 状态和 status。
 */
export function UpdateDialog({
  status,
  open,
  onOpenChange,
  onDownload,
  onInstall,
}: UpdateDialogProps): ReactElement | null {
  const isAvailable = status.state === 'available' || status.state === 'downloaded'
  const isDownloading = status.state === 'downloading'
  const isDownloaded = status.state === 'downloaded'
  const isError = status.state === 'error'

  // 当前版本信息（available 或 downloaded 状态都有 info）
  const info = status.state === 'available' || status.state === 'downloaded' ? status.info : null

  // 下载进度百分比（0-100）
  const percent = status.state === 'downloading' && status.progress ? status.progress.percent : 0
  const transferred = status.state === 'downloading' && status.progress ? status.progress.transferred : 0
  const total = status.state === 'downloading' && status.progress ? status.progress.total : 0
  const speed = status.state === 'downloading' && status.progress ? status.progress.bytesPerSecond : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!isDownloading} className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>发现新版本</DialogTitle>
            {info && (
              <Badge variant="secondary">v{info.version}</Badge>
            )}
          </div>
          <DialogDescription>
            PI Agent 有新版本可用，建议立即更新以获取最新功能与修复。
          </DialogDescription>
        </DialogHeader>

        {/* 更新日志 */}
        {info?.releaseNotes && (
          <div className="grid gap-1 max-h-48 overflow-auto">
            <span className="text-subtle text-xs font-[760]">更新日志</span>
            <pre className="bg-surface-2 rounded-md px-2.5 py-2 text-xs font-mono whitespace-pre-wrap break-anywhere m-0 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.06)]">
              {info.releaseNotes}
            </pre>
          </div>
        )}

        {/* 下载进度 */}
        {isDownloading && (
          <div className="grid gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">下载中…</span>
              <span className="font-mono text-text tabular-nums">{percent.toFixed(1)}%</span>
            </div>
            <div
              className="h-2 w-full rounded-full bg-surface-2 overflow-hidden"
              role="progressbar"
              aria-valuenow={Math.round(percent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full bg-accent transition-[width] duration-150 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono tabular-nums">
              <span>{formatBytes(transferred)} / {formatBytes(total)}</span>
              <span>{formatSpeed(speed)}</span>
            </div>
          </div>
        )}

        {/* 下载完成提示 */}
        {isDownloaded && (
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>下载完成</AlertTitle>
            <AlertDescription>
              点击「退出并安装」将关闭应用并安装更新。未保存的会话将丢失。
            </AlertDescription>
          </Alert>
        )}

        {/* 错误提示 */}
        {isError && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>更新失败</AlertTitle>
            <AlertDescription>{status.message}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          {/* 下载中：禁用所有按钮 */}
          {isDownloading && (
            <Button variant="outline" disabled>
              <RefreshCwIcon className="size-3.5 animate-spin" />
              下载中…
            </Button>
          )}

          {/* 已下载：退出并安装 */}
          {isDownloaded && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                稍后安装
              </Button>
              <Button onClick={onInstall}>
                <DownloadIcon className="size-3.5" />
                退出并安装
              </Button>
            </>
          )}

          {/* 有更新可用：立即更新 / 稍后提醒 */}
          {isAvailable && !isDownloaded && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                稍后提醒
              </Button>
              <Button onClick={onDownload}>
                <DownloadIcon className="size-3.5" />
                立即更新
              </Button>
            </>
          )}

          {/* 错误：关闭 */}
          {isError && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * useUpdateStatus Hook
 *
 * 订阅主进程的更新状态变化，并暴露检查/下载/安装方法。
 *
 * @returns 更新状态和操作方法
 */
export function useUpdateStatus(): {
  status: UpdateStatus
  check: () => Promise<UpdateStatus>
  download: () => Promise<void>
  install: () => Promise<void>
} {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    // window.api 由 preload 通过 contextBridge 暴露
    const api = window.api
    if (!api?.updater) {
      // 在非 Electron 环境（如 vitest）下，api 可能不存在
      return
    }
    const unsubscribe = api.updater.onStatus((next) => {
      setStatus(next)
    })
    return () => {
      unsubscribe()
    }
  }, [])

  const check = async (): Promise<UpdateStatus> => {
    const api = window.api
    if (!api?.updater) {
      const fallback: UpdateStatus = { state: 'not-available' }
      setStatus(fallback)
      return fallback
    }
    const result = await api.updater.check()
    setStatus(result)
    return result
  }

  const download = async (): Promise<void> => {
    const api = window.api
    if (!api?.updater) return
    await api.updater.download()
  }

  const install = async (): Promise<void> => {
    const api = window.api
    if (!api?.updater) return
    await api.updater.install()
  }

  return { status, check, download, install }
}
