import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ConfirmationRequestPayload } from '@/hooks/use-websocket'

interface ConfirmationDialogProps {
  /** 当前待处理的确认请求（为 null 时关闭） */
  request: ConfirmationRequestPayload | null
  /** 用户做出选择时触发 */
  onRespond: (id: string, approved: boolean) => void
}

interface RiskBadgeMeta {
  label: string
  variant: 'destructive' | 'secondary' | 'default'
}

/** 工具风险等级徽章颜色 */
function riskBadgeClass(toolName: string): RiskBadgeMeta {
  const dangerous = ['bash', 'shell', 'delete_file', 'web_search']
  const moderate = ['write', 'edit', 'web_fetch']
  if (dangerous.includes(toolName)) {
    return { label: '危险', variant: 'destructive' }
  }
  if (moderate.includes(toolName)) {
    return { label: '中等', variant: 'secondary' }
  }
  return { label: '安全', variant: 'default' }
}

/** 将工具参数格式化为可读字符串 */
function formatArgs(args: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(args)) {
    let str: string
    if (typeof value === 'string') {
      str = value.length > 200 ? `${value.slice(0, 200)}…` : value
    } else {
      try {
        str = JSON.stringify(value)
        if (str.length > 200) str = `${str.slice(0, 200)}…`
      } catch {
        str = String(value)
      }
    }
    lines.push(`${key}: ${str}`)
  }
  return lines.join('\n')
}

export function ConfirmationDialog({ request, onRespond }: ConfirmationDialogProps): ReactElement | null {
  const open = request !== null
  const [responding, setResponding] = useState(false)

  // 每次新请求到来时重置响应状态
  useEffect(() => {
    if (request) {
      setResponding(false)
    }
  }, [request?.id])

  const handleRespond = (approved: boolean): void => {
    if (!request || responding) return
    setResponding(true)
    onRespond(request.id, approved)
  }

  // ESC 关闭视为拒绝（更安全）
  const handleOpenChange = (next: boolean): void => {
    if (!next && request && !responding) {
      handleRespond(false)
    }
  }

  const toolName = request?.toolName ?? ''
  const risk = riskBadgeClass(toolName)
  const argsText = request ? formatArgs(request.args) : ''

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>工具执行确认</DialogTitle>
            <Badge variant={risk.variant}>{risk.label}</Badge>
          </div>
          <DialogDescription>
            Agent 请求执行一个需要确认的工具。请审查后选择批准或拒绝。
          </DialogDescription>
        </DialogHeader>

        {request && (
          <div className="grid gap-3">
            <div className="grid gap-1">
              <span className="text-subtle text-xs font-[760]">工具</span>
              <code className="bg-surface-2 border border-border rounded-md px-2 py-1 text-sm font-mono break-anywhere">
                {toolName}
              </code>
            </div>

            <div className="grid gap-1">
              <span className="text-subtle text-xs font-[760]">原因</span>
              <p className="text-sm m-0">{request.reason}</p>
            </div>

            {argsText && (
              <div className="grid gap-1">
                <span className="text-subtle text-xs font-[760]">参数</span>
                <pre className="bg-surface-2 border border-border rounded-md px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-anywhere max-h-40 overflow-auto m-0">
                  {argsText}
                </pre>
              </div>
            )}

            {risk.variant === 'destructive' && (
              <Alert variant="destructive">
                <AlertTitle>危险操作</AlertTitle>
                <AlertDescription>
                  该工具可能执行不可逆的副作用（如运行 shell 命令、删除文件、产生 API 费用）。请仔细核对参数后再批准。
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleRespond(false)}
            disabled={responding}
          >
            拒绝
          </Button>
          <Button
            variant={risk.variant === 'destructive' ? 'destructive' : 'default'}
            onClick={() => handleRespond(true)}
            disabled={responding}
          >
            {responding ? '处理中…' : '批准执行'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
