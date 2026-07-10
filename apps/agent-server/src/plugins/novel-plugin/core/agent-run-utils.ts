export interface LlmUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmProvider: string
  llmModel: string
}

export interface RevisionDecision {
  content: string
  accepted: boolean
  mode: 'full' | 'patch' | 'rejected'
  reason?: string
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
  const cacheReadTokens = readNumber(usage, ['cacheRead', 'cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens', 'prompt_cache_hit_tokens'])
  const cacheWriteTokens = readNumber(usage, ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens', 'prompt_cache_miss_tokens'])

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

function normalizeText(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，。！？、；：,.!?;:"'“”‘’（）()[\]{}#*_`>~-]/g, '')
}

function paragraphRetentionRatio(original: string, revised: string): number {
  const paragraphs = original
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => normalizeText(p).length >= 30)
  if (paragraphs.length === 0) return 1

  const revisedNormalized = normalizeText(revised)
  const retained = paragraphs.filter((p) => revisedNormalized.includes(normalizeText(p).slice(0, 80))).length
  return retained / paragraphs.length
}

function looksLikeRevisionReport(text: string): boolean {
  const head = text.trimStart().slice(0, 300)
  // 开头自我描述类（"修订完成。以下是…"/"已根据审稿意见修改…"/"以下是修改项总结"等）
  if (/^(以下是|下面是|已根据|我已|修订结果|修改结果|修订后正文|修改后正文|修订版|新版正文|修订完成|修改完成|修订总结|修改总结)/.test(head)) {
    return true
  }
  // 修订说明类标题（"### 修改项"/"### 修订项"/"## 修改清单"等）
  if (/^#{1,3}\s*(修订说明|修改说明|修订对比|改动说明|问题处理|修改项|修订项|修改清单|修订清单|改动项|变更项)/m.test(text)) {
    return true
  }
  // "原：… 改：…" 配对（含简写"原：/改："和"原段落：/修改后："）
  if (/(原文|原段落|原)\s*[：:][\s\S]{0,500}(修改后|修订后|改为|改)\s*[：:]/.test(text)) {
    return true
  }
  // 编号式 changelog（"1. 修改了…"/"2. 原文…改为…"等连续编号项）
  if (/(?:^|\n)\s*[0-9]+[.、)]\s*(修改了|改动了|调整了|原文|原)/m.test(text)) {
    return true
  }
  return false
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i)
  return match ? match[1].trim() : text.trim()
}

function extractRevisionPairs(text: string): Array<{ from: string; to: string }> {
  const pairs: Array<{ from: string; to: string }> = []
  const pattern = /(?:原文|原段落)\s*[：:]\s*([\s\S]*?)\n+(?:修改后|修订后|改为)\s*[：:]\s*([\s\S]*?)(?=\n+(?:原文|原段落|问题|修改说明|修订说明)\s*[：:]|\n+#{1,3}\s|$)/g
  for (const match of text.matchAll(pattern)) {
    const from = stripCodeFence(match[1])
    const to = stripCodeFence(match[2])
      .replace(/\n*(?:修改说明|修订说明)\s*[：:][\s\S]*$/u, '')
      .trim()
    if (normalizeText(from).length >= 10 && normalizeText(to).length >= 10) {
      pairs.push({ from, to })
    }
  }
  return pairs
}

function applyRevisionPairs(original: string, pairs: Array<{ from: string; to: string }>): string | undefined {
  let next = original
  let applied = 0
  for (const pair of pairs) {
    if (next.includes(pair.from)) {
      next = next.replace(pair.from, pair.to)
      applied++
    }
  }
  return applied > 0 ? next : undefined
}

export function applySafeRevision(original: string, rawRevision: string): RevisionDecision {
  const revision = stripCodeFence(rawRevision)
  const originalLength = original.trim().length
  const revisionLength = revision.trim().length

  if (revisionLength === 0) {
    return { content: original, accepted: false, mode: 'rejected', reason: 'empty_revision' }
  }

  const pairs = extractRevisionPairs(revision)
  if (pairs.length > 0) {
    const patched = applyRevisionPairs(original, pairs)
    if (patched) {
      return { content: patched, accepted: true, mode: 'patch' }
    }
  }

  if (revisionLength < originalLength * 0.75) {
    return { content: original, accepted: false, mode: 'rejected', reason: 'revision_too_short' }
  }

  if (looksLikeRevisionReport(revision)) {
    return { content: original, accepted: false, mode: 'rejected', reason: 'revision_report_output' }
  }

  const retentionRatio = paragraphRetentionRatio(original, revision)
  if (retentionRatio < 0.35) {
    return {
      content: original,
      accepted: false,
      mode: 'rejected',
      reason: 'low_original_retention',
    }
  }

  return { content: revision, accepted: true, mode: 'full' }
}
