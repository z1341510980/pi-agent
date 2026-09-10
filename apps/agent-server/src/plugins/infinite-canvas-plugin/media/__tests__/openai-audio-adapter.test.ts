import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaModalityContext } from '../adapter.js'
import {
  OPENAI_AUDIO_DEFAULT_MODEL,
  OPENAI_AUDIO_MAX_INPUT_CHARS,
  audioMimeForFormat,
  openaiAudioAdapter
} from '../adapters/openai-audio.js'

/**
 * openai-audio adapter 用例：/audio/speech payload、二进制响应 → data URL、
 * input 4096 上限报错、HTTP 错误透传、空 Key 不带鉴权头。
 */
describe('openai-audio adapter', () => {
  const adapter = openaiAudioAdapter

  const createContext = (overrides: Partial<MediaModalityContext> = {}): MediaModalityContext => ({
    providerId: 'tts',
    baseUrl: 'https://api.tts.example',
    apiKey: 'sk-tts',
    model: '',
    params: {},
    ...overrides
  })

  const audioResponse = (contentType = 'audio/mpeg', body = 'fake-audio-bytes'): Response =>
    new Response(Buffer.from(body), { status: 200, headers: { 'Content-Type': contentType } })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('posts the documented speech payload and converts the binary body into a data URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(audioResponse('audio/mpeg', 'mp3-bytes'))

    const result = await adapter.generateAudio!(createContext(), {
      prompt: '海浪声',
      voice: 'nova',
      format: 'mp3',
      speed: 1.5
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // base 无 /v1 时归一补齐（与图片协议同源）
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.tts.example/v1/audio/speech')
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect((request.headers as Record<string, string>).Authorization).toBe('Bearer sk-tts')
    expect(JSON.parse(String(request.body))).toEqual({
      model: OPENAI_AUDIO_DEFAULT_MODEL,
      input: '海浪声',
      voice: 'nova',
      response_format: 'mp3',
      speed: 1.5
    })
    expect(result.outputs).toEqual([
      {
        url: `data:audio/mpeg;base64,${Buffer.from('mp3-bytes').toString('base64')}`,
        mimeType: 'audio/mpeg'
      }
    ])
  })

  it('rejects input beyond the documented 4096 character limit without any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      adapter.generateAudio!(createContext(), { prompt: 'a'.repeat(OPENAI_AUDIO_MAX_INPUT_CHARS + 1) })
    ).rejects.toThrow('语音合成文本超过 4096 字符上限')
    expect(fetchMock).not.toHaveBeenCalled()

    // 恰好 4096 允许
    fetchMock.mockResolvedValueOnce(audioResponse())
    await expect(
      adapter.generateAudio!(createContext(), { prompt: 'a'.repeat(OPENAI_AUDIO_MAX_INPUT_CHARS) })
    ).resolves.toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('applies provider params and protocol defaults (voice/format/model, speed clamp passthrough)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(audioResponse('audio/wav'))

    const result = await adapter.generateAudio!(
      createContext({ params: { voice: 'onyx', format: 'wav', speed: '0.75' } }),
      { prompt: '鸟鸣' }
    )

    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      model: OPENAI_AUDIO_DEFAULT_MODEL,
      input: '鸟鸣',
      voice: 'onyx',
      response_format: 'wav',
      speed: 0.75
    })
    // 响应声明 audio/wav → data URL 与 mimeType 沿用声明
    expect(result.outputs[0].mimeType).toBe('audio/wav')
    expect(result.outputs[0].url.startsWith('data:audio/wav;base64,')).toBe(true)
  })

  it('omits the Authorization header when the provider has no api key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(audioResponse())

    await adapter.generateAudio!(createContext({ apiKey: '' }), { prompt: 'x' })

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('surfaces server-side error messages on http failures', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: '余额不足' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    await expect(
      adapter.generateAudio!(createContext(), { prompt: 'x' })
    ).rejects.toThrow('语音合成失败: 余额不足')
  })

  it('maps response formats to audio mime types with a sensible fallback', () => {
    expect(audioMimeForFormat('mp3')).toBe('audio/mpeg')
    expect(audioMimeForFormat('opus')).toBe('audio/opus')
    expect(audioMimeForFormat('wav')).toBe('audio/wav')
    expect(audioMimeForFormat('unknown')).toBe('audio/mpeg')
  })
})
