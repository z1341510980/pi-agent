import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { CircleStop } from 'lucide-react'
import type { ChatMessage } from './types'
import { readSegments } from './types'

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

  // 本轮已运行时长（dsh turnStatusClock：扫光文字后的等宽小字计时）
  const startedAtRef = useRef(Date.now())
  const [elapsedSec, setElapsedSec] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    // dsh turnStatus：一行品牌蓝扫光文字，无卡片
    <div className="flex justify-start min-w-0">
      <div className="flex items-center">
        <motion.span
          key={enterKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className="dsh-turn-status"
        >
          {step.label}
        </motion.span>

        {elapsedSec > 0 && (
          <span className="ml-2 text-[13px] leading-5 font-normal tabular-nums text-hint">
            {formatElapsed(elapsedSec)}
          </span>
        )}

        {/* 三点跳动 */}
        <span className="ml-1 flex items-center gap-0.5" aria-hidden="true">
          <Dot delay={0} />
          <Dot delay={150} />
          <Dot delay={300} />
        </span>

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="ml-3 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-hint transition-colors hover:bg-accent hover:text-text"
            aria-label="停止生成"
          >
            <CircleStop className="size-3" />
            停止
          </button>
        )}
      </div>
    </div>
  )
}

/** 秒数 → 计时文本：<60s 显示 "42s"，之后 "1m07s" */
function formatElapsed(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
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
} {
  switch (phase.kind) {
    case 'thinking':
      return { label: '思考中' }
    case 'tool':
      return { label: `调用工具 · ${phase.toolName}` }
    case 'generating':
      return { label: '生成回复' }
    case 'idle':
    default:
      return { label: '等待响应' }
  }
}
