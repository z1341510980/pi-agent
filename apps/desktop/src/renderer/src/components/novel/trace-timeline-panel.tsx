/**
 * 追踪时间线面板
 *
 * 展示 Tracer 记录的完整调用链：
 * - 每个 run 作为一个时间线分组
 * - 显示事件类型、耗时、输入/输出
 * - 支持折叠/展开事件详情
 *
 * 数据来源：GET /api/traces/session/:sessionId
 */

import { useQuery } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Wrench,
  MessageSquare,
  Brain,
  Zap,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Hash,
  FileText,
  Activity,
  Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { browserConfig as config } from '@repo/config/browser'

// ── 类型定义 ──

interface TraceEvent {
  seq: number
  type:
    | 'run_started'
    | 'run_finished'
    | 'run_error'
    | 'user_message'
    | 'assistant_message'
    | 'tool_call'
    | 'tool_result'
    | 'llm_request'
    | 'llm_response'
    | 'reasoning'
    | 'subagent_start'
    | 'subagent_finish'
    | 'compaction'
  time: number
  status: 'pending' | 'completed' | 'failed' | 'cancelled'
  data: Record<string, unknown>
  parentSeq?: number
  sourceEventSeqs?: number[]
  spanId?: string
  metadata?: Record<string, unknown>
}

interface TraceSummary {
  id: string
  runId: string
  startedAt: number
  status: 'running' | 'completed' | 'failed' | 'aborted'
  eventCount: number
  metadata?: Record<string, unknown>
}

interface TracesResponse {
  sessionId: string
  count: number
  traces: TraceSummary[]
}

interface TraceDetailResponse {
  id: string
  sessionId: string
  runId: string
  startedAt: number
  endedAt?: number
  status: string
  eventCount: number
  events: TraceEvent[]
}

interface SurfaceResponse {
  traceId: string
  nodes: number[]
  replacements: Array<{ seq: number; shadowedSeqs: number[] }>
  surfaceEvents: TraceEvent[]
}

interface TraceEventResponse {
  target: TraceEvent
  replacedBy?: number
  replacementChain: number[]
  replacedEventSeqs: number[]
  sourceEventSeqs: number[]
  derivedEventSeqs: number[]
}

// ── 工具函数 ──

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}



function formatRelativeTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 0) return formatTime(ts)
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  return formatTime(ts)
}

function getEventIcon(type: TraceEvent['type']) {
  switch (type) {
    case 'run_started':
      return <Activity className="size-3.5 text-blue-500" />
    case 'run_finished':
      return <CheckCircle2 className="size-3.5 text-emerald-500" />
    case 'run_error':
      return <XCircle className="size-3.5 text-red-500" />
    case 'user_message':
      return <MessageSquare className="size-3.5 text-indigo-400" />
    case 'assistant_message':
      return <MessageSquare className="size-3.5 text-emerald-400" />
    case 'tool_call':
      return <Wrench className="size-3.5 text-amber-500" />
    case 'tool_result':
      return <CheckCircle2 className="size-3.5 text-amber-400" />
    case 'llm_request':
      return <Brain className="size-3.5 text-purple-500" />
    case 'llm_response':
      return <Brain className="size-3.5 text-purple-400" />
    case 'reasoning':
      return <Zap className="size-3.5 text-violet-400" />
    default:
      return <Hash className="size-3.5 text-muted-foreground" />
  }
}

function getEventLabel(type: TraceEvent['type']): string {
  const map: Record<TraceEvent['type'], string> = {
    run_started: '运行开始',
    run_finished: '运行完成',
    run_error: '运行错误',
    user_message: '用户消息',
    assistant_message: '助手回复',
    tool_call: '工具调用',
    tool_result: '工具结果',
    llm_request: 'LLM 请求',
    llm_response: 'LLM 响应',
    reasoning: '推理过程',
    subagent_start: '子 Agent 启动',
    subagent_finish: '子 Agent 完成',
    compaction: '上下文压缩',
  }
  return map[type] || type
}

function getStatusBadge(status: TraceEvent['status']) {
  const map: Record<TraceEvent['status'], { label: string; className: string }> = {
    pending: { label: '等待', className: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/40' },
    completed: { label: '完成', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40' },
    failed: { label: '失败', className: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40' },
    cancelled: { label: '取消', className: 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/40' },
  }
  return map[status] || map.pending
}

// ── API 调用 ──

async function fetchSessionTraces(sessionId: string): Promise<TracesResponse> {
  const res = await fetch(`${config.apiBaseUrl}/api/traces/session/${encodeURIComponent(sessionId)}`)
  if (!res.ok) throw new Error(`Failed to fetch traces: ${res.status}`)
  return res.json()
}

async function fetchTraceDetail(traceId: string): Promise<TraceDetailResponse> {
  const res = await fetch(`${config.apiBaseUrl}/api/traces/${encodeURIComponent(traceId)}/events?limit=500`)
  if (!res.ok) throw new Error(`Failed to fetch trace detail: ${res.status}`)
  return res.json()
}

async function fetchSurface(traceId: string): Promise<SurfaceResponse> {
  const res = await fetch(`${config.apiBaseUrl}/api/traces/${encodeURIComponent(traceId)}/surface`)
  if (!res.ok) throw new Error(`Failed to fetch surface: ${res.status}`)
  return res.json()
}

async function fetchTraceEvent(traceId: string, seq: number): Promise<TraceEventResponse> {
  const res = await fetch(`${config.apiBaseUrl}/api/traces/${encodeURIComponent(traceId)}/trace-event/${seq}`)
  if (!res.ok) throw new Error(`Failed to fetch trace event: ${res.status}`)
  return res.json()
}

// ── 子组件：单个事件卡片 ──

function EventCard({ event, index, traceId, surfaceNode }: { event: TraceEvent; index: number; traceId?: string; surfaceNode?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyData, setHistoryData] = useState<TraceEventResponse | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const icon = getEventIcon(event.type)
  const label = getEventLabel(event.type)
  const statusBadge = getStatusBadge(event.status)

  const hasData = event.data && Object.keys(event.data).length > 0
  const hasSources = event.sourceEventSeqs && event.sourceEventSeqs.length > 0
  const canTraceHistory = traceId && (hasSources || event.sourceEventSeqs)

  const loadHistory = async () => {
    if (!traceId) return
    if (historyData) {
      setHistoryOpen(!historyOpen)
      return
    }
    setHistoryLoading(true)
    try {
      const data = await fetchTraceEvent(traceId, event.seq)
      setHistoryData(data)
      setHistoryOpen(true)
    } catch (err) {
      console.error('Failed to fetch trace event:', err)
    } finally {
      setHistoryLoading(false)
    }
  }

  return (
    <div
      className={cn(
        'relative rounded-md border border-border/60 transition-colors',
        'hover:bg-surface-1',
        index % 2 === 0 && 'bg-surface-1/30',
        surfaceNode && 'border-l-2 border-l-primary/40 bg-primary/5'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className="text-[10px] font-mono text-hint w-8 shrink-0 tabular-nums">
          #{event.seq}
        </span>
        <span className="shrink-0">{icon}</span>
        <span className="text-xs font-medium text-text flex-1">{label}</span>
        {surfaceNode && (
          <span className="text-[9px] text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded">表面</span>
        )}
        <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-4', statusBadge.className)}>
          {statusBadge.label}
        </Badge>
        {event.parentSeq !== undefined && (
          <span className="text-[10px] text-hint font-mono">parent: #{event.parentSeq}</span>
        )}
        {hasSources && (
          <span className="text-[10px] text-hint font-mono">
            sources: #{event.sourceEventSeqs?.join(', #')}
          </span>
        )}
        <span className="text-[10px] text-hint font-mono tabular-nums shrink-0">
          {formatTime(event.time)}
        </span>
        {canTraceHistory && (
          <button
            onClick={(e) => { e.stopPropagation(); loadHistory() }}
            className="text-[10px] text-primary hover:underline flex items-center gap-0.5 shrink-0"
            title="查看历史版本"
          >
            <Clock className="size-3" />
            {historyLoading ? <Loader2 className="size-3 animate-spin" /> : '历史'}
          </button>
        )}
        <ChevronDown className={cn(
          'size-3 text-hint transition-transform shrink-0',
          expanded && 'rotate-180'
        )} />
      </div>

      {expanded && (
        <div className="border-t border-border/60 px-3 py-2 space-y-2">
          {hasData && (
            <div>
              <div className="text-[10px] font-medium text-hint mb-0.5">数据</div>
              <pre className="text-[10px] font-mono bg-muted/30 rounded p-2 overflow-auto max-h-32 text-text/80">
                {JSON.stringify(event.data, null, 2)}
              </pre>
            </div>
          )}
          {event.spanId && (
            <div className="text-[10px] text-hint">
              <span className="font-medium">Span ID:</span> {event.spanId}
            </div>
          )}
          {event.metadata && Object.keys(event.metadata).length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-hint mb-0.5">元数据</div>
              <pre className="text-[10px] font-mono bg-muted/30 rounded p-2 overflow-auto max-h-20 text-text/60">
                {JSON.stringify(event.metadata, null, 2)}
              </pre>
            </div>
          )}
          {/* 历史版本信息 */}
          {historyOpen && historyData && (
            <div className="mt-2 pt-2 border-t border-border/60">
              <div className="text-[10px] font-medium text-text mb-1.5">📜 版本历史</div>
              <div className="space-y-1 text-[10px] text-hint">
                {historyData.replacedBy !== undefined && (
                  <div>被替换为: <span className="text-text font-mono">#{historyData.replacedBy}</span></div>
                )}
                {historyData.replacementChain.length > 0 && (
                  <div>替换链: <span className="text-text font-mono">#{historyData.replacementChain.join(' → #')}</span></div>
                )}
                {historyData.sourceEventSeqs.length > 0 && (
                  <div>来源事件: <span className="text-text font-mono">#{historyData.sourceEventSeqs.join(', #')}</span></div>
                )}
                {historyData.derivedEventSeqs.length > 0 && (
                  <div>派生事件: <span className="text-text font-mono">#{historyData.derivedEventSeqs.join(', #')}</span></div>
                )}
                {historyData.replacedEventSeqs.length > 0 && (
                  <div>被替换事件: <span className="text-text font-mono">#{historyData.replacedEventSeqs.join(', #')}</span></div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 导出追踪报告 ──

function exportTraceReport(
  trace: TraceSummary,
  detail: TraceDetailResponse | null,
  surfaceData: SurfaceResponse | null
): void {
  if (!detail) return

  const now = new Date().toLocaleString()
  const events = detail.events
  const surfaceNodes = new Set(surfaceData?.nodes ?? [])

  // 统计信息
  const totalEvents = events.length
  const surfaceCount = surfaceNodes.size
  const statusCounts = events.reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + 1
    return acc
  }, {} as Record<string, number>)



  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>追踪报告 - ${trace.id}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f6f8fa;
      color: #1f2937;
      padding: 40px 20px;
      line-height: 1.6;
    }
    .container { max-width: 1200px; margin: 0 auto; background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); padding: 32px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 12px; }
    h1 small { font-size: 14px; font-weight: 400; color: #6b7280; }
    .meta { display: flex; flex-wrap: wrap; gap: 16px 32px; margin: 16px 0 24px; padding: 16px 0; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #4b5563; }
    .meta-item { display: flex; align-items: center; gap: 6px; }
    .meta-item strong { color: #1f2937; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; background: #f9fafb; border-radius: 10px; padding: 16px; }
    .stat { text-align: center; }
    .stat .number { font-size: 22px; font-weight: 700; color: #1f2937; }
    .stat .label { font-size: 12px; color: #6b7280; }
    .section-title { font-size: 16px; font-weight: 600; margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #e5e7eb; }
    .event-list { display: flex; flex-direction: column; gap: 4px; }
    .event-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      background: #fafafa;
      border-left: 3px solid #d1d5db;
      transition: background 0.1s;
    }
    .event-item:hover { background: #f3f4f6; }
    .event-item .seq { font-family: monospace; font-size: 11px; color: #9ca3af; width: 36px; flex-shrink: 0; text-align: right; }
    .event-item .type { font-weight: 500; min-width: 70px; flex-shrink: 0; }
    .event-item .status { font-size: 11px; padding: 0 8px; border-radius: 10px; background: #e5e7eb; color: #4b5563; flex-shrink: 0; }
    .event-item .status.completed { background: #d1fae5; color: #065f46; }
    .event-item .status.failed { background: #fee2e2; color: #991b1b; }
    .event-item .status.pending { background: #fef3c7; color: #92400e; }
    .event-item .surface-badge { font-size: 10px; padding: 0 6px; border-radius: 10px; background: #dbeafe; color: #1e40af; flex-shrink: 0; }
    .event-item .time { font-size: 11px; color: #9ca3af; margin-left: auto; flex-shrink: 0; }
    .event-item .data-preview { font-family: monospace; font-size: 11px; color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
    .event-item .sources { font-size: 10px; color: #9ca3af; font-family: monospace; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; text-align: center; }
    .badge { font-size: 11px; padding: 2px 10px; border-radius: 12px; background: #e5e7eb; color: #4b5563; }
    .badge-surface { background: #dbeafe; color: #1e40af; }
    @media (max-width: 640px) {
      .container { padding: 16px; }
      .event-item { flex-wrap: wrap; }
      .event-item .data-preview { max-width: 100px; }
    }
  </style>
</head>
<body>
<div class="container">
  <h1>
    📊 追踪报告
    <small>${trace.id.slice(0, 8)}…${trace.id.slice(-6)}</small>
  </h1>

  <div class="meta">
    <span class="meta-item"><strong>状态</strong> ${trace.status}</span>
    <span class="meta-item"><strong>运行 ID</strong> ${trace.runId}</span>
    <span class="meta-item"><strong>事件数</strong> ${totalEvents}</span>
    <span class="meta-item"><strong>表面事件</strong> ${surfaceCount}</span>
    <span class="meta-item"><strong>开始时间</strong> ${new Date(trace.startedAt).toLocaleString()}</span>
    <span class="meta-item"><strong>导出时间</strong> ${now}</span>
  </div>

  <div class="stats">
    <div class="stat"><div class="number">${totalEvents}</div><div class="label">总事件</div></div>
    <div class="stat"><div class="number">${surfaceCount}</div><div class="label">表面事件</div></div>
    <div class="stat"><div class="number">${statusCounts.completed || 0}</div><div class="label">✅ 成功</div></div>
    <div class="stat"><div class="number">${statusCounts.failed || 0}</div><div class="label">❌ 失败</div></div>
    <div class="stat"><div class="number">${statusCounts.pending || 0}</div><div class="label">⏳ 等待</div></div>
  </div>

  <div class="section-title">📋 事件列表</div>
  <div class="event-list">
    ${events.map((e) => {
      const isSurface = surfaceNodes.has(e.seq)
      const statusClass = e.status === 'completed' ? 'completed' : e.status === 'failed' ? 'failed' : e.status === 'pending' ? 'pending' : ''
      const dataStr = e.data && Object.keys(e.data).length > 0 ? JSON.stringify(e.data).slice(0, 80) : ''
      const sourcesStr = e.sourceEventSeqs && e.sourceEventSeqs.length > 0 ? `sources: #${e.sourceEventSeqs.join(', #')}` : ''
      return `
    <div class="event-item">
      <span class="seq">#${e.seq}</span>
      <span class="type">${getEventLabel(e.type)}</span>
      <span class="status ${statusClass}">${e.status}</span>
      ${isSurface ? '<span class="surface-badge">表面</span>' : ''}
      ${dataStr ? `<span class="data-preview" title="${encodeURIComponent(JSON.stringify(e.data, null, 2))}">${dataStr}</span>` : ''}
      ${sourcesStr ? `<span class="sources">${sourcesStr}</span>` : ''}
      <span class="time">${formatTime(e.time)}</span>
    </div>
  `}).join('')}
  </div>

  <div class="footer">
    由 pi-agent 追踪系统生成 · ${now}
  </div>
</div>
</body>
</html>`

  // 触发下载
  const blob = new Blob([html], { type: 'text/html; charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `trace-report-${trace.id.slice(0, 8)}-${Date.now()}.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── 子组件：单个 Trace 分组 ──

function TraceGroup({ trace }: { trace: TraceSummary }) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [surfaceMode, setSurfaceMode] = useState<'all' | 'surface'>('all')
  const [surfaceData, setSurfaceData] = useState<SurfaceResponse | null>(null)

  const toggleExpand = async () => {
    if (!expanded) {
      setLoading(true)
      try {
        const data = await fetchTraceDetail(trace.id)
        setDetail(data)
        // 预加载表面数据
        try {
          const surface = await fetchSurface(trace.id)
          setSurfaceData(surface)
        } catch (err) {
          console.error('Failed to load surface:', err)
        }
      } catch (err) {
        console.error('Failed to load trace detail:', err)
      } finally {
        setLoading(false)
      }
    }
    setExpanded(!expanded)
  }

  const statusColor = trace.status === 'completed' ? 'text-emerald-500' :
    trace.status === 'failed' ? 'text-red-500' :
    trace.status === 'aborted' ? 'text-amber-500' :
    'text-blue-500'

  const statusLabel = trace.status === 'completed' ? '成功' :
    trace.status === 'failed' ? '失败' :
    trace.status === 'aborted' ? '已中断' :
    '运行中'

  // 获取当前显示的事件列表
  const getDisplayEvents = (): TraceEvent[] => {
    if (!detail) return []
    if (surfaceMode === 'surface' && surfaceData) {
      const surfaceSet = new Set(surfaceData.nodes)
      return detail.events.filter((e) => surfaceSet.has(e.seq))
    }
    return detail.events
  }

  const displayEvents = getDisplayEvents()
  const isSurfaceMode = surfaceMode === 'surface'
  const surfaceNodeCount = surfaceData?.nodes?.length ?? 0

  return (
    <div className="rounded-lg border border-border bg-surface-1 overflow-hidden">
      {/* 分组标题 */}
      <button
        onClick={toggleExpand}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <ChevronRight className={cn(
          'size-4 text-hint transition-transform shrink-0',
          expanded && 'rotate-90'
        )} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text truncate">
              {typeof trace.metadata?.agentName === 'string'
                ? trace.metadata.agentName
                : `${trace.id.slice(0, 8)}…${trace.id.slice(-6)}`}
            </span>
            <span className={cn('text-[10px] font-medium', statusColor)}>
              ● {statusLabel}
            </span>
            {isSurfaceMode && surfaceData && (
              <span className="text-[10px] text-hint ml-1">
                (表面 {surfaceNodeCount}/{detail?.events?.length ?? 0})
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[10px] text-hint mt-0.5">
            <span>Run: {trace.runId.slice(0, 12)}…</span>
            <span>{trace.eventCount} 个事件</span>
            <span>{formatRelativeTime(trace.startedAt)}</span>
          </div>
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-hint" />}
      </button>

      {/* 工具栏：表面/全部切换 */}
      {expanded && detail && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-surface-1/50">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSurfaceMode('all')}
              className={cn(
                'text-[10px] px-2 py-0.5 rounded transition-colors',
                surfaceMode === 'all'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-hint hover:text-text hover:bg-muted/30'
              )}
            >
              全部
            </button>
            <button
              onClick={() => setSurfaceMode('surface')}
              className={cn(
                'text-[10px] px-2 py-0.5 rounded transition-colors',
                surfaceMode === 'surface'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-hint hover:text-text hover:bg-muted/30'
              )}
            >
              表面视图
            </button>
            {surfaceMode === 'surface' && surfaceData && (
              <span className="text-[9px] text-hint ml-1">
                显示 {surfaceNodeCount}/{detail.events.length} 个当前可见事件
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {surfaceData && surfaceData.replacements.length > 0 && (
              <span className="text-[9px] text-hint">
                {surfaceData.replacements.length} 个替换
              </span>
            )}
            <button
              onClick={() => exportTraceReport(trace, detail, surfaceData)}
              className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
              title="导出追踪报告（HTML）"
            >
              <Download className="size-3" />
              导出
            </button>
          </div>
        </div>
      )}

      {/* 事件列表 */}
      {expanded && (
        <div className="px-3 py-2 space-y-1 max-h-[400px] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-hint text-xs">
              <Loader2 className="size-4 animate-spin mr-2" />
              加载事件中...
            </div>
          ) : displayEvents.length > 0 ? (
            displayEvents.map((event, idx) => (
              <EventCard
                key={`${event.seq}-${idx}`}
                event={event}
                index={idx}
                traceId={trace.id}
                surfaceNode={surfaceMode === 'surface' && surfaceData?.nodes?.includes(event.seq)}
              />
            ))
          ) : (
            <div className="text-xs text-hint py-4 text-center">
              {surfaceMode === 'surface' ? '当前表面无可见事件' : '暂无事件'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 主面板 ──

export interface TraceTimelinePanelProps {
  /** 当前会话 ID（通常是 threadId） */
  sessionId?: string
  /** 章节号（用于标题展示） */
  chapterNumber?: number
}

export function TraceTimelinePanel({ sessionId, chapterNumber }: TraceTimelinePanelProps): ReactElement {
  const [autoRefresh, setAutoRefresh] = useState(true)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['trace-timeline', sessionId],
    queryFn: () => {
      if (!sessionId) throw new Error('No session ID')
      return fetchSessionTraces(sessionId)
    },
    enabled: !!sessionId,
    refetchInterval: autoRefresh ? 5000 : false,
    staleTime: 3000,
  })

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-hint text-sm">
        <Activity className="size-8 mb-3 opacity-30" />
        <p>请打开一个章节以查看追踪时间线</p>
        <p className="text-xs mt-1">需要在有活跃 Agent 调用的会话中收集数据</p>
      </div>
    )
  }

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center h-full text-hint text-sm">
        <Loader2 className="size-5 animate-spin mr-2" />
        加载追踪数据...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-destructive text-sm gap-2">
        <AlertCircle className="size-6" />
        <p>加载追踪数据失败</p>
        <p className="text-xs text-muted-foreground">{String(error)}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-2">
          重试
        </Button>
      </div>
    )
  }

  const traces = data?.traces ?? []

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="flex items-center justify-between shrink-0 px-1 py-2 border-b border-border/40">
        <div className="flex items-center gap-3 text-xs text-hint">
          <span className="font-medium text-text">
            {chapterNumber ? `第 ${chapterNumber} 章` : '当前会话'}
          </span>
          <span>{traces.length} 次运行</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] text-hint cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="size-3 accent-primary"
            />
            自动刷新
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[10px]"
            onClick={() => refetch()}
          >
            <RefreshCw className="size-3 mr-1" />
            刷新
          </Button>
        </div>
      </div>

      {/* 时间线列表 */}
      <div className="flex-1 overflow-y-auto py-2 space-y-2">
        {traces.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-hint text-sm">
            <FileText className="size-8 mb-3 opacity-30" />
            <p>暂无追踪记录</p>
            <p className="text-xs mt-1">运行 Agent 后会自动记录调用链</p>
          </div>
        ) : (
          traces.map((trace) => (
            <TraceGroup key={trace.id} trace={trace} />
          ))
        )}
      </div>
    </div>
  )
}

// ── 导入 RefreshCw ──
import { RefreshCw } from 'lucide-react'
