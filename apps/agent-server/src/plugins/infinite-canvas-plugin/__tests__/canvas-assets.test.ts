import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageMimeFromBytes, CanvasAssetStore, MediaLogStore, referencesToDataUrls } from '../canvas-assets.js'
import { infiniteCanvasMigrations } from '../migrations.js'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG_BYTES = Buffer.from('ffd8ffe000104a464946', 'hex')
const WEBP_BYTES = Buffer.concat([
  Buffer.from('52494646', 'hex'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('57454250', 'hex')
])

function pngDataUrl(bytes: Buffer = PNG_BYTES): string {
  return `data:image/png;base64,${bytes.toString('base64')}`
}

describe('imageMimeFromBytes', () => {
  it('recognizes magic bytes first', () => {
    expect(imageMimeFromBytes(PNG_BYTES, 'application/octet-stream')).toBe('image/png')
    expect(imageMimeFromBytes(JPEG_BYTES, 'application/octet-stream')).toBe('image/jpeg')
    expect(imageMimeFromBytes(WEBP_BYTES, 'application/octet-stream')).toBe('image/webp')
    expect(imageMimeFromBytes(Buffer.from('GIF89a...'), '')).toBe('image/gif')
  })

  it('falls back to the declared content type, then to a safe default', () => {
    expect(imageMimeFromBytes(Buffer.from('not-an-image'), 'image/avif')).toBe('image/avif')
    expect(imageMimeFromBytes(Buffer.from('not-an-image'), 'text/html')).toBe('application/octet-stream')
    expect(imageMimeFromBytes(Buffer.from(''), '')).toBe('application/octet-stream')
  })
})

describe('CanvasAssetStore', () => {
  const dir = mkdtempSync(join(tmpdir(), `canvas-assets-test-${process.pid}`))
  const db = new Database(':memory:')
  for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
  const store = new CanvasAssetStore(db, dir)
  const projects = db.prepare(
    `INSERT INTO infinite_canvas_projects (id, title, description, viewport_json, created_at, updated_at)
     VALUES ('p1', 't', '', '{}', 1, 1)`
  )

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  afterEach(() => {
    db.exec('DELETE FROM infinite_canvas_assets; DELETE FROM infinite_canvas_projects;')
    vi.unstubAllGlobals()
  })

  it('stores a data URL on disk and returns a stable asset path', async () => {
    projects.run()

    const path = (await store.storeFromDataUrl('p1', pngDataUrl()))!
    expect(path).toBeTruthy()

    expect(path).toMatch(/^\/api\/plugins\/infinite-canvas\/assets\/[\w-]+$/)
    const asset = store.getAssetByPath(path)
    expect(asset).toMatchObject({ mime: 'image/png', bytes: PNG_BYTES.length, projectId: 'p1' })
    expect(existsSync(asset!.filePath)).toBe(true)
    expect(readFileSync(asset!.filePath)).toEqual(PNG_BYTES)
  })

  it('begins a remote download immediately and finishes it in the background', async () => {
    projects.run()
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.length), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    // 返回必须立即发生：慢 CDN 不能拖住生成响应
    const path = store.beginRemoteAsset('p1', 'https://cdn.example.com/4k.png')
    expect(path).toMatch(/^\/api\/plugins\/infinite-canvas\/assets\//)
    expect(store.getAssetByPath(path)).toMatchObject({
      status: 'downloading',
      sourceUrl: 'https://cdn.example.com/4k.png'
    })

    await store.whenIdle()
    expect(store.failureReason(path)).toBeUndefined()
    // 上游谎报 octet-stream 时按魔数纠正
    expect(store.getAssetByPath(path)).toMatchObject({ status: 'ready', mime: 'image/png' })
    const asset = store.getAssetByPath(path)!
    expect(readFileSync(asset.filePath)).toEqual(PNG_BYTES)
  })

  it('marks the asset failed when the background download fails', async () => {
    projects.run()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const path = store.beginRemoteAsset('p1', 'https://cdn.example.com/x.png')
    await store.whenIdle()

    expect(store.getAssetByPath(path)).toMatchObject({ status: 'failed' })
    expect(store.listProjectAssets('p1')).toHaveLength(1)
  })

  it('deletes project rows and their files', async () => {
    projects.run()
    const path = (await store.storeFromDataUrl('p1', pngDataUrl()))!
    expect(path).toBeTruthy()
    const asset = store.getAssetByPath(path)!
    expect(existsSync(asset.filePath)).toBe(true)

    store.deleteForProject('p1')

    expect(store.listProjectAssets('p1')).toHaveLength(0)
    expect(existsSync(asset.filePath)).toBe(false)
  })

  it('deduplicates identical content instead of storing it twice', async () => {
    projects.run()
    const first = store.storeFromDataUrl('p1', pngDataUrl())!
    const second = store.storeFromDataUrl('p1', pngDataUrl())!

    expect(second).toBe(first)
    expect(store.listProjectAssets('p1')).toHaveLength(1)
  })
})

describe('MediaLogStore', () => {
  const dir = mkdtempSync(join(tmpdir(), `canvas-mlog-test-${process.pid}`))
  const db = new Database(':memory:')
  for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
  const logs = new MediaLogStore(db)

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records entries with request and response details and lists newest first', () => {
    logs.insert({
      kind: 'edit',
      projectId: 'p1',
      endpoint: '/images/edits',
      model: 'gpt-image-2',
      size: '864x1536',
      prompt: '把背景换成竹林',
      references: [{ preview: '/api/plugins/infinite-canvas/assets/a-1', bytes: 123 }],
      maskPath: '/api/plugins/infinite-canvas/assets/m-1',
      responseImages: ['/api/plugins/infinite-canvas/assets/r-1'],
      status: 'ok',
      durationMs: 36000,
      traceId: 't-1'
    })
    logs.insert({
      kind: 'generate',
      projectId: 'p1',
      endpoint: '/images/generations',
      model: 'gpt-image-2',
      size: '864x1536',
      prompt: '一只猫',
      references: [],
      responseImages: [],
      status: 'error',
      error: '上游内容安全拒绝',
      durationMs: 4000,
      traceId: 't-2'
    })

    const list = logs.list(10)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ kind: 'generate', status: 'error', error: '上游内容安全拒绝' })
    expect(list[1]).toMatchObject({
      kind: 'edit',
      prompt: '把背景换成竹林',
      references: [{ preview: '/api/plugins/infinite-canvas/assets/a-1', bytes: 123 }],
      maskPath: '/api/plugins/infinite-canvas/assets/m-1',
      responseImages: ['/api/plugins/infinite-canvas/assets/r-1']
    })
  })

  it('prunes old entries beyond the retention limit', () => {
    for (let index = 0; index < 210; index++) {
      logs.insert({
        kind: 'generate',
        projectId: null,
        endpoint: '/images/generations',
        model: null,
        size: null,
        prompt: `p-${index}`,
        references: [],
        responseImages: [],
        status: 'ok',
        durationMs: 1,
        traceId: null
      })
    }
    expect(logs.list(1000)).toHaveLength(200)
    // 最新的保留，最老的被清掉
    expect(logs.list(1000)[0]?.prompt).toBe('p-209')
  })
})

describe('referencesToDataUrls', () => {
  const dir = mkdtempSync(join(tmpdir(), `canvas-refs-test-${process.pid}`))
  const db = new Database(':memory:')
  for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
  const store = new CanvasAssetStore(db, dir)
  db.prepare(
    `INSERT INTO infinite_canvas_projects (id, title, description, viewport_json, created_at, updated_at)
     VALUES ('p1', 't', '', '{}', 1, 1)`
  ).run()

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads local assets straight from disk into data URLs', async () => {
    const path = store.storeFromDataUrl('p1', pngDataUrl())!

    const refs = await referencesToDataUrls(store, [
      'data:image/webp;base64,KEEP',
      `http://127.0.0.1:3900/api/plugins/infinite-canvas/assets/${path.split('/').pop()}`,
      path
    ])

    expect(refs).toEqual([
      'data:image/webp;base64,KEEP',
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`
    ])
  })

  it('downloads http(s) references through the system proxy path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.length), {
          status: 200,
          headers: { 'Content-Type': 'image/png' }
        })
      )
    )

    const refs = await referencesToDataUrls(store, ['https://cdn.example.com/ref.png'])

    expect(refs).toEqual([`data:image/png;base64,${PNG_BYTES.toString('base64')}`])
  })

  it('throws a visible error instead of silently dropping broken references', async () => {
    await expect(
      referencesToDataUrls(store, ['/api/plugins/infinite-canvas/assets/missing-id'])
    ).rejects.toThrow('参考图')
  })
})
