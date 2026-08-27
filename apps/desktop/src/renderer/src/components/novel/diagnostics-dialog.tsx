/**
 * DiagnosticsDialog：调用诊断弹窗（调用轨迹 / 缓存诊断）
 *
 * 参考 deepseek-harness 的 TrajectoryView 架构：原来四个独立 Tab
 * （调用日志 / 缓存诊断 / 调用趋势 / 追踪时间线）有大量功能重叠——
 * 趋势是调用日志的聚合视图，追踪时间线是同批调用的事件级视角。
 * 现在合并为两层：
 * 1. 调用轨迹：顶部 ObservabilityTimeline 趋势条 + 下方 AgentLogPanel 记录表
 * 2. 缓存诊断：CacheMonitorPanel（颗粒度不同——缓存层稳定性，非单条调用）
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

type DiagnosticsTab = 'trajectory' | 'cache'

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
  traceSessionId: _traceSessionId,
}: DiagnosticsDialogProps): ReactElement {
  const [tab, setTab] = useState<DiagnosticsTab>('trajectory')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] sm:w-[min(94vw,1200px)] max-w-none sm:max-w-none h-[min(88vh,900px)] max-h-[90vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-4 py-3 border-b border-border shrink-0 max-h-16 overflow-hidden">
          <DialogTitle className="flex items-center gap-2 text-sm truncate">
            <Activity className="size-4 text-primary" />
            调用诊断
          </DialogTitle>
          <DialogDescription className="text-xs text-pretty truncate">
            Agent 调用轨迹（趋势 + 记录）与提示词缓存诊断
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as DiagnosticsTab)}
          className="min-h-0 flex-1 flex-col gap-0 overflow-hidden h-full"
        >
          <TabsList className="mx-4 mt-3 flex h-auto w-auto shrink-0 gap-1 rounded-lg bg-muted/40 p-1" aria-label="调用诊断视图">
            <TabsTrigger value="trajectory" className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-border/60 hover:bg-background/60">
              <ScrollText className="size-3.5" />
              调用轨迹
            </TabsTrigger>
            <TabsTrigger value="cache" className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-border/60 hover:bg-background/60">
              <Database className="size-3.5" />
              缓存诊断
            </TabsTrigger>
          </TabsList>
          <TabsContent value="trajectory" className="mt-3 min-h-0 overflow-hidden flex-1 h-full flex flex-col gap-0">
            {/* 趋势条：对齐 harness TrajectoryTimeline——调用日志的聚合视图 */}
            <div className="shrink-0 max-h-28 overflow-hidden border-b border-border">
              <ObservabilityTimeline compact />
            </div>
            {/* 记录表：对齐 harness TrajectoryTable——展开可见单条调用的输入/输出/缓存指标 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <AgentLogPanel chapterNumber={chapterNumber} />
            </div>
          </TabsContent>
          <TabsContent value="cache" className="mt-3 min-h-0 overflow-hidden flex-1 h-full">
            <CacheMonitorPanel chapterNumber={chapterNumber} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
