import { useEffect, useState, useMemo } from 'react'
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
import { ShieldAlertIcon, ShieldCheckIcon, ShieldIcon } from 'lucide-react'
import type { ConfirmationRequestPayload } from '@/hooks/use-websocket'

interface ConfirmationDialogProps {
  /** 当前待处理的确认请求队列（为空时关闭） */
  requests: ConfirmationRequestPayload[]
  /** 用户做出选择时触发 */
  onRespond: (id: string, approved: boolean) => void
}

interface RiskMeta {
  label: string
  variant: 'destructive' | 'secondary' | 'default'
  icon: typeof ShieldIcon
}

/** 工具风险等级 */
function getRiskMeta(toolName: string): RiskMeta {
  const dangerous = ['bash', 'shell', 'delete_file', 'web_search']
  const moderate = ['write', 'edit', 'web_fetch']
  if (dangerous.includes(toolName)) {
    return { label: '危险', variant: 'destructive', icon: ShieldAlertIcon }
  }
  if (moderate.includes(toolName)) {
    return { label: '中等', variant: 'secondary', icon: ShieldIcon }
  }
  return { label: '安全', variant: 'default', icon: ShieldCheckIcon }
}

/** 将工具参数格式化为可读字符串 */
function formatArgs(args: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(args)) {
    let str: string
    if (typeof value === 'string') {
      str = value.length > 300 ? `${value.slice(0, 300)}…` : value
    } else {
      try {
        str = JSON.stringify(value)
        if (str.length > 300) str = `${str.slice(0, 300)}…`
      } catch {
        str = String(value)
      }
    }
    lines.push(`${key}: ${str}`)
  }
  return lines.join('\n')
}

export function ConfirmationDialog({ requests, onRespond }: ConfirmationDialogProps): ReactElement | null {
  const [responding, setResponding] = useState(false)

  // 当前显示第一个待确认请求
  const request = requests[0] ?? null
  const queueLength = requests.length
  const open = request !== null

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
  const risk = getRiskMeta(toolName)
  const argsText = request ? formatArgs(request.args) : ''
  const RiskIcon = risk.icon

  const riskColorClass = useMemo(() => {
    switch (risk.variant) {
      case 'destructive': return 'text-destructive'
      case 'secondary': return 'text-amber-500'
      default: return 'text-emerald-500'
    }
  }, [risk.variant])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <RiskIcon className={`size-5 ${riskColorClass}`} />
            <DialogTitle className="text-base">工具执行确认</DialogTitle>
            <Badge variant={risk.variant} className="text-[10px]">{risk.label}</Badge>
            {queueLength > 1 && (
              <Badge variant="outline" className="text-[10px] ml-auto">
                {queueLength} 个待审
              </Badge>
            )}
          </div>
          <DialogDescription className="text-sm">
            Agent 请求执行一个需要确认的工具，请审查后选择批准或拒绝。
          </DialogDescription>
        </DialogHeader>

        {request && (
          <div className="grid gap-3 py-1">
            <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
              <span className="text-xs text-muted-foreground shrink-0">工具</span>
              <code className="text-sm font-mono font-medium">{toolName}</code>
            </div>

            {request.reason && (
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">原因</span>
                <p className="text-sm leading-relaxed m-0">{request.reason}</p>
              </div>
            )}

            {argsText && (
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">参数</span>
                <pre className="bg-muted/50 rounded-md px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto m-0 leading-relaxed">
                  {argsText}
                </pre>
              </div>
            )}

            {risk.variant === 'destructive' && (
              <Alert variant="destructive" className="py-2.5">
                <AlertTitle className="text-sm">危险操作</AlertTitle>
                <AlertDescription className="text-xs">
                  该工具可能执行不可逆的副作用（如运行 shell 命令、删除文件）。请仔细核对参数后再批准。
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleRespond(false)}
            disabled={responding}
          >
            拒绝
          </Button>
          <Button
            size="sm"
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
