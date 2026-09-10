import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import Database from 'better-sqlite3'
import { runMigrations } from '../../db/migrations.js'
import type { MediaProviderRow } from '../adapter.js'
import { apimartAdapter } from '../adapters/apimart.js'
import { openaiImagesAdapter } from '../adapters/openai-images.js'
import { MediaProviderStore } from '../media-provider-store.js'
import {
  MEDIA_PROVIDER_ADAPTERS,
  MediaProviderRegistry,
  createMediaProviderRegistry
} from '../registry.js'

describe('MediaProviderRegistry', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  const store = new MediaProviderStore(db)

  afterEach(() => {
    db.exec('DELETE FROM media_providers')
  })
  afterAll(() => db.close())

  const createImageProvider = (
    overrides: Partial<Parameters<typeof store.create>[0]> = {}
  ): MediaProviderRow =>
    store.create({
      name: '生图 Provider',
      modality: 'image',
      adapter: 'openai-images',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-image-1',
      ...overrides
    })

  it('registers the builtin adapters via the factory and lists them by modality', () => {
    expect(MEDIA_PROVIDER_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      'openai-images',
      'apimart'
    ])

    const registry = createMediaProviderRegistry(store)
    expect(registry.listAdapters('image')).toEqual([openaiImagesAdapter, apimartAdapter])
    expect(registry.listAdapters('audio')).toEqual([])
    expect(registry.listAdapters('video')).toEqual([])
    expect(registry.listAdapters('text')).toEqual([])
  })

  it('starts empty when constructed directly so the factory owns default registration', () => {
    const bare = new MediaProviderRegistry(store)
    expect(bare.listAdapters('image')).toEqual([])
  })

  it('throws when registering a duplicate adapter id', () => {
    const registry = createMediaProviderRegistry(store)
    expect(() => registry.register(openaiImagesAdapter)).toThrow('已注册')
    expect(() => registry.register({ ...apimartAdapter, label: '重复 id' })).toThrow('已注册')
  })

  it('resolves an explicit providerId to its adapter and row context', async () => {
    const row = store.create({
      name: 'APIMart',
      modality: 'image',
      adapter: 'apimart',
      baseUrl: 'https://api.apimart.example',
      apiKey: 'am-key',
      model: 'gpt-image-2',
      params: { resolution: '2k', language: 'zh' }
    })

    const registry = createMediaProviderRegistry(store)
    const resolved = await registry.resolve('image', { providerId: row.id })
    expect(resolved.providerId).toBe(row.id)
    expect(resolved.adapter).toBe(apimartAdapter)
    expect(resolved.ctx).toEqual({
      providerId: row.id,
      baseUrl: 'https://api.apimart.example',
      apiKey: 'am-key',
      model: 'gpt-image-2',
      params: { resolution: '2k', language: 'zh' }
    })
  })

  it('falls back to the modality default when no providerId is given', async () => {
    createImageProvider()
    const second = store.create({
      name: 'APIMart 默认',
      modality: 'image',
      adapter: 'apimart',
      baseUrl: 'https://api.apimart.example'
    })
    store.setDefault(second.id)

    const registry = createMediaProviderRegistry(store)
    const resolved = await registry.resolve('image')
    expect(resolved.providerId).toBe(second.id)
    expect(resolved.adapter).toBe(apimartAdapter)
  })

  it('falls back to the modality default when the explicit providerId does not exist', async () => {
    const fallback = createImageProvider({ name: '兜底默认' })
    store.setDefault(fallback.id)

    const registry = createMediaProviderRegistry(store)
    const resolved = await registry.resolve('image', { providerId: 'no-such-provider' })
    expect(resolved.providerId).toBe(fallback.id)
  })

  it('falls back to the modality default when the explicit providerId belongs to another modality', async () => {
    const audioRow = store.create({
      name: '音频位误传',
      modality: 'audio',
      adapter: 'openai-images'
    })
    const fallback = createImageProvider({ name: '图片默认' })
    store.setDefault(fallback.id)

    const registry = createMediaProviderRegistry(store)
    const resolved = await registry.resolve('image', { providerId: audioRow.id })
    expect(resolved.providerId).toBe(fallback.id)
  })

  it('skips a disabled explicit providerId and falls back to the enabled default', async () => {
    const disabled = createImageProvider({ name: '已停用' })
    const fallback = createImageProvider({ name: '启用默认' })
    store.setDefault(fallback.id)
    store.update(disabled.id, { enabled: false })

    const registry = createMediaProviderRegistry(store)
    const resolved = await registry.resolve('image', { providerId: disabled.id })
    expect(resolved.providerId).toBe(fallback.id)
  })

  it('throws the guidance message when the modality default is disabled', async () => {
    const only = createImageProvider({ name: '唯一' })
    store.setDefault(only.id)
    store.update(only.id, { enabled: false })

    const registry = createMediaProviderRegistry(store)
    await expect(registry.resolve('image')).rejects.toThrow(
      '图片尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
  })

  it('throws per-modality guidance messages when the modality has no configured provider', async () => {
    const registry = createMediaProviderRegistry(store)
    await expect(registry.resolve('image')).rejects.toThrow(
      '图片尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
    await expect(registry.resolve('video')).rejects.toThrow(
      '视频尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
    await expect(registry.resolve('audio')).rejects.toThrow(
      '音频尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
  })

  it('injects the host logger into resolved contexts', async () => {
    const row = createImageProvider()
    store.setDefault(row.id)
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as FastifyBaseLogger

    const registry = createMediaProviderRegistry(store, { logger })
    const resolved = await registry.resolve('image')
    expect(resolved.ctx.logger).toBe(logger)
  })

  it('rejects rows whose adapter is not registered', async () => {
    const row = createImageProvider({ name: '未知适配器', adapter: 'openai-audio' })

    const registry = createMediaProviderRegistry(store)
    await expect(registry.resolve('image', { providerId: row.id })).rejects.toThrow(
      `媒体 Provider "${row.id}" 的适配器 "openai-audio" 未注册`
    )
  })

  it('bridges the text modality to the host text bridge without touching the store', async () => {
    const bridge = vi.fn(async (providerId?: string) => ({
      providerId: providerId ?? 'bridge-default',
      adapter: openaiImagesAdapter,
      ctx: {
        providerId: providerId ?? 'bridge-default',
        baseUrl: '',
        apiKey: '',
        model: '',
        params: {}
      }
    }))
    const registry = createMediaProviderRegistry(store, { textBridge: bridge })

    const resolved = await registry.resolve('text', { providerId: 'llm-1' })
    expect(bridge).toHaveBeenCalledWith('llm-1')
    expect(resolved.providerId).toBe('llm-1')

    await registry.resolve('text')
    expect(bridge).toHaveBeenLastCalledWith(undefined)
  })

  it('throws the text guidance message when no bridge is provided', async () => {
    const registry = createMediaProviderRegistry(store)
    await expect(registry.resolve('text')).rejects.toThrow(
      '文字尚未配置生成 Provider，请到 设置 → 媒体生成 配置'
    )
  })
})
