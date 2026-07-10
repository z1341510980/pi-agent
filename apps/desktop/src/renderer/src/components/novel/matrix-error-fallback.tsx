import type { ReactElement } from 'react'
import { AlertTriangle, RotateCcw, LayoutGrid } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface MatrixErrorFallbackProps {
  error: Error
  reset: () => void
  onSwitchToCanvas: () => void
}

export function MatrixErrorFallback({
  error,
  reset,
  onSwitchToCanvas,
}: MatrixErrorFallbackProps): ReactElement {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 p-6 h-full min-h-[300px] text-center bg-muted/30"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">矩阵视图崩溃</h3>
        <p className="text-xs text-muted-foreground max-w-[360px]">
          矩阵交互发生异常。可重置此区域、切换到画布视图，或查看错误详情。
        </p>
      </div>
      <details className="max-w-[440px] w-full">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-text">
          查看错误详情
        </summary>
        <pre className="mt-2 p-3 bg-surface-2 rounded-md text-xs font-mono text-left overflow-auto max-h-[160px]">
          <code>{error.message}</code>
          {error.stack && `\n\n${error.stack}`}
        </pre>
      </details>
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={reset}>
          <RotateCcw className="size-3.5" />
          重置矩阵
        </Button>
        <Button variant="outline" size="sm" onClick={onSwitchToCanvas}>
          <LayoutGrid className="size-3.5" />
          切换到画布
        </Button>
      </div>
    </div>
  )
}
