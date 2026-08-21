/**
 * DiagnosticsDialog：调用诊断弹窗（日志 / 缓存 / 趋势 / 追踪时间线）
 *
 * 从 novel-workspace 拆出（P2-3b）：Tab 状态由组件内部持有，
 * workspace 只负责开关与上下文（章节号、trace sessionId）。
 */
import { useState, type ReactElement } from 'react'
import { Database, ScrollText, Activity } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AgentLogPanel } from './agent-log-panel'
import { CacheMonitorPanel } from './cache-monitor-panel'
import { ObservabilityTimeline } from './observability-timeline'
import { TraceTimelinePanel } from './trace-timeline-panel'

type DiagnosticsTab = 'logs' | 'cache' | 'trend' | 'trace'

export interface DiagnosticsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 章节号过滤（创作流程章节优先，回退播放头章节，由调用方决定） */
  chapterNumber?: number
  /** 追踪时间线的会话 ID */
  traceSessionId?: string
}

export function DiagnosticsDialog({
  open,
  onOpenChange,
  chapterNumber,
  traceSessionId,
}: DiagnosticsDialogProps): ReactElement {
  const [tab, setTab] = useState<DiagnosticsTab>('logs')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] sm:w-[min(94vw,1200px)] max-w-none sm:max-w-none h-[min(88vh,900px)] max-h-[90vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-4 py-3 border-b border-border shrink-0 max-h-16 overflow-hidden">
          <DialogTitle className="flex items-center gap-2 text-sm truncate">
            <Activity className="size-4 text-primary" />
            调用诊断
          </DialogTitle>
          <DialogDescription className="text-xs text-pretty truncate">
            统一查看 Agent 调用日志、提示词缓存命中与调用趋势
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as DiagnosticsTab)}
          className="min-h-0 flex-1 flex-col gap-0 overflow-hidden h-full"
        >
          <TabsList className="mx-4 mt-3 flex h-auto w-auto shrink-0 gap-1 rounded-lg bg-muted/40 p-1" aria-label="调用诊断视图">
            <TabsTrigger value="logs" className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-border/60 hover:bg-background/60">
              <ScrollText className="size-3.5" />
              调用日志
            </TabsTrigger>
            <TabsTrigger value="cache" className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-border/60 hover:bg-background/60">
              <Database className="size-3.5" />
              缓存诊断
            </TabsTrigger>
            <TabsTrigger value="trend" className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-border/60 hover:bg-background/60">
              <Activity className="size-3.5" />
              调用趋势
            </TabsTrigger>
            <TabsTrigger value="trace" className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-border/60 hover:bg-background/60">
              <Activity className="size-3.5" />
              追踪时间线
            </TabsTrigger>
          </TabsList>
          <TabsContent value="logs" className="mt-3 min-h-0 overflow-hidden flex-1 h-full">
            <AgentLogPanel chapterNumber={chapterNumber} />
          </TabsContent>
          <TabsContent value="cache" className="mt-3 min-h-0 overflow-hidden flex-1 h-full">
            <CacheMonitorPanel chapterNumber={chapterNumber} />
          </TabsContent>
          <TabsContent value="trend" className="mt-3 min-h-0 overflow-hidden flex-1 h-full">
            <ObservabilityTimeline />
          </TabsContent>
          <TabsContent value="trace" className="mt-3 min-h-0 overflow-hidden flex-1 h-full">
            <TraceTimelinePanel
              sessionId={traceSessionId}
              chapterNumber={chapterNumber}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
