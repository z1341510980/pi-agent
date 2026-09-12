/**
 * 视频异步任务队列（设计 Task 2/3 服务端）：
 * 迁移 020 任务表、generate-media 视频提交即返回（异步任务行落库）、
 * audio 同步回归、refresh 成功本地化（SUCCESS 形状 → 下载 → /assets video/mp4）、
 * refresh 失败（fail_reason）、worker 超时标记 + timeout 任务恢复、
 * 以及 adapter 无 submitVideoTask 时的同步兜底。
 * 用真实 createInfiniteCanvasPlugin 装配（内存库 + 全量插件迁移 + tmpdir PI_DATA_DIR），
 * 上游 Provider 请求经 stub fetch 捕获断言。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInfiniteCanvasPlugin } from '../index.js'
import { infiniteCanvasMigrations } from '../migrations.js'
import { ASSET_PATH_PREFIX } from '../canvas-assets.js'
import { clearAimanplayOssCaches } from '../media/aimanplay-oss.js'
import type { CanvasVideoTaskStore } from '../canvas-video-tasks.js'
import { MediaProviderStore } from '../media/media-provider-store.js'
import type { MediaProviderRegistry } from '../media/registry.js'
import type { PluginContext, RouteDefinition } from '../../../core/plugin/plugin-types.js'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`

/** 模拟站点 STS 接口响应（api.md §3.1）：视频 Provider baseUrl 为 https://video.test/v1。 */
const OSS_STS_BODY = {
  success: true,
  enabled: true,
  message: '',
  host: 'https://ref-bucket.oss-cn-hangzhou.aliyuncs.com',
  region: 'oss-cn-hangzhou',
  bucket: 'ref-bucket',
  dir: 'canvas-refs',
  accessKeyId: 'STS_AK',
  accessKeySecret: 'STS_SK',
  securityToken: 'STS_TOKEN',
  expiration: new Date(Date.now() + 3600_000).toISOString(),
  maxImageBytes: 10 * 1024 * 1024,
  maxAudioBytes: 20 * 1024 * 1024
}

/** NewAPI 兼容网关的真实完成响应：status 大写 SUCCESS、url 藏在 data.result_url。 */
const LIVE_COMPLETED_BODY = (taskId: string, url: string): Record<string, unknown> => ({
  code: 'success',
  message: '',
  data: {
    id: 1297,
    task_id: taskId,
    status: 'SUCCESS',
    fail_reason: '',
    result_url: url,
    progress: '100%',
    data: {
      msg: '任务完成',
      code: 'Success',
      data: { status: 'SUCCESS', results: [{ url }] }
    }
  }
})

/** NewAPI 兼容网关的真实失败响应：status FAIL + data.fail_reason 携带失败原因。 */
const LIVE_FAILED_BODY = (taskId: string): Record<string, unknown> => ({
  code: 'success',
  message: '',
  data: {
    id: 1298,
    task_id: taskId,
    status: 'FAIL',
    fail_reason: '队列超时，任务已取消',
    result_url: '',
    progress: '0%',
    data: { msg: '', code: 'Fail', data: { status: 'FAIL', results: [] } }
  }
})

interface ReplyMock {
  code: (statusCode: number) => ReplyMock
  send: (payload: unknown) => unknown
  header: (name: string, value: string) => ReplyMock
  redirect: (url: string, code: number) => unknown
  statusCode: number
  payload: unknown
  headers: Record<string, string>
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
    header: (name, value) => {
      reply.headers[name] = value
      return reply
    },
    redirect: (url, code) => {
      reply.statusCode = code
      reply.headers.Location = url
      return undefined
    },
    statusCode: 200,
    payload: undefined,
    headers: {}
  }
  return reply
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const binaryResponse = (bytes: Buffer, contentType: string): Response =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': contentType } })

const logStub = { info: () => undefined, warn: () => undefined, error: () => undefined } as never

describe('画布视频异步任务队列（服务端）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), `canvas-video-tasks-${process.pid}`))
  const db = new Database(':memory:')
  for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
  const routes: RouteDefinition[] = []
  const services = new Map<string, unknown>()

  // Provider 默认行：adapter 请求落到 stub fetch（真实请求不会出网）
  const mediaStore = new MediaProviderStore(db)
  const videoProvider = mediaStore.create({
    name: '视频 Provider',
    modality: 'video',
    adapter: 'newapi-video',
    baseUrl: 'https://video.test/v1',
    apiKey: 'sk-video',
    model: 'kling-v1'
  })
  mediaStore.setDefault(videoProvider.id)
  const audioProvider = mediaStore.create({
    name: '音频 Provider',
    modality: 'audio',
    adapter: 'openai-audio',
    baseUrl: 'https://audio.test/v1',
    apiKey: 'sk-audio',
    model: 'tts-1'
  })
  mediaStore.setDefault(audioProvider.id)

  let videoTasks: CanvasVideoTaskStore
  let tick: () => Promise<void>

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
      registerService: (name: string, service: unknown) => {
        services.set(name, service)
      },
      registerPromptTemplates: () => undefined,
      createSession: async () => {
        throw new Error('测试不触发画布 Agent 会话')
      },
      createAgUiSession: async () => {
        throw new Error('测试不触发 AG-UI 会话')
      },
      textBridge: async () => null
    } as unknown as PluginContext)

    const queue = services.get('infiniteCanvasVideoTaskQueue') as {
      store: CanvasVideoTaskStore
      tick: () => Promise<void>
    }
    videoTasks = queue.store
    tick = queue.tick
  })
  afterAll(() => {
    db.close()
    delete process.env.PI_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearAimanplayOssCaches()
  })

  const routeFor = (method: string, path: string): RouteDefinition =>
    routes.find((route) => route.method === method && route.path === path)!

  let projectId = ''
  beforeAll(async () => {
    const result = (await routeFor('POST', '/projects').handler(
      { body: { title: '视频任务测试画布' } },
      replyMock()
    )) as { data: { id: string } }
    projectId = result.data.id
  })

  /** 把现存 running 任务的 updated_at 全部刷新到当前：隔离 worker stale 判定，保证用例确定性 */
  const touchAllRunningTasks = (): void => {
    db.prepare('UPDATE infinite_canvas_video_tasks SET updated_at = ?').run(Date.now())
  }

  it('迁移 020 建立 infinite_canvas_video_tasks 表、索引与列默认值', () => {
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'infinite_canvas_video_tasks'"
        )
        .get()
    ).toBeTruthy()
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_infinite_canvas_video_tasks_project'"
        )
        .get()
    ).toBeTruthy()

    db.prepare(
      `INSERT INTO infinite_canvas_video_tasks (id, project_id, provider_id, task_id, created_at, updated_at)
       VALUES ('m20-row', 'p', 'pv', 't', 1, 1)`
    ).run()
    const row = db
      .prepare("SELECT * FROM infinite_canvas_video_tasks WHERE id = 'm20-row'")
      .get() as Record<string, unknown>
    expect(row.status).toBe('running')
    expect(row.protocol).toBe('videos')
    expect(row.params).toBe('{}')
    expect(row.node_id).toBeNull()
    expect(row.result_path).toBeNull()
  })

  it('generate-media 视频：提交异步任务立即返回 videoTask，行落库带 node_id/协议且不轮询', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // 参考图 URL 化链路：data URL → STS + 签名 PUT → OSS 公开 URL → 提交体
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/video-upload/oss-sts')) return jsonResponse(OSS_STS_BODY)
      if (url.includes('.aliyuncs.com')) return new Response('', { status: 200 })
      return jsonResponse({
        code: 'success',
        message: '',
        data: { task_id: 'task-x', status: 'QUEUED' }
      })
    })

    const reply = replyMock()
    const result = (await routeFor('POST', '/projects/:projectId/generate-media').handler(
      {
        params: { projectId },
        body: {
          mode: 'video',
          prompt: '多参考生成',
          nodeId: 'node-video-1',
          refImages: [PNG_DATA_URL],
          seconds: 5
        }
      },
      reply
    )) as {
      data: { videoTask?: { id: string; taskId: string; status: string }; outputs?: unknown }
    }

    expect(reply.statusCode).toBe(200)
    expect(result.data.videoTask).toMatchObject({ taskId: 'task-x', status: 'running' })
    expect(result.data.videoTask?.id).toBeTruthy()
    // 异步响应没有 outputs
    expect(result.data.outputs).toBeUndefined()
    // 只有提交链路 fetch（STS + PUT + 提交），不轮询
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe('https://video.test/api/video-upload/oss-sts')
    const [endpoint, init] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(endpoint).toBe('https://video.test/v1/videos')
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(String(payload.ref_image_0)).toMatch(
      /^https:\/\/ref-bucket\.oss-cn-hangzhou\.aliyuncs\.com\/canvas-refs\/[0-9a-f-]{36}\.png$/
    )
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-video')

    const row = videoTasks.get(result.data.videoTask!.id)!
    expect(row).toMatchObject({
      projectId,
      nodeId: 'node-video-1',
      taskId: 'task-x',
      protocol: 'videos',
      status: 'running',
      providerId: videoProvider.id
    })
    expect(row.params).toMatchObject({ refImages: 1, duration: 5 })
  })

  it('generate-media 音频：保持同步 outputs 语义，不创建任务行', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(binaryResponse(Buffer.from('ID3 fake mp3'), 'audio/mpeg'))
    vi.stubGlobal('fetch', fetchMock)
    const rowsBefore = videoTasks.listByProject(projectId).length

    const reply = replyMock()
    const result = (await routeFor('POST', '/projects/:projectId/generate-media').handler(
      { params: { projectId }, body: { mode: 'audio', prompt: '合成语音' } },
      reply
    )) as { data: { outputs?: Array<{ url: string; mimeType: string }>; videoTask?: unknown } }

    expect(reply.statusCode).toBe(200)
    expect(result.data.outputs).toHaveLength(1)
    expect(result.data.outputs?.[0].mimeType).toBe('audio/mpeg')
    expect(result.data.videoTask).toBeUndefined()
    expect(videoTasks.listByProject(projectId)).toHaveLength(rowsBefore)
  })

  it('refresh 成功：SUCCESS 形状 → 下载视频本地化 → 行 success 且 /assets 以 video/mp4 服务', async () => {
    const task = videoTasks.create({
      projectId,
      providerId: videoProvider.id,
      taskId: 'task-success',
      protocol: 'videos',
      model: 'kling-v1'
    })
    const videoBytes = Buffer.from('fake mp4 payload for asset test')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          LIVE_COMPLETED_BODY(
            'task-success',
            'https://cdn.video.example/live/result.mp4?Signature=abc'
          )
        )
      )
      .mockResolvedValueOnce(binaryResponse(videoBytes, 'video/mp4'))
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    const result = (await routeFor(
      'POST',
      '/projects/:projectId/video-tasks/:taskId/refresh'
    ).handler({ params: { projectId, taskId: task.id } }, reply)) as {
      data: { task: { id: string; status: string; resultPath?: string; progress?: string } }
    }

    expect(reply.statusCode).toBe(200)
    expect(result.data.task).toMatchObject({
      id: task.id,
      taskId: 'task-success',
      status: 'success'
    })
    expect(result.data.task.progress).toBe('100%')
    const resultPath = result.data.task.resultPath ?? ''
    expect(resultPath.startsWith(`${ASSET_PATH_PREFIX}/`)).toBe(true)

    // 轮询端点按协议拼装；第二个请求是结果下载
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://video.test/v1/videos/task-success')
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://cdn.video.example/live/result.mp4?Signature=abc'
    )

    // 文件落在 tmpdir 资产目录且字节一致
    const assetId = resultPath.slice(ASSET_PATH_PREFIX.length + 1)
    const assetRow = db
      .prepare('SELECT file_path, mime FROM infinite_canvas_assets WHERE id = ?')
      .get(assetId) as { file_path: string; mime: string }
    expect(assetRow.mime).toBe('video/mp4')
    expect(assetRow.file_path.startsWith(join(dataDir, 'agent', 'canvas-assets'))).toBe(true)
    expect(existsSync(assetRow.file_path)).toBe(true)
    expect(readFileSync(assetRow.file_path).equals(videoBytes)).toBe(true)

    // GET /assets/:assetId 以真实 video/mp4 Content-Type 服务
    const assetReply = replyMock()
    const assetResponse = (await routeFor('GET', '/assets/:assetId').handler(
      { params: { assetId } },
      assetReply
    )) as Buffer
    expect(assetReply.statusCode).toBe(200)
    expect(assetReply.headers['Content-Type']).toBe('video/mp4')
    expect(Buffer.from(assetResponse).equals(videoBytes)).toBe(true)
  })

  it('refresh 失败：fail_reason 落到行 error，状态 failed', async () => {
    const task = videoTasks.create({
      projectId,
      providerId: videoProvider.id,
      taskId: 'task-failed',
      protocol: 'generations'
    })
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(LIVE_FAILED_BODY('task-failed')))
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    const result = (await routeFor(
      'POST',
      '/projects/:projectId/video-tasks/:taskId/refresh'
    ).handler({ params: { projectId, taskId: task.id } }, reply)) as {
      data: { task: { status: string; error?: string | null } }
    }

    expect(reply.statusCode).toBe(200)
    expect(result.data.task.status).toBe('failed')
    expect(result.data.task.error).toBe('队列超时，任务已取消')
    // 文档协议轮询端点
    expect(fetchMock.mock.calls[0][0]).toBe('https://video.test/v1/video/generations/task-failed')
  })

  it('refresh：未知任务行返回 404 可读错误', async () => {
    const reply = replyMock()
    await routeFor('POST', '/projects/:projectId/video-tasks/:taskId/refresh').handler(
      { params: { projectId, taskId: 'missing-task-id' } },
      reply
    )
    expect(reply.statusCode).toBe(404)
    expect(reply.payload).toMatchObject({ ok: false, error: '视频任务不存在' })
  })

  it('refresh 短路：已 success 且带 result_path 的任务直接返回现值，不重复轮询/下载', async () => {
    const task = videoTasks.create({
      projectId,
      providerId: videoProvider.id,
      taskId: 'task-done',
      protocol: 'videos'
    })
    videoTasks.update(task.id, {
      status: 'success',
      resultPath: '/api/plugins/infinite-canvas/assets/already-stored'
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    const result = (await routeFor(
      'POST',
      '/projects/:projectId/video-tasks/:taskId/refresh'
    ).handler({ params: { projectId, taskId: task.id } }, reply)) as {
      data: { task: { id: string; status: string; resultPath?: string } }
    }

    expect(reply.statusCode).toBe(200)
    expect(result.data.task).toMatchObject({
      id: task.id,
      status: 'success',
      resultPath: '/api/plugins/infinite-canvas/assets/already-stored'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('DELETE /projects/:projectId 级联清理视频任务行（表无外键，防孤儿行）', async () => {
    const created = (await routeFor('POST', '/projects').handler(
      { body: { title: '待删除画布' } },
      replyMock()
    )) as { data: { id: string } }
    const doomedProjectId = created.data.id
    const task = videoTasks.create({
      projectId: doomedProjectId,
      providerId: videoProvider.id,
      taskId: 'task-orphan',
      protocol: 'videos'
    })
    expect(videoTasks.get(task.id)).toBeTruthy()

    const reply = replyMock()
    await routeFor('DELETE', '/projects/:projectId').handler(
      { params: { projectId: doomedProjectId } },
      reply
    )
    expect(reply.statusCode).toBe(200)
    expect(videoTasks.get(task.id)).toBeUndefined()
  })

  it('worker：created_at 超预算的 running 任务标 timeout；timeout 任务 refresh 可恢复 success', async () => {
    touchAllRunningTasks()
    const task = videoTasks.create({
      projectId,
      providerId: videoProvider.id,
      taskId: 'task-stale',
      protocol: 'videos'
    })
    db.prepare('UPDATE infinite_canvas_video_tasks SET created_at = ? WHERE id = ?').run(
      Date.now() - 61 * 60_000,
      task.id
    )

    await tick()
    expect(videoTasks.get(task.id)!.status).toBe('timeout')

    // timeout 任务上游其实已完成：手动 refresh 拉回结果并恢复 success
    const videoBytes = Buffer.from('recovered mp4 bytes')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(LIVE_COMPLETED_BODY('task-stale', 'https://cdn.video.example/recover.mp4'))
      )
      .mockResolvedValueOnce(binaryResponse(videoBytes, 'video/mp4'))
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    const result = (await routeFor(
      'POST',
      '/projects/:projectId/video-tasks/:taskId/refresh'
    ).handler({ params: { projectId, taskId: task.id } }, reply)) as {
      data: { task: { status: string; resultPath?: string } }
    }

    expect(reply.statusCode).toBe(200)
    expect(result.data.task.status).toBe('success')
    expect(result.data.task.resultPath).toBeTruthy()
    const assetId = result.data.task.resultPath!.slice(ASSET_PATH_PREFIX.length + 1)
    const assetRow = db
      .prepare('SELECT file_path FROM infinite_canvas_assets WHERE id = ?')
      .get(assetId) as { file_path: string }
    expect(readFileSync(assetRow.file_path).equals(videoBytes)).toBe(true)
  })

  it('GET video-tasks：列表按 created_at 倒序返回，resultPath 仅 success 携带', async () => {
    const reply = replyMock()
    const result = (await routeFor('GET', '/projects/:projectId/video-tasks').handler(
      { params: { projectId } },
      reply
    )) as {
      data: {
        tasks: Array<{
          id: string
          nodeId: string | null
          taskId: string
          status: string
          error: string | null
          resultPath?: string
          createdAt: number
        }>
      }
    }

    expect(reply.statusCode).toBe(200)
    const tasks = result.data.tasks
    expect(tasks.length).toBeGreaterThanOrEqual(4)
    const createdAtList = tasks.map((task) => task.createdAt)
    expect([...createdAtList].sort((a, b) => b - a)).toEqual(createdAtList)
    // 提交用例的 node_id 透传到列表
    const submitted = tasks.find((task) => task.taskId === 'task-x')
    expect(submitted?.nodeId).toBe('node-video-1')
    const successTask = tasks.find((task) => task.status === 'success')
    expect(successTask?.resultPath).toBeTruthy()
    const failedTask = tasks.find((task) => task.status === 'failed')
    expect(failedTask?.error).toBeTruthy()
    expect(failedTask?.resultPath).toBeUndefined()
  })

  it('adapter 无 submitVideoTask：generate-media 回落同步 outputs，不建任务行', async () => {
    const registry = services.get('infiniteCanvasMediaRegistry') as MediaProviderRegistry
    registry.register({
      id: 'fake-video-sync',
      label: 'Fake Video Sync',
      modality: 'video',
      capabilities: { generate: true },
      formSchema: [],
      generateVideo: async () => ({
        outputs: [{ url: 'data:video/mp4;base64,AAAA', mimeType: 'video/mp4' }]
      })
    })
    const fakeProvider = mediaStore.create({
      name: 'Fake 视频',
      modality: 'video',
      adapter: 'fake-video-sync',
      baseUrl: 'https://fake.test/v1',
      apiKey: '',
      model: 'fake-model'
    })
    const rowsBefore = videoTasks.listByProject(projectId).length
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const reply = replyMock()
    const result = (await routeFor('POST', '/projects/:projectId/generate-media').handler(
      {
        params: { projectId },
        body: { mode: 'video', prompt: '同步兜底', providerId: fakeProvider.id }
      },
      reply
    )) as { data: { outputs?: Array<{ url: string; mimeType: string }>; videoTask?: unknown } }

    expect(reply.statusCode).toBe(200)
    expect(result.data.outputs).toHaveLength(1)
    // data URL 产物同步落盘为本地资产
    expect(result.data.outputs?.[0].url.startsWith(`${ASSET_PATH_PREFIX}/`)).toBe(true)
    expect(result.data.videoTask).toBeUndefined()
    // 同步兜底不发任何上游请求，也不创建任务行
    expect(fetchMock).not.toHaveBeenCalled()
    expect(videoTasks.listByProject(projectId)).toHaveLength(rowsBefore)
  })
})
