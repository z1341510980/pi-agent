import { AlertCircle, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface ErrorCardProps {
  message: string
  onRetry?: () => void
  onDismiss?: () => void
}

/**
 * ErrorCard：错误卡片
 *
 * RUN_ERROR 或网络错误时显示，提供重试和关闭按钮
 */
export function ErrorCard({ message, onRetry, onDismiss }: ErrorCardProps) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-destructive">{message}</p>
        {onRetry && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRetry}
            className="mt-2 h-7 text-xs text-destructive hover:bg-destructive/20"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            重试
          </Button>
        )}
      </div>
      {onDismiss && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          className="h-7 w-7 shrink-0 p-0 text-destructive hover:bg-destructive/20"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}
