import { useState, useCallback, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, GitBranch, CircleDot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getApi, putApi } from '../../api'

/** 工作区信息（与后端 workspace.route.ts 对应） */
interface WorkspaceInfo {
  path: string
  name: string
  gitBranch?: string
  gitDirty?: boolean
}

/**
 * 缩短路径显示
 * 例如：/Users/foo/Projects/my-app → ~/Projects/my-app
 * 渲染进程没有 process.env，由后端返回的路径已经过处理
 */
function shortenPath(fullPath: string): string {
  // 渲染进程中无法访问 process.env，直接显示路径最后两级
  const segments = fullPath.replace(/\\/g, '/').split('/')
  if (segments.length >= 3) {
    return '.../' + segments.slice(-2).join('/')
  }
  return fullPath
}

export interface WorkspaceIndicatorProps {
  /** 是否为紧凑模式（状态栏用） */
  compact?: boolean
}

/**
 * WorkspaceIndicator：工作区指示器
 *
 * 显示当前工作区路径、git 分支和状态
 * 点击可打开工作区选择对话框
 */
export function WorkspaceIndicator({ compact = false }: WorkspaceIndicatorProps): ReactElement {
  const queryClient = useQueryClient()
  const [switching, setSwitching] = useState(false)

  const workspaceQuery = useQuery({
    queryKey: ['workspace'],
    queryFn: () => getApi<WorkspaceInfo>('/api/workspace'),
    refetchInterval: 30_000,
  })

  const handleSelectWorkspace = useCallback(async () => {
    if (!window.api?.workspace) return
    setSwitching(true)
    try {
      const result = await window.api.workspace.select()
      if (!result.canceled && result.path) {
        // 通知后端更新工作区
        await putApi<WorkspaceInfo>('/api/workspace', { path: result.path })
        // 同步 Electron 主进程的工作区
        await window.api.workspace.set(result.path)
        // 刷新工作区查询
        void queryClient.invalidateQueries({ queryKey: ['workspace'] })
      }
    } catch {
      // 静默失败
    } finally {
      setSwitching(false)
    }
  }, [queryClient])

  const workspace = workspaceQuery.data

  if (compact) {
    return (
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        onClick={() => void handleSelectWorkspace()}
        disabled={switching}
        aria-label="切换工作区"
      >
        <FolderOpen className="size-3" aria-hidden="true" />
        <span className="truncate max-w-[200px]">
          {workspace ? shortenPath(workspace.path) : '未选择'}
        </span>
        {workspace?.gitBranch && (
          <>
            <GitBranch className="size-3 ml-1" aria-hidden="true" />
            <span>{workspace.gitBranch}</span>
            {workspace.gitDirty && (
              <CircleDot className="size-2.5 text-accent" aria-hidden="true" />
            )}
          </>
        )}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 h-7 px-2 text-xs"
        onClick={() => void handleSelectWorkspace()}
        disabled={switching}
        aria-label="选择工作区"
      >
        <FolderOpen className="size-3.5" aria-hidden="true" />
        <span className="truncate max-w-[240px]">
          {workspace ? shortenPath(workspace.path) : '选择工作区'}
        </span>
      </Button>
      {workspace?.gitBranch && (
        <Badge variant="secondary" className="gap-1 text-[10px] h-5">
          <GitBranch className="size-3" aria-hidden="true" />
          {workspace.gitBranch}
          {workspace.gitDirty && (
            <CircleDot className="size-2.5 text-accent" aria-hidden="true" />
          )}
        </Badge>
      )}
    </div>
  )
}
