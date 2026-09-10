import { afterAll, afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../db/migrations.js'
import { MediaProviderStore } from '../media-provider-store.js'

describe('MediaProviderStore', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  const store = new MediaProviderStore(db)

  afterEach(() => {
    db.exec('DELETE FROM media_providers')
  })
  afterAll(() => db.close())

  it('creates a provider with generated id and defaults', () => {
    const created = store.create({
      name: '默认生图',
      modality: 'image',
      adapter: 'openai-images',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-image-1',
      params: { size: '1024x1024' }
    })
    expect(created.id).toMatch(/[0-9a-f-]{36}/)
    expect(created).toMatchObject({
      name: '默认生图',
      modality: 'image',
      adapter: 'openai-images',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-image-1',
      params: { size: '1024x1024' },
      enabled: true,
      isDefault: false
    })
    expect(created.createdAt).toBeGreaterThan(0)
    expect(created.updatedAt).toBeGreaterThan(0)

    expect(store.get(created.id)).toEqual(created)
  })

  it('lists providers and filters by modality', () => {
    const image = store.create({ name: 'img', modality: 'image', adapter: 'openai-images' })
    const audio = store.create({ name: 'tts', modality: 'audio', adapter: 'openai-audio' })

    expect(store.list().map((row) => row.id)).toEqual(expect.arrayContaining([image.id, audio.id]))
    expect(store.list('image').map((row) => row.id)).toEqual([image.id])
    expect(store.list('audio').map((row) => row.id)).toEqual([audio.id])
    expect(store.list('video')).toEqual([])
  })

  it('keeps the previous apiKey when a patch sends an empty key', () => {
    const created = store.create({
      name: 'key保留',
      modality: 'image',
      adapter: 'openai-images',
      apiKey: 'sk-old'
    })

    expect(store.update(created.id, { apiKey: '' })?.apiKey).toBe('sk-old')
    expect(store.update(created.id, { apiKey: '   ' })?.apiKey).toBe('sk-old')
    expect(store.update(created.id, { apiKey: 'sk-new' })?.apiKey).toBe('sk-new')
  })

  it('applies only provided fields on update', () => {
    const created = store.create({
      name: '原名',
      modality: 'image',
      adapter: 'apimart',
      baseUrl: 'https://a.example.com',
      model: 'm1',
      params: { resolution: '2k' }
    })

    expect(store.update(created.id, { model: 'm2', enabled: false })).toMatchObject({
      name: '原名',
      adapter: 'apimart',
      baseUrl: 'https://a.example.com',
      model: 'm2',
      enabled: false,
      params: { resolution: '2k' }
    })
    expect(store.update('missing', { name: 'x' })).toBeUndefined()
  })

  it('clears the default flag when the modality changes', () => {
    const provider = store.create({ name: '换模态', modality: 'image', adapter: 'openai-images' })
    store.setDefault(provider.id)
    const moved = store.update(provider.id, { modality: 'audio' })
    expect(moved?.isDefault).toBe(false)
    expect(store.resolveDefault('image')).toBeNull()
  })

  it('keeps default uniqueness per modality inside setDefault', () => {
    const first = store.create({ name: '图1', modality: 'image', adapter: 'openai-images' })
    const second = store.create({ name: '图2', modality: 'image', adapter: 'apimart' })
    const audio = store.create({ name: '音', modality: 'audio', adapter: 'openai-audio' })

    store.setDefault(first.id)
    expect(store.resolveDefault('image')?.id).toBe(first.id)

    store.setDefault(second.id)
    expect(store.resolveDefault('image')?.id).toBe(second.id)
    expect(
      store
        .list('image')
        .filter((row) => row.isDefault)
        .map((row) => row.id)
    ).toEqual([second.id])

    store.setDefault(audio.id)
    store.setDefault(second.id)
    expect(store.resolveDefault('audio')?.id).toBe(audio.id)
    expect(store.resolveDefault('video')).toBeNull()

    expect(() => store.setDefault('missing')).toThrow('不存在')
  })

  it('excludes disabled providers from resolveDefault', () => {
    const provider = store.create({ name: '禁用', modality: 'image', adapter: 'openai-images' })
    store.setDefault(provider.id)
    expect(store.resolveDefault('image')?.id).toBe(provider.id)

    store.update(provider.id, { enabled: false })
    expect(store.resolveDefault('image')).toBeNull()
    expect(store.list('image')).toHaveLength(1)
  })

  it('removes providers', () => {
    const provider = store.create({ name: '待删', modality: 'image', adapter: 'openai-images' })
    expect(store.remove(provider.id)).toBe(true)
    expect(store.get(provider.id)).toBeUndefined()
    expect(store.remove(provider.id)).toBe(false)
  })

  it('round-trips params JSON and falls back to empty params on corrupt data', () => {
    const provider = store.create({
      name: '坏参数',
      modality: 'image',
      adapter: 'openai-images',
      params: { size: '512x512' }
    })
    expect(store.get(provider.id)?.params).toEqual({ size: '512x512' })

    db.prepare('UPDATE media_providers SET params = ? WHERE id = ?').run('{not-json', provider.id)
    expect(store.get(provider.id)?.params).toEqual({})

    db.prepare('UPDATE media_providers SET params = ? WHERE id = ?').run('"scalar"', provider.id)
    expect(store.get(provider.id)?.params).toEqual({})
  })

  it('rejects text modality rows', () => {
    expect(() =>
      store.create({ name: 'x', modality: 'text' as never, adapter: 'openai-images' })
    ).toThrow('text')
  })
})
