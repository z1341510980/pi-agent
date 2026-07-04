import type { ReactElement } from 'react'
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface CreationErrorFallbackProps {
  error: Error
  reset: () => void
  onDiscardCreation: () => void
}

export function CreationErrorFallback({
  error,
  reset,
  onDiscardCreation,
}: CreationErrorFallbackProps): ReactElement {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 p-6 h-full min-h-[240px] text-center bg-muted/30"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">创作面板出错</h3>
        <p className="text-xs text-muted-foreground max-w-[320px]">
          创作流程发生异常。可重置面板、丢弃本次创作，或查看错误详情。
        </p>
      </div>
      <details className="max-w-[420px] w-full">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-text">
          查看错误详情
        </summary>
        <pre className="mt-2 p-3 bg-surface-2 rounded-md text-xs font-mono text-left overflow-auto max-h-[140px]">
          <code>{error.message}</code>
          {error.stack && `\n\n${error.stack}`}
        </pre>
      </details>
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={reset}>
          <RotateCcw className="size-3.5" />
          重置面板
        </Button>
        <Button variant="outline" size="sm" onClick={onDiscardCreation}>
          <Trash2 className="size-3.5" />
          丢弃创作
        </Button>
      </div>
    </div>
  )
}
