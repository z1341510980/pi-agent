import type { ErrorInfo, ReactElement, ReactNode } from 'react'
import { Component } from 'react'
import { AlertTriangleIcon, RefreshCwIcon, HomeIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ── 类型定义 ──

interface ErrorBoundaryProps {
  children: ReactNode
  /** 自定义错误渲染 */
  fallback?: (error: Error, reset: () => void) => ReactNode
  /** 错误回调（用于上报） */
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

// ── 默认错误 UI ──

function DefaultErrorFallback({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}): ReactElement {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 p-8 min-h-[300px] text-center"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangleIcon className="h-7 w-7 text-destructive" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-[780] text-balance">出现错误</h2>
        <p className="text-sm text-muted-foreground max-w-[400px] text-pretty">
          应用遇到了意外错误。你可以尝试重新加载，或返回首页继续操作。
        </p>
      </div>

      <details className="max-w-[500px] w-full">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-text">
          查看错误详情
        </summary>
        <pre className="mt-2 p-3 bg-surface-2 rounded-md text-xs font-mono text-left overflow-auto max-h-[200px] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.06)]">
          <code>{error.message}</code>
          {error.stack && `\n\n${error.stack}`}
        </pre>
      </details>

      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={reset}>
          <RefreshCwIcon className="size-3.5" />
          重试
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            window.location.reload()
          }}
        >
          <HomeIcon className="size-3.5" />
          重新加载页面
        </Button>
      </div>
    </div>
  )
}

// ── ErrorBoundary 组件 ──

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 上报错误（可接入 Sentry / 自定义日志）
    console.error('[ErrorBoundary]', error, info)
    this.props.onError?.(error, info)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    const { children, fallback } = this.props

    if (error) {
      if (fallback) {
        return fallback(error, this.reset)
      }
      return <DefaultErrorFallback error={error} reset={this.reset} />
    }

    return children
  }
}
