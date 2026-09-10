/**
 * 媒体生成公共工具（spec §2）：从 core/config/media-generator.ts 提取的
 * 协议无关纯函数与轮询机制，供 openai-images / apimart 等 adapter 复用。
 * 任务端点差异（apimart /tasks vs openai /images/generations/{id}）通过
 * ImageJobPollSource.buildEndpoint 注入，轮询/退避/状态判定在此收敛。
 */

import type { FastifyBaseLogger } from 'fastify'
import { mediaDiag } from '../config/media-diag.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function dataUrlToBlob(value: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) throw new Error('图片必须是 dataURL 格式')
  const mime = match[1] || 'application/octet-stream'
  const payload = match[3]
  const buffer = match[2]
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')
  return new Blob([buffer], { type: mime })
}

/** Canvas settings accept either the service root or an explicit OpenAI-style /v1 root. */
export function normalizeImageBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  return normalized.toLowerCase().endsWith('/v1') ? normalized : `${normalized}/v1`
}

export const IMAGE_JOB_TIMEOUT_MS = 5 * 60_000
export const IMAGE_POLL_INITIAL_DELAY_MS = 2_000
export const IMAGE_POLL_MAX_DELAY_MS = 10_000

export function recordCandidates(value: unknown): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = []
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  while (queue.length) {
    const item = queue.shift()
    if (!item || item.depth > 5 || !isRecord(item.value) || seen.has(item.value)) continue
    seen.add(item.value)
    candidates.push(item.value)
    for (const key of ['data', 'result', 'task', 'output', 'response']) {
      const nested = item.value[key]
      if (isRecord(nested)) queue.push({ value: nested, depth: item.depth + 1 })
      else if (Array.isArray(nested)) {
        for (const child of nested) queue.push({ value: child, depth: item.depth + 1 })
      }
    }
  }
  return candidates
}

export function imageErrorMessage(value: unknown): string {
  for (const candidate of recordCandidates(value)) {
    const error = candidate.error
    if (typeof error === 'string') return error
    if (isRecord(error) && typeof error.message === 'string') return error.message
    for (const key of ['message', 'msg', 'detail']) {
      if (typeof candidate[key] === 'string') return candidate[key] as string
    }
  }
  return typeof value === 'string' ? value : ''
}

function imageUrlValues(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value]
  if (Array.isArray(value)) return value.flatMap((item) => imageUrlValues(item))
  if (!isRecord(value)) return []
  if (typeof value.b64_json === 'string' && value.b64_json.length > 0) {
    return [`data:image/png;base64,${value.b64_json}`]
  }
  if ('url' in value) return imageUrlValues(value.url)
  if ('image_url' in value) return imageUrlValues(value.image_url)
  return []
}

/** Parse both OpenAI `data[].url/b64_json` and nested APIMart task results. */
export function parseImages(value: unknown): string[] {
  const urls: string[] = []
  const add = (candidate: unknown): void => {
    for (const url of imageUrlValues(candidate)) {
      if (url && !urls.includes(url)) urls.push(url)
    }
  }

  for (const candidate of recordCandidates(value)) {
    add(candidate.data)
    add(candidate.images)
    add(candidate.result)
    add(candidate.output)
    add(candidate.url)
    add(candidate.image_url)
  }
  return urls
}

export function imageJob(value: unknown): { id: string; status: string } | undefined {
  for (const candidate of recordCandidates(value)) {
    const id = candidate.task_id ?? candidate.id
    if (typeof id !== 'string' || !id) continue
    const rawStatus = candidate.status ?? candidate.state
    return { id, status: typeof rawStatus === 'string' ? rawStatus : '' }
  }
  return undefined
}

export function imageHttpError(body: unknown, status: number, operation: string): Error {
  return new Error(`${operation}: ${imageErrorMessage(body) || `HTTP ${status}`}`)
}

/** 诊断用：参考图负载的元信息（只记数量与字节，不记内容）。 */
export function referenceStats(references: string[] | undefined): {
  referenceCount: number
  referenceBytes: number
} {
  return {
    referenceCount: references?.length ?? 0,
    referenceBytes: references?.reduce((sum, value) => sum + value.length, 0) ?? 0
  }
}

export function imageResponseShape(body: unknown): 'images' | 'job' | 'empty' {
  if (parseImages(body).length) return 'images'
  return imageJob(body) ? 'job' : 'empty'
}

export function safeBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`.replace(/\/$/, '')
  } catch {
    return value.replace(/[?#].*$/, '').replace(/\/$/, '')
  }
}

export function safeProviderLabel(parts: {
  providerId?: string
  providerApi?: string
  baseUrl: string
}): string {
  return parts.providerId || parts.providerApi || safeBaseUrl(parts.baseUrl)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function readImageResponse(response: Response, operation: string): Promise<unknown> {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw imageHttpError(body, response.status, operation)
  return body
}

export function imageJobFailure(body: unknown, operation: string): Error {
  const job = imageJob(body)
  return new Error(`${operation}: ${imageErrorMessage(body) || job?.status || '任务失败'}`)
}

export function taskStatus(value: string | undefined): string {
  return (value || '').trim().toLowerCase()
}

export function isFailedStatus(status: string): boolean {
  return ['failed', 'failure', 'error', 'blocked', 'cancelled', 'canceled'].includes(status)
}

export function isCompletedStatus(status: string): boolean {
  return ['succeeded', 'success', 'completed', 'done'].includes(status)
}

/** 轮询退避：间隔 1.5 倍递增并向上取整，封顶 IMAGE_POLL_MAX_DELAY_MS。 */
export function nextImagePollDelayMs(waitMs: number): number {
  return Math.min(Math.ceil(waitMs * 1.5), IMAGE_POLL_MAX_DELAY_MS)
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

export function withAbortGuard(signal: AbortSignal | undefined, timeoutMs = 120_000): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromCaller = (): void => controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

/**
 * OpenAI 兼容图片接口的 size 白名单（1k/2k/4k 档位）。
 * 接口文档要求只传白名单值，非法自由分辨率按比例吸附到最近档位。
 */
const OPENAI_IMAGE_SIZE_TIERS: string[][] = [
  // 1k
  ['1024x1024', '1152x896', '896x1152', '1536x864', '864x1536', '1536x1024', '1024x1536', '1792x768'],
  // 2k
  ['2048x2048', '2048x1536', '1536x2048', '2048x1152', '1152x2048', '2048x1360', '1360x2048', '2048x880'],
  // 4k
  ['3840x3840', '3840x2880', '2880x3840', '3840x2160', '2160x3840', '3840x2560', '2560x3840', '3840x1648']
]

const OPENAI_IMAGE_SIZE_WHITELIST: string[] = OPENAI_IMAGE_SIZE_TIERS.flat()

/** 把任意 "宽x高" 吸附到文档白名单里长宽比最接近的档位（按最大边选 1k/2k/4k）。 */
export function normalizeOpenAiCompatibleSize(size: string | undefined): string | undefined {
  const value = size?.trim()
  if (!value || value === 'auto') return undefined
  if (OPENAI_IMAGE_SIZE_WHITELIST.includes(value)) return value
  const match = /^(\d+)x(\d+)$/.exec(value)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!(width > 0) || !(height > 0)) return undefined
  const maxDim = Math.max(width, height)
  const tier = maxDim >= 3840 ? OPENAI_IMAGE_SIZE_TIERS[2] : maxDim >= 2048 ? OPENAI_IMAGE_SIZE_TIERS[1] : OPENAI_IMAGE_SIZE_TIERS[0]
  const aspect = Math.log(width / height)
  let best = tier[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of tier) {
    const [w, h] = candidate.split('x').map(Number)
    const distance = Math.abs(aspect - Math.log(w / h))
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

/** 轮询上下文：headers/标签由调用方给定，任务端点按 jobId 拼装（协议差异收敛点）。 */
export interface ImageJobPollSource {
  providerId?: string
  providerApi?: string
  baseUrl: string
  headers: Record<string, string>
  /** 由 jobId 拼装任务状态端点（如 apimart 需附 language 参数） */
  buildEndpoint: (jobId: string) => string
  /** 诊断日志用的端点标签，如 '/images/generations/{id}' */
  endpointLabel: string
}

export async function pollImageJob(
  source: ImageJobPollSource,
  jobId: string,
  signal: AbortSignal,
  operation: string,
  noImageMessage: string,
  logger?: FastifyBaseLogger,
  traceId?: string
): Promise<string[]> {
  let waitMs = IMAGE_POLL_INITIAL_DELAY_MS
  let lastLoggedStatus = ''
  for (;;) {
    await delay(waitMs, signal)
    const response = await fetch(source.buildEndpoint(jobId), {
      headers: source.headers,
      signal
    })
    const body = await readImageResponse(response, operation)
    const images = parseImages(body)
    const statusCandidate = recordCandidates(body).find(
      (candidate) => typeof candidate.status === 'string' || typeof candidate.state === 'string'
    )
    const fallbackStatus = statusCandidate?.status ?? statusCandidate?.state
    const job = imageJob(body) ?? {
      id: jobId,
      status: typeof fallbackStatus === 'string' ? fallbackStatus : ''
    }
    const status = taskStatus(job.status)
    logger?.debug(
      {
        traceId,
        providerId: source.providerId,
        provider: safeProviderLabel(source),
        endpoint: source.endpointLabel,
        jobId,
        status: response.status,
        responseShape: imageResponseShape(body),
        jobStatus: job?.status,
        nextDelayMs: images.length || isCompletedStatus(status) ? undefined : waitMs
      },
      '图片任务轮询'
    )
    if (images.length) return images
    if (status !== lastLoggedStatus) {
      lastLoggedStatus = status
      mediaDiag.event('job-poll', {
        traceId,
        provider: safeProviderLabel(source),
        jobId,
        jobStatus: job.status
      })
    }
    if (!job) throw new Error(noImageMessage)
    if (isFailedStatus(status)) throw imageJobFailure(body, operation)
    if (isCompletedStatus(status)) throw new Error(noImageMessage)
    waitMs = nextImagePollDelayMs(waitMs)
  }
}

export async function resolveImageResponse(
  source: ImageJobPollSource,
  body: unknown,
  signal: AbortSignal,
  operation: string,
  noImageMessage: string,
  logger?: FastifyBaseLogger,
  traceId?: string
): Promise<string[]> {
  const images = parseImages(body)
  if (images.length) return images

  const job = imageJob(body)
  if (!job) throw new Error(noImageMessage)
  const status = taskStatus(job.status)
  if (isFailedStatus(status)) throw imageJobFailure(body, operation)
  if (isCompletedStatus(status)) throw new Error(noImageMessage)
  return pollImageJob(source, job.id, signal, operation, noImageMessage, logger, traceId)
}
