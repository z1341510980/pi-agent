/**
 * openai-audio adapter：OpenAI Audio 兼容语音合成协议（/audio/speech）。
 *
 * 文档口径（docs/new-api/openapi/generated/ai-model/音频（Audio）/原生OpenAI格式）：
 * POST {base}/audio/speech，body { model, input(≤4096), voice, response_format, speed }，
 * Bearer 鉴权；响应为二进制音频（无 JSON 包裹）→ 转 data URL 返回，
 * 由插件资产链路（storeFromDataUrl）落盘成本地 /assets/:id。
 *
 * base 归一复用 normalizeImageBaseUrl（服务根 → /v1 根，幂等）：语音端点
 * 挂在 /v1 下，与图片协议同源同鉴权。
 */

import type {
  AudioGenerationInput,
  MediaModalityContext,
  MediaProviderAdapter
} from '../adapter.js'
import {
  imageErrorMessage,
  normalizeImageBaseUrl,
  withAbortGuard
} from '../shared.js'

/** Provider 行 model 留空时的文档默认模型（tts-1）。 */
export const OPENAI_AUDIO_DEFAULT_MODEL = 'tts-1'

export const OPENAI_AUDIO_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

/** input 字段长度上限（文档 maxLength 4096）；超限直接报错而不是悄悄截断。 */
export const OPENAI_AUDIO_MAX_INPUT_CHARS = 4096

/** response_format → MIME：data URL 与资产落盘共用。 */
const AUDIO_FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm'
}

export function audioMimeForFormat(format: string): string {
  return AUDIO_FORMAT_MIME[format] ?? 'audio/mpeg'
}

function createRuntime(ctx: MediaModalityContext): {
  providerId: string
  baseUrl: string
  model: string
  headers: Record<string, string>
} {
  return {
    providerId: ctx.providerId,
    baseUrl: normalizeImageBaseUrl(ctx.baseUrl),
    model: ctx.model || OPENAI_AUDIO_DEFAULT_MODEL,
    // 与图片 adapter 口径一致：空 Key 时不携带 Authorization 头
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}
  }
}

export const openaiAudioAdapter: MediaProviderAdapter = {
  id: 'openai-audio',
  label: 'OpenAI 语音合成',
  modality: 'audio',
  capabilities: { generate: true },
  formSchema: [
    {
      key: 'voice',
      label: '音色',
      type: 'select',
      options: OPENAI_AUDIO_VOICES.map((voice) => ({ value: voice, label: voice }))
    },
    {
      key: 'format',
      label: '音频格式',
      type: 'select',
      options: Object.keys(AUDIO_FORMAT_MIME).map((format) => ({ value: format, label: format }))
    },
    { key: 'speed', label: '语速 (0.25-4)', type: 'number', placeholder: '1' }
  ],
  async generateAudio(
    ctx: MediaModalityContext,
    input: AudioGenerationInput
  ): Promise<{ outputs: Array<{ url: string; mimeType: string }> }> {
    if (input.prompt.length > OPENAI_AUDIO_MAX_INPUT_CHARS) {
      throw new Error(
        `语音合成文本超过 ${OPENAI_AUDIO_MAX_INPUT_CHARS} 字符上限（当前 ${input.prompt.length}），请分段生成`
      )
    }
    const rt = createRuntime(ctx)
    const format = input.format || ctx.params.format || 'mp3'
    const voice = input.voice || ctx.params.voice || 'alloy'
    const speed = input.speed ?? (ctx.params.speed ? Number(ctx.params.speed) : undefined)
    const guard = withAbortGuard(input.signal)
    try {
      const response = await fetch(`${rt.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { ...rt.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model || rt.model,
          input: input.prompt,
          voice,
          response_format: format,
          ...(speed !== undefined && Number.isFinite(speed) ? { speed } : {})
        }),
        signal: guard.signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let parsed: unknown = null
        try {
          parsed = JSON.parse(text)
        } catch {
          // 非 JSON 错误体：保留原文交给 imageErrorMessage 的字符串分支
          parsed = text
        }
        throw new Error(`语音合成失败: ${imageErrorMessage(parsed) || `HTTP ${response.status}`}`)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length) throw new Error('语音 Provider 返回中没有音频数据')
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      const mimeType = contentType.startsWith('audio/') ? contentType : audioMimeForFormat(format)
      return {
        outputs: [
          { url: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType }
        ]
      }
    } finally {
      guard.dispose()
    }
  }
}
