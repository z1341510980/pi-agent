import { afterAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createMediaGenerator, parseImages, splitModel } from './media-generator.js'
import { ProviderConfigStore } from './provider-config-store.js'
import { runMigrations } from '../db/migrations.js'

describe('media generator', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  const store = new ProviderConfigStore(db)
  const generator = createMediaGenerator(store)

  afterAll(() => db.close())

  it('splits provider-scoped model ids and falls back to the default provider', () => {
    expect(splitModel('openai:gpt-image-1', 'fallback')).toEqual({ providerId: 'openai', modelId: 'gpt-image-1' })
    expect(splitModel('gpt-image-1', 'fallback')).toEqual({ providerId: 'fallback', modelId: 'gpt-image-1' })
    expect(splitModel(undefined, 'fallback')).toEqual({ providerId: 'fallback' })
  })

  it('parses b64 and url image payloads', () => {
    expect(parseImages({ data: [{ b64_json: 'abc' }, { url: 'https://example.com/a.png' }, {}] })).toEqual([
      'data:image/png;base64,abc',
      'https://example.com/a.png'
    ])
    expect(parseImages(null)).toEqual([])
  })

  it('fails image generation with a clear error when no provider exists', async () => {
    await expect(generator.generateImage({ prompt: 'a cat' })).rejects.toThrow('未配置图片 Provider')
  })

  it('rejects audio/video generation with an explicit unsupported error', async () => {
    await expect(generator.generateAudio({ prompt: 'x' })).rejects.toThrow(/音频生成协议/)
    await expect(generator.generateVideo({ prompt: 'x' })).rejects.toThrow(/视频生成协议/)
  })
})
