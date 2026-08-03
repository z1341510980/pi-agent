import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Brain, Wrench, PenLine, CircleStop } from 'lucide-react'
import type { ChatMessage } from './types'
import { readSegments } from './types'
import { cn } from '@/lib/utils'

/** 流式当前阶段 */
export type StreamingPhase =
  | { kind: 'thinking' }
  | { kind: 'tool'; toolName: string }
  | { kind: 'generating' }
  | { kind: 'idle' }

export interface StreamingIndicatorProps {
  /** 当前活跃的助手消息（用于推断阶段） */
  activeMessage?: ChatMessage
  /** 取消流式的回调 */
  onCancel?: () => void
}

/**
 * StreamingIndicator：流式输出状态指示器
 *
 * 根据活跃助手消息的 thinking / toolCalls / streamingBuffer 推断当前阶段：
 *   - thinking.isStreaming → 思考中
 *   - 最后一个 toolCall.status === 'running' → 调用工具 · {toolName}
 *   - streamingBuffer 非空 → 生成回复…
 *   - 否则 → 等待响应
 */
export function StreamingIndicator({ activeMessage, onCancel }: StreamingIndicatorProps) {
  const phase = derivePhase(activeMessage)
  const step = phaseToStep(phase)

  // 阶段切换时的进入动画 key
  const [enterKey, setEnterKey] = useState(step.label)
  useEffect(() => {
    setEnterKey(step.label)
  }, [step.label])

  return (
    <div className="flex justify-start max-w-[80%]">
      <div className="bg-surface-2 rounded-lg px-4 py-3 min-w-[200px]">
        <div className="flex items-center gap-2.5 text-sm">
          <motion.span
            key={enterKey}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className={cn(
              'flex size-5 items-center justify-center rounded-full',
              step.iconBg,
            )}
            aria-hidden="true"
          >
            <step.Icon className="size-3" />
          </motion.span>

          <span className="font-medium text-text">{step.label}</span>

          {/* 三点跳动 */}
          <span className="flex items-center gap-0.5 ml-1" aria-hidden="true">
            <Dot delay={0} />
            <Dot delay={150} />
            <Dot delay={300} />
          </span>

          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-hint hover:bg-surface-3 hover:text-text transition-colors"
              aria-label="停止生成"
            >
              <CircleStop className="size-3" />
              停止
            </button>
          )}
        </div>

        {/* 阶段切换的副标题（可选） */}
        <AnimatePresence mode="wait">
          {step.hint && (
            <motion.p
              key={step.hint}
              initial={{ opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={{ duration: 0.15 }}
              className="mt-1 text-xs text-subtle"
            >
              {step.hint}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** 跳动小圆点 */
function Dot({ delay }: { delay: number }) {
  return (
    <motion.span
      className="block size-1 rounded-full bg-hint"
      animate={{ opacity: [0.3, 1, 0.3], y: [0, -1.5, 0] }}
      transition={{ duration: 0.9, repeat: Infinity, delay, ease: 'easeInOut' }}
    />
  )
}

/**
 * 从活跃消息推断当前阶段。
 *
 * 判定改为看**最后一个分段**：分段模型下顺序就是时间线，最后一段是什么，
 * Agent 此刻就在做什么。原来要分别看 thinking / toolCalls / streamingBuffer
 * 三个通道，还要靠 reverse().find() 猜"最近那个"。
 */
function derivePhase(msg?: ChatMessage): StreamingPhase {
  if (!msg) return { kind: 'idle' }

  const segments = readSegments(msg)
  const last = segments[segments.length - 1]
  if (!last) return { kind: 'idle' }

  if (last.kind === 'thinking') {
    return last.isStreaming ? { kind: 'thinking' } : { kind: 'idle' }
  }

  if (last.kind === 'tool') {
    return last.call.status === 'running'
      ? { kind: 'tool', toolName: last.call.toolName }
      : { kind: 'idle' }
  }

  return last.text.length > 0 ? { kind: 'generating' } : { kind: 'idle' }
}

/** 阶段 → 显示配置 */
function phaseToStep(phase: StreamingPhase): {
  label: string
  hint?: string
  Icon: typeof Brain
  iconBg: string
} {
  switch (phase.kind) {
    case 'thinking':
      return {
        label: '思考中',
        hint: '正在分析需求与拆解方案',
        Icon: Brain,
        iconBg: 'bg-purple-500/15 text-purple-500',
      }
    case 'tool':
      return {
        label: `调用工具 · ${phase.toolName}`,
        hint: '正在执行工具调用',
        Icon: Wrench,
        iconBg: 'bg-blue-500/15 text-blue-500',
      }
    case 'generating':
      return {
        label: '生成回复',
        hint: '正在组织最终回答',
        Icon: PenLine,
        iconBg: 'bg-emerald-500/15 text-emerald-500',
      }
    case 'idle':
    default:
      return {
        label: '等待响应',
        Icon: Brain,
        iconBg: 'bg-muted text-muted-foreground',
      }
  }
}
