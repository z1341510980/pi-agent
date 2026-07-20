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
