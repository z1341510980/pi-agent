import type { ProviderConfigStore } from './provider-config-store.js'
import { normalizeProviderBaseUrl } from './provider-base-url.js'

export interface MediaGenerator {
  generateImage(input: {
    prompt: string
    model?: string
    size?: string
    count?: number
    signal?: AbortSignal
  }): Promise<{ images: string[] }>
  generateAudio(input: {
    prompt: string
    model?: string
    voice?: string
    format?: string
    speed?: number
    signal?: AbortSignal
  }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
  generateVideo(input: {
    prompt: string
    model?: string
    size?: string
    seconds?: number
    signal?: AbortSignal
  }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }>
  /** 图像编辑（蒙版局部重绘）：OpenAI 兼容 /images/edits。 */
  editImage?(input: {
    prompt: string
    image: string
    mask?: string
    model?: string
    size?: string
    signal?: AbortSignal
  }): Promise<{ images: string[] }>
  /** 视觉理解（反推提示词等）：OpenAI 兼容 /chat/completions 多模态消息。 */
  analyzeImage?(input: {
    image: string
    instruction?: string
    model?: string
    signal?: AbortSignal
  }): Promise<{ text: string }>
}

function dataUrlToBlob(value: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) throw new Error('图片必须是 dataURL 格式')
  const mime = match[1] || 'application/octet-stream'
  const payload = match[3]
  const buffer = match[2]
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')
  return new Blob([buffer], { type: mime })
}

export function splitModel(
  model: string | undefined,
  fallbackProvider: string | undefined
): { providerId?: string; modelId?: string } {
  if (!model) return { providerId: fallbackProvider }
  const separator = model.indexOf(':') >= 0 ? ':' : model.indexOf('/') >= 0 ? '/' : ''
  if (!separator) return { providerId: fallbackProvider, modelId: model }
  const index = model.indexOf(separator)
  return { providerId: model.slice(0, index), modelId: model.slice(index + 1) }
}

export function parseImages(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const data = (value as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as { b64_json?: unknown; url?: unknown }
    if (typeof record.b64_json === 'string' && record.b64_json.length > 0)
      return [`data:image/png;base64,${record.b64_json}`]
    if (typeof record.url === 'string' && record.url.length > 0) return [record.url]
    return []
  })
}

function resolveRequestContext(
  providerConfigStore: ProviderConfigStore,
  model: string | undefined
): { providerId: string; modelId: string; baseUrl: string; headers: Record<string, string> } {
  const defaultProvider =
    providerConfigStore.getDefaultProviderId() ?? providerConfigStore.list()[0]?.id
  const parsed = splitModel(model, defaultProvider)
  if (!parsed.providerId) throw new Error('未配置图片 Provider')
  const provider = providerConfigStore.get(parsed.providerId)
  if (!provider) throw new Error(`Provider 不存在: ${parsed.providerId}`)
  const modelId = parsed.modelId || provider.models[0]?.id
  if (!modelId) throw new Error(`Provider ${provider.id} 未配置模型`)
  const baseUrl = normalizeProviderBaseUrl(provider.api, provider.baseUrl).replace(/\/$/, '')
  const headers: Record<string, string> = {}
  if (provider.authHeader !== false) headers.Authorization = `Bearer ${provider.apiKey}`
  return { providerId: provider.id, modelId, baseUrl, headers }
}

function withAbortGuard(signal: AbortSignal | undefined): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
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

export function createMediaGenerator(providerConfigStore: ProviderConfigStore): MediaGenerator {
  return {
    async generateImage({ prompt, model, size = '1024x1024', count = 1, signal }) {
      const { modelId, baseUrl, headers } = resolveRequestContext(providerConfigStore, model)
      const guard = withAbortGuard(signal)
      try {
        const response = await fetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            prompt,
            n: Math.min(4, Math.max(1, count)),
            size
          }),
          signal: guard.signal
        })
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          const message =
            body && typeof body === 'object' && 'error' in body
              ? JSON.stringify((body as { error: unknown }).error)
              : `HTTP ${response.status}`
          throw new Error(`图片生成失败: ${message}`)
        }
        const images = parseImages(body)
        if (!images.length) throw new Error('图片 Provider 返回中没有图片数据')
        return { images }
      } finally {
        guard.dispose()
      }
    },
    async editImage({ prompt, image, mask, model, size, signal }) {
      const { modelId, baseUrl, headers } = resolveRequestContext(providerConfigStore, model)
      const guard = withAbortGuard(signal)
      try {
        // /images/edits 为 multipart 协议；不手动设置 Content-Type，让 fetch 生成 boundary。
        const form = new FormData()
        form.append('image', dataUrlToBlob(image), 'image.png')
        if (mask) form.append('mask', dataUrlToBlob(mask), 'mask.png')
        form.append('prompt', prompt)
        form.append('model', modelId)
        form.append('n', '1')
        if (size && size !== 'auto') form.append('size', size)
        const response = await fetch(`${baseUrl}/images/edits`, {
          method: 'POST',
          headers,
          body: form,
          signal: guard.signal
        })
        const body = (await response.json().catch(() => null)) as unknown
        if (!response.ok) {
          const message =
            body && typeof body === 'object' && 'error' in body
              ? JSON.stringify((body as { error: unknown }).error)
              : `HTTP ${response.status}`
          throw new Error(`图片编辑失败: ${message}`)
        }
        const images = parseImages(body)
        if (!images.length) throw new Error('图片 Provider 返回中没有编辑结果')
        return { images }
      } finally {
        guard.dispose()
      }
    },
    async analyzeImage({ image, instruction, model, signal }) {
      const { modelId, baseUrl, headers } = resolveRequestContext(providerConfigStore, model)
      const guard = withAbortGuard(signal)
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 800,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text:
                      instruction?.trim() ||
                      '请反推这张图片的生成提示词：输出一段可直接用于图像生成模型的中文描述，涵盖主体、场景、风格、构图与光线，不要解释。'
                  },
                  { type: 'image_url', image_url: { url: image } }
                ]
              }
            ]
          }),
          signal: guard.signal
        })
        const body = (await response.json().catch(() => null)) as {
          choices?: Array<{ message?: { content?: unknown } }>
          error?: unknown
        } | null
        if (!response.ok) {
          const message =
            body && typeof body === 'object' && 'error' in body
              ? JSON.stringify(body.error)
              : `HTTP ${response.status}`
          throw new Error(`图片理解失败: ${message}`)
        }
        const content = body?.choices?.[0]?.message?.content
        const text = typeof content === 'string' ? content.trim() : ''
        if (!text) throw new Error('模型没有返回图片描述')
        return { text }
      } finally {
        guard.dispose()
      }
    },
    async generateAudio() {
      throw new Error('当前 Provider 未声明统一音频生成协议')
    },
    async generateVideo() {
      throw new Error('当前 Provider 未声明统一视频生成协议')
    }
  }
}
