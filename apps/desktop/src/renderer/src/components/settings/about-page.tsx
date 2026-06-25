import type { ReactElement } from 'react'
import { useState } from 'react'
import { ExternalLinkIcon, RefreshCwIcon, CheckCircleIcon, AlertCircleIcon } from 'lucide-react'
import { browserConfig } from '@repo/config/browser'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { UpdateDialog, useUpdateStatus } from '@/components/overlays/update-dialog'

type UpdateState = 'idle' | 'checking' | 'no-update' | 'has-update' | 'error'

const techStack = [
  { label: '前端框架', value: 'React 19 + TypeScript' },
  { label: 'UI 组件', value: 'shadcn/ui + Tailwind v4' },
  { label: '桌面框架', value: 'Electron 39' },
  { label: '状态管理', value: 'TanStack Query + useState' },
  { label: '构建工具', value: 'Vite + electron-vite' },
  { label: '后端', value: 'Fastify + Pi SDK' }
]

export function AboutPage(): ReactElement {
  const [updateState, setUpdateState] = useState<UpdateState>('idle')
  const [dialogOpen, setDialogOpen] = useState(false)
  const { status, check, download, install } = useUpdateStatus()

  async function handleCheckUpdate(): Promise<void> {
    setUpdateState('checking')
    try {
      // check() 返回最新状态，避免依赖异步 setState
      const result = await check()
      if (result.state === 'available' || result.state === 'downloaded') {
        setUpdateState('has-update')
        setDialogOpen(true)
      } else if (result.state === 'error') {
        setUpdateState('error')
      } else {
        setUpdateState('no-update')
      }
    } catch (err) {
      setUpdateState('error')
      console.error('[about-page] 检查更新失败:', err)
    }
  }

  return (
    <section className="p-6 grid gap-5" aria-label="关于">
      <div>
        <p className="text-subtle text-xs font-[760] m-0">About</p>
        <h2 className="text-[22px] font-[780] leading-tight mt-0.5">关于</h2>
      </div>

      {/* ── 应用信息 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 flex items-center gap-4">
        <div className="size-12 rounded-xl bg-accent text-accent-foreground flex items-center justify-center text-2xl font-extrabold shrink-0">
          π
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-[780]">{browserConfig.appName}</span>
            <Badge variant="secondary">v1.0.0</Badge>
          </div>
          <p className="text-xs text-muted-foreground m-0 mt-0.5">
            基于 Pi SDK 的 AG-UI 桌面 Agent 助手
          </p>
        </div>
      </div>

      {/* ── 技术栈 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2.5">
        <p className="text-subtle text-xs font-[760] m-0">技术栈</p>
        <dl className="grid gap-1.5 m-0">
          {techStack.map((item) => (
            <div key={item.label} className="flex items-center justify-between gap-3 text-sm">
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className="font-mono text-xs text-text m-0">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* ── GitHub 链接 ── */}
      {browserConfig.repositoryUrl && (
      <div className="bg-surface-2 border border-border rounded-lg p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-[760] m-0">源代码</p>
          <p className="text-xs text-muted-foreground m-0 mt-0.5">在 GitHub 上查看项目源码</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          asChild
        >
          <a
            href={browserConfig.repositoryUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub 仓库"
          >
            <ExternalLinkIcon className="size-3.5" />
            GitHub
          </a>
        </Button>
      </div>
      )}

      {/* ── 检查更新 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-[760] m-0">检查更新</p>
          {updateState === 'no-update' && (
            <p className="text-xs text-success flex items-center gap-1.5 m-0 mt-0.5">
              <CheckCircleIcon className="size-3.5" />
              暂无更新
            </p>
          )}
          {updateState === 'error' && (
            <p className="text-xs text-danger flex items-center gap-1.5 m-0 mt-0.5">
              <AlertCircleIcon className="size-3.5" />
              检查更新失败
            </p>
          )}
          {updateState === 'has-update' && (
            <p className="text-xs text-accent flex items-center gap-1.5 m-0 mt-0.5">
              <AlertCircleIcon className="size-3.5" />
              发现新版本
            </p>
          )}
          {(updateState === 'idle' || updateState === 'checking') && (
            <p className="text-xs text-muted-foreground m-0 mt-0.5">检查是否有新版本可用</p>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleCheckUpdate()}
          disabled={updateState === 'checking'}
        >
          <RefreshCwIcon className={`size-3.5 ${updateState === 'checking' ? 'animate-spin' : ''}`} />
          {updateState === 'checking' ? '检查中...' : '检查更新'}
        </Button>
      </div>

      {/* ── 更新对话框 ── */}
      <UpdateDialog
        status={status}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onDownload={() => void download()}
        onInstall={() => void install()}
      />
    </section>
  )
}
