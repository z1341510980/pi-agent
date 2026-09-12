/**
 * 服务端资产路径引用归一化（画布资产化引用设计 Task 2）：
 * reverse-prompt / edit-image / generate-media 的图片入参可能是本地资产路径，
 * 插件层必须先经 referencesToDataUrls 归一化成 data URL 再交给 adapter/分析器。
 * 用真实 createInfiniteCanvasPlugin 装配（内存库 + 全量插件迁移），
 * 上游 Provider 请求经 stub fetch 捕获断言。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInfiniteCanvasPlugin } from '../index.js'
import { infiniteCanvasMigrations } from '../migrations.js'
import { MediaLogStore } from '../canvas-assets.js'
import { MediaProviderStore } from '../media/media-provider-store.js'
import type { PluginContext, RouteDefinition } from '../../../core/plugin/plugin-types.js'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`

interface ReplyMock {
  code: (statusCode: number) => ReplyMock
  send: (payload: unknown) => unknown
  statusCode: number
  payload: unknown
}

function replyMock(): ReplyMock {
  const reply: ReplyMock = {
    code: (statusCode) => {
      reply.statusCode = statusCode
      return reply
    },
    send: (payload) => {
      reply.payload = payload
      return payload
    },
    statusCode: 200,
    payload: undefined
  }
  return reply
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const logStub = { info: () => undefined, warn: () => undefined, error: () => undefined } as never

describe('画布媒体路由的资产路径归一化', () => {
  const dataDir = mkdtempSync(join(tmpdir(), `canvas-refs-plugin-${process.pid}`))
  const db = new Database(':memory:')
  for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
  const routes: RouteDefinition[] = []

  // Provider 默认行：adapter 请求落到 stub fetch（真实请求不会出网）
  const mediaStore = new MediaProviderStore(db)
  const imageProvider = mediaStore.create({
    name: '生图 Provider',
    modality: 'image',
    adapter: 'openai-images',
    baseUrl: 'https://images.test/v1',
    apiKey: 'sk-image',
    model: 'gpt-image-1'
  })
  mediaStore.setDefault(imageProvider.id)
  const videoProvider = mediaStore.create({
    name: '视频 Provider',
    modality: 'video',
    adapter: 'newapi-video',
    baseUrl: 'https://video.test/v1',
    apiKey: 'sk-video',
    model: 'kling-v1'
  })
  mediaStore.setDefault(videoProvider.id)

  beforeAll(() => {
    // CanvasAssetStore 落盘目录来自 PI_DATA_DIR，必须在 setup 前指向临时目录
    process.env.PI_DATA_DIR = dataDir
    createInfiniteCanvasPlugin().setup({
      pluginName: 'infinite-canvas',
      config: {},
      cwd: process.cwd(),
      dataDir,
      db,
      logger: { child: () => logStub, info: () => undefined } as never,
      resolvePath: (...segments: string[]) => join(dataDir, ...segments),
      registerBackgroundWork: () => undefined,
      effect: () => () => undefined,
      registerDisposable: () => () => undefined,
      trackSession: () => () => undefined,
      registerTool: () => undefined,
      registerRoute: (route: RouteDefinition) => {
        routes.push(route)
      },
      onEvent: () => undefined,
      registerPanel: () => undefined,
      registerSettings: () => undefined,
      registerMigration: () => undefined,
      registerSessionTools: () => undefined,
      registerService: () => undefined,
      registerPromptTemplates: () => undefined,
      createSession: async () => {
        throw new Error('测试不触发画布 Agent 会话')
      },
      createAgUiSession: async () => {
        throw new Error('测试不触发 AG-UI 会话')
      },
      // 反推提示词的文字模型桥接：指向假端点，经 stub fetch 捕获
      textBridge: async () => ({
        baseUrl: 'https://vision.test',
        apiKey: 'sk-vision',
        model: 'vision-model',
        headers: {}
      })
    } as unknown as PluginContext)
  })
  afterAll(() => {
    db.close()
    delete process.env.PI_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  const routeFor = (method: string, path: string): RouteDefinition =>
    routes.find((route) => route.method === method && route.path === path)!

  let projectId = ''
  beforeAll(async () => {
    const result = (await routeFor('POST', '/projects').handler(
      { body: { title: '归一化测试画布' } },
      replyMock()
    )) as { data: { id: string } }
    projectId = result.data.id
  })

  /** 经 POST /assets 上传 data URL，得到行存在且文件已落盘的资产路径 */
  const uploadAsset = async (): Promise<string> => {
    const result = (await routeFor('POST', '/assets').handler(
      { body: { dataUrl: PNG_DATA_URL } },
      replyMock()
    )) as { data: { path: string } }
    return result.data.path
  }

  it('reverse-prompt：资产路径原图归一化成 data URL 再交给视觉分析器', async () => {
    const assetPath = await uploadAsset()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '一只橘猫在晒太阳' } }] })
      )
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    const result = (await routeFor('POST', '/projects/:projectId/reverse-prompt').handler(
      { params: { projectId }, body: { image: assetPath, instruction: '反推画面' } },
      reply
    )) as { data: { text: string } }

    expect(reply.statusCode).toBe(200)
    expect(result.data.text).toBe('一只橘猫在晒太阳')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/chat/completions')
    const payload = JSON.parse(String(init.body)) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>
    }
    expect(payload.messages[0].content[1].image_url?.url).toBe(PNG_DATA_URL)
  })

  it('reverse-prompt：资产不存在时报 502 可见错误而不是静默失败', async () => {
    const reply = replyMock()
    await routeFor('POST', '/projects/:projectId/reverse-prompt').handler(
      { params: { projectId }, body: { image: '/api/plugins/infinite-canvas/assets/missing-id' } },
      reply
    )

    expect(reply.statusCode).toBe(502)
    expect(reply.payload).toMatchObject({
      ok: false,
      error: {
        code: 'REVERSE_PROMPT_FAILED',
        message: expect.stringContaining('参考图资产不存在')
      }
    })
  })

  it('edit-image：images 里的资产路径与 data URL 都归一化，不再被预过滤丢弃', async () => {
    const assetPath = await uploadAsset()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }))
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    await routeFor('POST', '/projects/:projectId/edit-image').handler(
      {
        params: { projectId },
        body: { prompt: '换成夜景', image: assetPath, images: [assetPath, PNG_DATA_URL] }
      },
      reply
    )

    expect(reply.statusCode).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const payload = JSON.parse(String(init.body)) as { image: string[] }
    expect(payload.image).toHaveLength(3)
    for (const image of payload.image) expect(image).toMatch(/^data:image\/png;base64,/)
    expect(payload.image).toContain(PNG_DATA_URL)
  })

  it('edit-image：资产路径蒙版归一化成 data URL 发给 adapter，日志仍登记资产', async () => {
    const maskPath = await uploadAsset()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }))
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    await routeFor('POST', '/projects/:projectId/edit-image').handler(
      {
        params: { projectId },
        body: { prompt: '局部重绘蒙版', image: PNG_DATA_URL, mask: maskPath }
      },
      reply
    )

    expect(reply.statusCode).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const payload = JSON.parse(String(init.body)) as { mask?: string }
    // 蒙版内容与资产一致，内容去重后 adapter 拿到的正是原资产内容
    expect(payload.mask).toBe(PNG_DATA_URL)

    const logs = new MediaLogStore(db).list(10)
    expect(logs.find((entry) => entry.prompt === '局部重绘蒙版')).toMatchObject({
      kind: 'edit',
      maskPath
    })
  })

  it('generate-media：视频首帧资产路径归一化成 data URL 发给 adapter', async () => {
    const assetPath = await uploadAsset()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example.com/out.mp4' }))
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    await routeFor('POST', '/projects/:projectId/generate-media').handler(
      {
        params: { projectId },
        body: { mode: 'video', prompt: '让画面动起来', image: assetPath }
      },
      reply
    )

    expect(reply.statusCode).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const payload = JSON.parse(String(init.body)) as { image?: string }
    expect(payload.image).toBe(PNG_DATA_URL)
  })

  it('generate-media：refImages 全部归一化并按 ref_image_N 走 /v1/videos 多参考协议', async () => {
    const assetPath = await uploadAsset()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example.com/ref-out.mp4' }))
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    await routeFor('POST', '/projects/:projectId/generate-media').handler(
      {
        params: { projectId },
        body: { mode: 'video', prompt: '多参考生成', refImages: [assetPath, PNG_DATA_URL] }
      },
      reply
    )

    expect(reply.statusCode).toBe(200)
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // 多参考协议：提交端点切换为 POST {base}/v1/videos
    expect(endpoint).toBe('https://video.test/v1/videos')
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>
    // 资产路径已归一化成 data URL；data URL 原样透传
    expect(payload.ref_image_0).toBe(PNG_DATA_URL)
    expect(payload.ref_image_1).toBe(PNG_DATA_URL)
    // 协议不带文档协议的 image 字段
    expect(payload.image).toBeUndefined()
  })

  it('generate-media：refImages 过滤非字符串项并封顶 8 张', async () => {
    const refImages = [
      ...Array.from({ length: 9 }, (_, index) => `data:image/png;base64,${index}`),
      42,
      ''
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example.com/capped.mp4' }))
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    await routeFor('POST', '/projects/:projectId/generate-media').handler(
      {
        params: { projectId },
        body: { mode: 'video', prompt: '封顶校验', refImages }
      },
      reply
    )

    expect(reply.statusCode).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>
    const refKeys = Object.keys(payload).filter((key) => key.startsWith('ref_image_'))
    expect(refKeys).toHaveLength(8)
    expect(payload.ref_image_7).toBe('data:image/png;base64,7')
    expect(payload.ref_image_8).toBeUndefined()
  })
})
