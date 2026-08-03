import { useEffect, useRef, useState, type ReactElement } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronDown,
  ShieldAlert,
  ShieldCheck,
  Shield,
  Check,
  X,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ConfirmationRequestPayload } from '@/hooks/use-websocket'
import { cn } from '@/lib/utils'

/**
 * PermissionRequestCard —— 工具执行审批（内联在消息流里）。
 *
 * ## 为什么从模态框改成内联
 *
 * 审批要做的判断是「结合上下文看这个操作合不合理」：Agent 刚说要干什么、
 * 前面读了哪些文件、这是第几次尝试。模态框恰好把这些全遮住了 —— 用户被迫
 * 在信息最少的时候做安全决策。内联卡片长在消息流末尾，也就是 Agent 当前
 * 工作的位置，上下文一眼可见。
 *
 * ## 不做「始终允许」
 *
 * AionUi 把「记住选择」编成独立选项而不是勾选框，这个做法是对的。但 pi-agent
 * 后端的 `confirmationManager.respond(id, approved)` 只接受布尔值，没有
 * 按工具/按服务器的授权记忆。在前端自行实现「以后自动批准」等于**绕过后端
 * 授权做静默放行** —— 那是安全倒退，不是便利。所以这里只给单次批准/拒绝，
 * 需要长期放行的走输入框左侧的权限模式（那是有后端支撑的机制）。
 */

/** 危险工具：可能造成不可逆副作用 */
const DANGEROUS_TOOLS = new Set(['bash', 'shell', 'delete_file', 'remove_file', 'rm'])
/** 中等风险：写入类 */
const MODERATE_TOOLS = new Set(['write', 'write_file', 'edit', 'edit_file', 'web_fetch', 'web_search'])

type RiskLevel = 'dangerous' | 'moderate' | 'safe'

interface RiskMeta {
  level: RiskLevel
  label: string
  icon: typeof Shield
  /** 图标与标签配色 */
  tone: string
  /** 卡片强调边配色 */
  accent: string
}

function getRisk(toolName: string): RiskMeta {
  const name = toolName.toLowerCase()
  if (DANGEROUS_TOOLS.has(name)) {
    return {
      level: 'dangerous',
      label: '危险',
      icon: ShieldAlert,
      tone: 'text-destructive',
      accent: 'border-destructive/45 bg-destructive/[0.06]',
    }
  }
  if (MODERATE_TOOLS.has(name)) {
    return {
      level: 'moderate',
      label: '中等',
      icon: Shield,
      tone: 'text-amber-600 dark:text-amber-400',
      accent: 'border-amber-500/40 bg-amber-500/[0.06]',
    }
  }
  return {
    level: 'safe',
    label: '低风险',
    icon: ShieldCheck,
    tone: 'text-emerald-600 dark:text-emerald-400',
    accent: 'border-border bg-surface-2',
  }
}

/** 参数格式化：单值超长截断，避免一个大 diff 把卡片撑到几屏高 */
function formatArgs(args: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(args)) {
    let str: string
    if (typeof value === 'string') {
      str = value
    } else {
      try {
        str = JSON.stringify(value, null, 2)
      } catch {
        str = String(value)
      }
    }
    if (str.length > 600) str = `${str.slice(0, 600)}…（已截断）`
    lines.push(`${key}: ${str}`)
  }
  return lines.join('\n')
}

/** 从参数里挑出最能说明「要动什么」的一项，放在标题行 */
function primaryTarget(args: Record<string, unknown>): string | null {
  for (const key of ['command', 'path', 'filePath', 'file_path', 'file', 'url', 'query']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.length > 90 ? `${value.slice(0, 90)}…` : value
    }
  }
  return null
}

export interface PermissionRequestCardProps {
  request: ConfirmationRequestPayload
  /** 还在排队的其他审批数量（不含当前这条） */
  queuedCount: number
  onRespond: (id: string, approved: boolean) => void
}

export function PermissionRequestCard({
  request,
  queuedCount,
  onRespond
}: PermissionRequestCardProps): ReactElement {
  const [responding, setResponding] = useState(false)
  const [argsOpen, setArgsOpen] = useState(false)

  /**
   * 请求身份的 epoch。
   *
   * 用户点了批准、响应还在飞的时候，如果这条被别处解决、卡片换成了下一条请求，
   * 迟到的回调不能把新请求标成"已回答"。切换请求即重置 responding。
   */
  const epochRef = useRef(request.id)
  useEffect(() => {
    if (epochRef.current !== request.id) {
      epochRef.current = request.id
      setResponding(false)
      setArgsOpen(false)
    }
  }, [request.id])

  const risk = getRisk(request.toolName)
  const RiskIcon = risk.icon
  const target = primaryTarget(request.args)
  const argsText = formatArgs(request.args)

  const respond = (approved: boolean): void => {
    if (responding) return
    setResponding(true)
    onRespond(request.id, approved)
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
      className={cn('rounded-xl border px-3.5 py-3', risk.accent)}
      aria-label="工具执行审批"
    >
      <div className="flex items-start gap-2.5">
        <RiskIcon className={cn('mt-0.5 size-4 shrink-0', risk.tone)} aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium text-text">需要你批准</p>
            <code className="rounded bg-surface-3/70 px-1.5 py-0.5 font-mono text-nano text-text-secondary">
              {request.toolName}
            </code>
            <span className={cn('rounded px-1.5 py-0.5 text-nano', risk.tone)}>{risk.label}</span>
            {queuedCount > 0 && (
              <span className="ml-auto rounded bg-surface-3 px-1.5 py-0.5 text-nano tabular-nums text-hint">
                还有 {queuedCount} 条待审
              </span>
            )}
          </div>

          {/* 最关键的那个参数直接摊在标题下：多数情况下看这一行就够判断了 */}
          {target && (
            <p className="mt-1 truncate font-mono text-micro text-text-secondary" title={target}>
              {target}
            </p>
          )}

          {request.reason && (
            <p className="mt-1 text-caption leading-relaxed text-text-secondary">{request.reason}</p>
          )}

          {risk.level === 'dangerous' && (
            <p className="mt-1.5 text-caption leading-relaxed text-destructive">
              这个工具可能产生不可逆的副作用（执行命令、删除文件）。批准前请核对上面的参数。
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant={risk.level === 'dangerous' ? 'destructive' : 'default'}
              disabled={responding}
              onClick={() => respond(true)}
              className="h-7 gap-1 px-2.5 text-xs"
            >
              {responding ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              批准执行
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={responding}
              onClick={() => respond(false)}
              className="h-7 gap-1 px-2.5 text-xs"
            >
              <X className="size-3" />
              拒绝
            </Button>
            {argsText && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setArgsOpen((v) => !v)}
                aria-expanded={argsOpen}
                className="h-7 gap-1 px-2 text-xs text-hint hover:text-text"
              >
                <ChevronDown className={cn('size-3 transition-transform', argsOpen && 'rotate-180')} />
                完整参数
              </Button>
            )}
          </div>

          {argsOpen && argsText && (
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-surface-1/70 px-2.5 py-2 font-mono text-nano leading-relaxed whitespace-pre-wrap break-words text-text-secondary">
              {argsText}
            </pre>
          )}
        </div>
      </div>
    </motion.section>
  )
}
