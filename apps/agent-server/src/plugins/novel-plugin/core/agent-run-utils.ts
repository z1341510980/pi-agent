import type { BaseEvent, AgUiEventSink } from '@repo/protocol/events'

export interface LlmUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmProvider: string
  llmModel: string
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function readNumber(source: Record<string, unknown> | undefined, keys: string[]): number {
  if (!source) return 0
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

function readString(source: Record<string, unknown> | undefined, keys: string[]): string {
  if (!source) return ''
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string') return value
  }
  return ''
}

export function extractLlmUsageFromMessage(message: Record<string, unknown> | undefined): LlmUsageSnapshot | undefined {
  if (!message) return undefined
  const usage = toRecord(message.usage) ?? message
  const inputTokens = readNumber(usage, ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'])
  const outputTokens = readNumber(usage, ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'])
  const cacheReadTokens = readNumber(usage, ['cacheRead', 'cacheReadTokens', 'cache_read_input_tokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens', 'prompt_cache_hit_tokens'])
  const cacheWriteTokens = readNumber(usage, ['cacheWrite', 'cacheWriteTokens', 'cache_creation_input_tokens', 'cache_write_tokens', 'prompt_cache_miss_tokens'])

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return undefined

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    llmProvider: readString(message, ['provider', 'providerId']),
    llmModel: readString(message, ['model', 'modelId']),
  }
}

export function addLlmUsage(current: LlmUsageSnapshot | undefined, next: LlmUsageSnapshot): LlmUsageSnapshot {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    llmProvider: next.llmProvider || current?.llmProvider || '',
    llmModel: next.llmModel || current?.llmModel || '',
  }
}

export function hasLlmUsage(usage: LlmUsageSnapshot | undefined): usage is LlmUsageSnapshot {
  return !!usage && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0
}

export interface NovelWriterEventBuffer {
  /** 接收底座事件；普通文本事件会被暂存，其他事件立即转发。 */
  emit(event: BaseEvent): void
  /** 发送已经通过规范化的正文，并补齐文本消息的 start/content/end。 */
  flush(messageId: string, content: string): void
  /** 丢弃原始文本，同时结束前端占位消息，避免英文思考泄漏。 */
  discard(messageId: string): void
}

/**
 * Writer 专用事件出口。
 *
 * Pi 会把最终文本按增量事件推给 StreamEmitter，而 Writer 的返回值只有在
 * prompt() 完成后才能做中文正文校验。普通 TEXT_MESSAGE_* 必须先缓存，否则
 * 前端会先看到英文思考，再看到事后才清理过的中文结果。工具、阶段和 reasoning
 * 事件不属于正文，继续即时转发以保持流程可见性。
 */
export function createNovelWriterEventBuffer(sink: AgUiEventSink): NovelWriterEventBuffer {
  let sourceMessageId = ''
  let finalized = false

  const emitText = (messageId: string, content: string): void => {
    sink({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' } as BaseEvent)
    if (content) {
      sink({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: content } as BaseEvent)
    }
    sink({ type: 'TEXT_MESSAGE_END', messageId } as BaseEvent)
  }

  return {
    emit(event: BaseEvent): void {
      const type = (event as { type?: unknown }).type
      if (type === 'TEXT_MESSAGE_START') {
        sourceMessageId = String((event as { messageId?: unknown }).messageId ?? '')
        return
      }
      if (type === 'TEXT_MESSAGE_CONTENT') {
        return
      }
      if (type === 'TEXT_MESSAGE_END') {
        return
      }
      sink(event)
    },
    flush(messageId: string, content: string): void {
      if (finalized) return
      finalized = true
      emitText(messageId || sourceMessageId, content)
    },
    discard(messageId: string): void {
      if (finalized) return
      finalized = true
      emitText(messageId || sourceMessageId, '')
    },
  }
}

export interface NovelWriterOutput {
  content: string
  /** 是否从模型输出中剥离了思考、计划或自检文本。 */
  strippedReasoning: boolean
  /** 正文中的中文字符占比（按非空白字符计算）。 */
  chineseRatio: number
  /** 没有找到可安全交给后续流程的正文。 */
  rejected: boolean
  reason?: string
}

const WRITER_OUTPUT_MARKERS = /^(?:analysis|the scene|the task|the total|the core|the output|this scene|this output|ensuring|in conclusion|conclusion|final answer|word count|analysis confirms|the ".+" segment)\b/i
const WRITER_OUTPUT_MARKERS_ZH = /^(?:分析|场景分析|写作思路|创作思路|自检|字数检查|总结|以下是正文|正文如下|写作说明|核对结果|核心元素|场景目标|任务目标|创作说明)[：:：]?/i

function countChinese(text: string): number {
  return (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s/g, '').length
}

function stripWriterBodyPrefix(line: string): string {
  return line.replace(/^(?:正文如下|以下是正文)[：:]\s*/i, '').trim()
}

/**
 * Writer 的文本响应不是天然的正文：部分 provider 会把隐藏推理/自检以普通文本
 * 返回，并在最后追加中文正文。所有 Writer 输出必须经过这里再进入字数门、审稿和落库。
 * 解析只做确定性边界裁剪，不尝试改写正文；无法确认正文边界时拒绝，避免把分析文本
 * 带入后续重写循环。
 */
export function normalizeNovelWriterOutput(raw: string): NovelWriterOutput {
  const original = raw.trim()
  if (!original) {
    return { content: '', strippedReasoning: false, chineseRatio: 0, rejected: true, reason: 'Writer 返回为空' }
  }

  // Writer 推回是控制协议，不是正文，必须原样交给编排层处理。
  if (/^\s*\[DIRECTOR_PUSHBACK\]/i.test(original)) {
    return { content: original, strippedReasoning: false, chineseRatio: 0, rejected: false }
  }

  const withoutFence = original
    .replace(/^\s*```(?:markdown|text|小说|正文)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  const lines = withoutFence.split(/\r?\n/)
  const firstChineseLine = lines.findIndex((line) => {
    const trimmed = stripWriterBodyPrefix(line)
    return countChinese(trimmed) >= 2
      && !WRITER_OUTPUT_MARKERS.test(trimmed)
      && !WRITER_OUTPUT_MARKERS_ZH.test(trimmed)
  })
  if (firstChineseLine < 0) {
    return {
      content: '',
      strippedReasoning: withoutFence !== original,
      chineseRatio: 0,
      rejected: true,
      reason: 'Writer 未返回中文正文，疑似只返回了思考或写作说明',
    }
  }

  let bodyLines = lines.slice(firstChineseLine).map((line, index) =>
    index === 0 ? stripWriterBodyPrefix(line) : line,
  )
  let strippedReasoning = firstChineseLine > 0 || withoutFence !== original

  // 删除正文后追加的英文/中文自检段。正文中的普通英文专名不会命中这些行首标记。
  const trailingMarkerIndex = bodyLines.findIndex((line, index) => {
    if (index < 2) return false
    const trimmed = line.trim()
    return WRITER_OUTPUT_MARKERS.test(trimmed) || WRITER_OUTPUT_MARKERS_ZH.test(trimmed)
  })
  if (trailingMarkerIndex >= 0) {
    bodyLines = bodyLines.slice(0, trailingMarkerIndex)
    strippedReasoning = true
  }

  let content = bodyLines.join('\n').trim()
  // 如果模型在正文前放了“正文如下：”，只保留后面的真正内容。
  content = content.replace(/^(?:正文如下|以下是正文)[：:]\s*/i, '').trim()
  const length = nonWhitespaceLength(content)
  const chineseRatio = length === 0 ? 0 : countChinese(content) / length
  if (!content || countChinese(content) < 8 || chineseRatio < 0.18) {
    return {
      content,
      strippedReasoning,
      chineseRatio,
      rejected: true,
      reason: 'Writer 正文中文比例过低或内容不足，疑似仍包含思考/说明文本',
    }
  }

  return { content, strippedReasoning, chineseRatio, rejected: false }
}

/**
 * 清理模型正文中的 Unicode 长横线。
 *
 * 不处理普通连字符 `-`，避免破坏数字区间、英文复合词和 Markdown。话语中断改为
 * 省略号，标点旁直接移除，其余插说按句法位置改为句号或逗号。
 */
export function sanitizeNovelProse(text: string): string {
  if (!text || !/[\u2013\u2014\u2015]/.test(text)) return text

  const dash = /[\u2013\u2014\u2015]+/g
  return text
    .replace(/[\u2013\u2014\u2015]+(?=["”’」』])/g, '……')
    .replace(/[\u2013\u2014\u2015]+(?=[。！？…])/g, '')
    .replace(/([。！？，；：…])[\u2013\u2014\u2015]+/g, '$1')
    .replace(/^[\u2013\u2014\u2015]+\s*/gm, '')
    .replace(dash, (match, offset: number, source: string) => {
      const after = source[offset + match.length] ?? ''
      if (!after || after === '\n') return '。'
      const lineStart = source.lastIndexOf('\n', offset - 1) + 1
      const nextLineBreak = source.indexOf('\n', offset + match.length)
      const lineEnd = nextLineBreak === -1 ? source.length : nextLineBreak
      const hasSiblingDash = /[\u2013\u2014\u2015]/.test(source.slice(lineStart, offset))
        || /[\u2013\u2014\u2015]/.test(source.slice(offset + match.length, lineEnd))
      return hasSiblingDash ? '，' : '。'
    })
    .replace(/，([。！？])/g, '$1')
    .replace(/。{2,}/g, '。')
}
