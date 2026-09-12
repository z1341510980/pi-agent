import { failure, success } from '../../lib/api-response.js'
import { existsSync, readFileSync } from 'node:fs'
import type { RouteDefinition } from '../../core/plugin/plugin-types.js'
import type { InfiniteCanvasStore } from './store.js'
import type { AnyCanvasNodeType } from './types.js'
import type { PromptSourceService } from './prompt-source-service.js'
import type { MediaProviderRow } from './media/adapter.js'
import type { MediaProviderStore } from './media/media-provider-store.js'
import type { CanvasAssetStore, MediaLogStore } from './canvas-assets.js'
import { ASSET_PATH_PREFIX, imageMimeFromBytes } from './canvas-assets.js'
import {
  canvasImageDataUrls,
  formatCanvasGenerationContext,
  normalizeCanvasGenerationContext,
  type CanvasGenerationContext
} from './generation-context.js'

// 错误响应约定：上游生成失败（502）统一走 failure(code)，客户端可按 code 分支处理；
// 参数校验（400）/服务未就绪（503）/资源缺失（404）保持裸 {ok:false,error}，
// 客户端 apiErrorDetails 会回退 code='API_ERROR'（proxy-image 的二进制代理 502 除外）。

// 承载图片数据（参考图/蒙版/反推原图/图 JSON）的请求体上限：
// 本机回环服务，放宽到 128MB；参考图 base64 多张聚合后很容易超过 32MB（已实际发生）。
const MEDIA_BODY_LIMIT = 128 * 1024 * 1024

export type CanvasGenerateHandler = (input: {
  projectId: string
  nodeId?: string
  prompt: string
  mode?: string
  context?: string
  resourceContext?: CanvasGenerationContext
}) => Promise<string>

export type CanvasImageGenerateHandler = (input: {
  projectId?: string
  prompt: string
  context?: string
  resourceContext?: CanvasGenerationContext
  references?: string[]
  model?: string
  providerId?: string
  size?: string
  quality?: string
  background?: string
  count?: number
  traceId?: string
  signal?: AbortSignal
}) => Promise<{ images: string[] }>

export type CanvasMediaGenerateHandler = (input: {
  projectId?: string
  mode: 'audio' | 'video'
  prompt: string
  context?: string
  resourceContext?: CanvasGenerationContext
  model?: string
  providerId?: string
  voice?: string
  format?: string
  speed?: number
  size?: string
  seconds?: number
  image?: string
  generateAudio?: boolean
  watermark?: boolean
  signal?: AbortSignal
}) => Promise<{ outputs: Array<{ url: string; mimeType: string }> }>

export type CanvasImageEditHandler = (input: {
  projectId?: string
  prompt: string
  providerId?: string
  image: string
  images?: string[]
  mask?: string
  model?: string
  size?: string
  traceId?: string
  signal?: AbortSignal
}) => Promise<{ images: string[] }>

export type CanvasReversePromptHandler = (input: {
  image: string
  instruction?: string
  model?: string
  signal?: AbortSignal
}) => Promise<{ text: string }>

const NODE_TYPES = new Set<AnyCanvasNodeType>([
  'image',
  'text',
  'config',
  'video',
  'audio',
  'group',
  'design-board',
  'prompt',
  'file',
  'agent'
])

const EXTENSION_NODE_TYPE = /^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9_-]{0,63}$/

function body(request: { body?: unknown }): Record<string, unknown> {
  return request.body && typeof request.body === 'object'
    ? (request.body as Record<string, unknown>)
    : {}
}

function generationContext(input: Record<string, unknown>): {
  resourceContext?: CanvasGenerationContext
  context?: string
} {
  const resourceContext = normalizeCanvasGenerationContext(input.resourceContext)
  const structuredText = formatCanvasGenerationContext(resourceContext)
  const legacyText = typeof input.context === 'string' ? input.context.trim() : ''
  const context = [legacyText, structuredText].filter(Boolean).join('\n\n')
  return {
    ...(resourceContext ? { resourceContext } : {}),
    ...(context ? { context } : {})
  }
}

function requireNodeType(value: unknown): AnyCanvasNodeType {
  const type = String(value ?? 'text') as AnyCanvasNodeType
  if (!NODE_TYPES.has(type) && !EXTENSION_NODE_TYPE.test(type)) {
    throw new Error(`不支持的画布节点类型: ${type}`)
  }
  return type
}

/**
 * @deprecated 画布媒体配置已迁移到 media_providers 表（设置 → 媒体生成）。
 * 旧桌面端 CanvasMediaConfigStatus 形状的兼容视图：由 image 默认 Provider 行映射。
 */
interface CanvasMediaConfigStatus {
  configured: boolean
  baseUrl: string
  model: string
  imageSize: string
  imageProtocol: 'openai-images' | 'apimart'
  imageResolution: string
  imageLanguage: string
  keyHint: string
}

/** image 默认 Provider 行 → 旧媒体配置视图；无默认行时返回未配置空态。 */
function canvasMediaStatusFromRow(row: MediaProviderRow | null): CanvasMediaConfigStatus {
  return {
    configured: Boolean(row?.baseUrl && row.apiKey),
    baseUrl: row?.baseUrl ?? '',
    model: row?.model ?? '',
    imageSize: row?.params.size ?? '1024x1024',
    imageProtocol: row?.adapter === 'apimart' ? 'apimart' : 'openai-images',
    imageResolution: row?.params.resolution ?? '',
    imageLanguage: row?.params.language ?? 'en',
    keyHint: row?.apiKey ? `${row.apiKey.slice(0, 4)}…${row.apiKey.slice(-4)}` : ''
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function createInfiniteCanvasRoutes(
  store: InfiniteCanvasStore,
  generate?: CanvasGenerateHandler,
  generateImage?: CanvasImageGenerateHandler,
  generateMedia?: CanvasMediaGenerateHandler,
  editImage?: CanvasImageEditHandler,
  reversePrompt?: CanvasReversePromptHandler,
  promptSources?: PromptSourceService,
  /**
   * 媒体 Provider store 的惰性获取器：宿主在插件 setup 之后才注入
   * （与 PluginContext.modelRegistry 的 getter 模式一致），请求期读取。
   */
  getMediaProviders?: () => MediaProviderStore | undefined,
  assets?: CanvasAssetStore,
  mediaLogs?: MediaLogStore
): RouteDefinition[] {
  return [
    {
      // 画布资产：生成结果转存后的本地文件服务。
      // ready → 直接回本地文件（真实 image/* + 不可变缓存）；
      // downloading/failed → 302 回源 URL 兜底（慢 CDN 也能渐进渲染，且无 ORB）。
      method: 'GET',
      path: '/assets/:assetId',
      handler: async (request, reply) => {
        const asset = assets?.getAssetByPath(
          `/api/plugins/infinite-canvas/assets/${String(request.params.assetId)}`
        )
        if (!asset) {
          return reply.code(404).send({ ok: false, error: '画布资产不存在' })
        }
        if (asset.status === 'ready') {
          if (!existsSync(asset.filePath)) {
            return reply.code(404).send({ ok: false, error: '画布资产不存在' })
          }
          // ACAO=*：渲染层（localhost:5273 / file://）跨域加载后才能在 canvas
          // 上绘制并导出（蒙版/裁剪/切分/放大），否则 toDataURL 抛 Tainted canvas
          return reply
            .header('Content-Type', asset.mime)
            .header('Cache-Control', 'public, max-age=31536000, immutable')
            .header('Access-Control-Allow-Origin', '*')
            .header('X-Content-Type-Options', 'nosniff')
            .send(readFileSync(asset.filePath))
        }
        if (asset.sourceUrl) {
          return reply
            .header('Access-Control-Allow-Origin', '*')
            .redirect(asset.sourceUrl, 302)
        }
        return reply.code(404).send({ ok: false, error: '画布资产不存在' })
      }
    },
    {
      // 图片代理：绕过 CSP 加载外部封面图；只允许 http(s)，60s 超时，
      // 按魔数嗅探修正 Content-Type（部分图床谎报 octet-stream 会被浏览器 ORB 拦截）。
      method: 'GET',
      path: '/proxy-image',
      handler: async (request, reply) => {
        const query = request.query as { url?: string }
        const url = query.url
        if (!url || !/^https?:\/\//.test(url)) {
          return reply.code(400).send({ ok: false, error: '无效图片 URL' })
        }
        try {
          // 部分图床（camo、CDN、社交平台）对空 UA / 无 Referer 直接 403，
          // 这里补上浏览器风格请求头，尽量让外部提示词封面能取回来。
          const response = await fetch(url, {
            signal: AbortSignal.timeout(60_000),
            redirect: 'follow',
            headers: {
              Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              Referer: new URL(url).origin
            }
          })
          if (!response.ok) return reply.code(response.status).send()
          const buffer = Buffer.from(await response.arrayBuffer())
          const contentType = imageMimeFromBytes(buffer, response.headers.get('content-type') ?? 'image/png')
          if (!contentType.startsWith('image/')) {
            return reply.code(400).send({ ok: false, error: '非图片资源' })
          }
          return reply
            .header('Content-Type', contentType)
            .header('Cache-Control', 'public, max-age=86400')
            .header('Access-Control-Allow-Origin', '*')
            .send(buffer)
        } catch {
          return reply.code(502).send({ ok: false, error: '图片代理请求失败' })
        }
      }
    },
    {
      // @deprecated 画布媒体配置已迁移 media_providers（设置 → 媒体生成）：
      // 以 image 默认 Provider 的只读视图兼容旧桌面端，阶段三清理本路由。
      method: 'GET',
      path: '/media-config',
      handler: async (request, reply) => {
        const mediaProviders = getMediaProviders?.()
        if (!mediaProviders) return reply.code(503).send({ ok: false, error: '媒体配置服务未初始化' })
        return success(canvasMediaStatusFromRow(mediaProviders.resolveDefault('image')), request.traceId)
      }
    },
    {
      // @deprecated 写回 image 默认 Provider（baseUrl/model/params 字段映射、
      // imageProtocol → adapter 映射、空 Key 保留旧值）；无默认行时创建首行并设默认。
      // 阶段三清理本路由，新配置入口统一走 /api/plugins/infinite-canvas/media-providers。
      method: 'PUT',
      path: '/media-config',
      bodyLimit: 4096,
      handler: async (request, reply) => {
        const mediaProviders = getMediaProviders?.()
        if (!mediaProviders) return reply.code(503).send({ ok: false, error: '媒体配置服务未初始化' })
        const input = body(request)
        const protocol = optionalString(input.imageProtocol)
        const adapter = protocol === 'apimart' ? 'apimart' : 'openai-images'
        // 提供的字段才写入 params，避免旧客户端缺省字段清空已配置参数
        const patchParams: Record<string, string> = {}
        const size = optionalString(input.imageSize)
        const resolution = optionalString(input.imageResolution)
        const language = optionalString(input.imageLanguage)
        if (size) patchParams.size = size
        if (resolution) patchParams.resolution = resolution
        if (language) patchParams.language = language

        const current = mediaProviders.resolveDefault('image')
        if (current) {
          mediaProviders.update(current.id, {
            ...(optionalString(input.imageBaseUrl) !== undefined ? { baseUrl: optionalString(input.imageBaseUrl) } : {}),
            ...(optionalString(input.imageModel) !== undefined ? { model: optionalString(input.imageModel) } : {}),
            // 仅显式携带 imageProtocol 才写 adapter：缺省保留行内现协议，
            // 避免旧客户端把 apimart 行静默改写为 openai-images
            ...(protocol !== undefined ? { adapter } : {}),
            ...(Object.keys(patchParams).length ? { params: { ...current.params, ...patchParams } } : {}),
            // 空/缺省 Key 由 store.update 保留旧值
            ...(optionalString(input.imageApiKey) !== undefined ? { apiKey: optionalString(input.imageApiKey) } : {})
          })
        } else {
          // 旧弹窗「先配置再生图」流程在全新库上的兜底：创建首行并设为模态默认
          // （无行可保留现协议，未携带 imageProtocol 时回退 openai-images）
          const created = mediaProviders.create({
            name: '画布媒体配置',
            modality: 'image',
            adapter,
            baseUrl: optionalString(input.imageBaseUrl) ?? '',
            apiKey: optionalString(input.imageApiKey) ?? '',
            model: optionalString(input.imageModel) ?? '',
            params: patchParams
          })
          mediaProviders.setDefault(created.id)
        }
        return success(canvasMediaStatusFromRow(mediaProviders.resolveDefault('image')), request.traceId)
      }
    },
    {
      // 资产上传：把画布里的 data URL 图片（上传图/蒙版）转成服务端本地资产，
      // 节点保存载荷从多 MB data URL 降为短路径——拖动/保存卡顿的根治手段
      method: 'POST',
      path: '/assets',
      bodyLimit: 32 * 1024 * 1024,
      handler: async (request, reply) => {
        const input = body(request)
        const dataUrl = typeof input.dataUrl === 'string' ? input.dataUrl : ''
        if (!assets || !dataUrl.startsWith('data:image/')) {
          return reply.code(400).send({ ok: false, error: '仅支持 data:image/ 格式' })
        }
        const path = assets.storeFromDataUrl(
          typeof input.projectId === 'string' && input.projectId ? input.projectId : null,
          dataUrl
        )
        if (!path) return reply.code(400).send({ ok: false, error: '图片解析失败' })
        return success({ path }, request.traceId)
      }
    },
    {
      // 媒体生成日志：最近 N 条请求/响应记录，供画布内"生成日志"面板查看
      method: 'GET',
      path: '/media-logs',
      handler: async (request) => {
        const query = request.query as { limit?: string }
        const limit = Math.min(200, Math.max(1, Number(query.limit) || 50))
        return success(mediaLogs ? mediaLogs.list(limit) : [], request.traceId)
      }
    },
    {
      method: 'GET',
      path: '/prompt-sources',
      handler: async (request, reply) => {
        if (!promptSources) return reply.code(503).send({ ok: false, error: '提示词源服务未初始化' })
        return success(promptSources.listSources(), request.traceId)
      }
    },
    {
      method: 'GET',
      path: '/prompt-items',
      handler: async (request, reply) => {
        if (!promptSources) return reply.code(503).send({ ok: false, error: '提示词源服务未初始化' })
        const query = request.query as { sourceId?: string }
        return success(promptSources.listItems(query.sourceId || undefined), request.traceId)
      }
    },
    {
      method: 'GET',
      path: '/prompt-tags',
      handler: async (request, reply) => {
        if (!promptSources) return reply.code(503).send({ ok: false, error: '提示词源服务未初始化' })
        return success(promptSources.listTags(), request.traceId)
      }
    },
    {
      // 刷新会拉取远端源并重写 SQLite 缓存，属写操作；桌面端一直用 POST 调用，
      // 之前登记成 GET 时整个"刷新提示词源"按钮只会拿到 404。
      method: 'POST',
      path: '/prompt-sources/refresh',
      bodyLimit: 1024,
      handler: async (request, reply) => {
        if (!promptSources) return reply.code(503).send({ ok: false, error: '提示词源服务未初始化' })
        try {
          const result = await promptSources.refreshAll()
          return success(result, request.traceId)
        } catch (error) {
          return reply
            .code(502)
            .send(
              failure(
                'PROMPT_REFRESH_FAILED',
                error instanceof Error ? error.message : String(error),
                request.traceId
              )
            )
        }
      }
    },
    {
      method: 'PATCH',
      path: '/prompt-sources/:sourceId/toggle',
      bodyLimit: 1024,
      handler: async (request, reply) => {
        if (!promptSources) return reply.code(503).send({ ok: false, error: '提示词源服务未初始化' })
        const input = body(request)
        promptSources.toggleSource(request.params.sourceId, Boolean(input.enabled))
        return success({ id: request.params.sourceId, enabled: Boolean(input.enabled) }, request.traceId)
      }
    },
    {
      method: 'GET',
      path: '/projects',
      handler: async (request) => success(store.listProjects(), request.traceId)
    },
    {
      method: 'POST',
      path: '/projects',
      handler: async (request) => {
        const input = body(request)
        return success(
          store.createProject({
            title: String(input.title ?? ''),
            description: String(input.description ?? '')
          }),
          request.traceId
        )
      }
    },
    {
      method: 'GET',
      path: '/projects/:projectId',
      handler: async (request, reply) => {
        const project = store.getProject(request.params.projectId)
        if (!project) return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        return success(project, request.traceId)
      }
    },
    {
      method: 'PATCH',
      path: '/projects/:projectId',
      handler: async (request, reply) => {
        const input = body(request)
        const project = store.updateProject(request.params.projectId, {
          title: input.title === undefined ? undefined : String(input.title),
          description: input.description === undefined ? undefined : String(input.description),
          viewport:
            input.viewport && typeof input.viewport === 'object'
              ? (input.viewport as { x: number; y: number; zoom: number })
              : undefined,
          settings:
            input.settings && typeof input.settings === 'object'
              ? (input.settings as {
                  backgroundMode?: 'dots' | 'lines' | 'blank'
                  showImageInfo?: boolean
                })
              : undefined
        })
        if (!project) return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        return success(project, request.traceId)
      }
    },
    {
      method: 'DELETE',
      path: '/projects/:projectId',
      handler: async (request, reply) => {
        // 必须先清资产（拿文件列表删盘上的文件），再删项目行——
        // 项目行一删，外键级联会把资产行一起带走
        assets?.deleteForProject(request.params.projectId)
        if (!store.deleteProject(request.params.projectId))
          return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        return success({ id: request.params.projectId, deleted: true }, request.traceId)
      }
    },
    {
      // 桌面端本地优先编辑后的整图同步入口；节点 metadata 可能携带 data URL，
      // 放宽单路由体积上限。
      method: 'PUT',
      path: '/projects/:projectId/graph',
      bodyLimit: MEDIA_BODY_LIMIT,
      handler: async (request, reply) => {
        try {
          const input = body(request)
          const nodes = Array.isArray(input.nodes) ? input.nodes : []
          const connections = Array.isArray(input.connections) ? input.connections : []
          const project = store.replaceGraph(request.params.projectId, {
            nodes: nodes.map((raw) => {
              const node = raw as Record<string, unknown>
              return {
                id: String(node.id ?? ''),
                type: requireNodeType(node.type),
                title: typeof node.title === 'string' ? node.title : undefined,
                content: typeof node.content === 'string' ? node.content : '',
                x: Number(node.x),
                y: Number(node.y),
                width: Number(node.width),
                height: Number(node.height),
                metadata:
                  node.metadata && typeof node.metadata === 'object'
                    ? (node.metadata as Record<string, unknown>)
                    : {}
              }
            }),
            connections: connections.map((raw) => {
              const connection = raw as Record<string, unknown>
              return {
                id: String(connection.id ?? ''),
                fromNodeId: String(connection.fromNodeId ?? ''),
                toNodeId: String(connection.toNodeId ?? '')
              }
            }),
            viewport:
              input.viewport && typeof input.viewport === 'object'
                ? (input.viewport as { x: number; y: number; zoom: number })
                : undefined,
            settings:
              input.settings && typeof input.settings === 'object'
                ? (input.settings as {
                    backgroundMode?: 'dots' | 'lines' | 'blank'
                    showImageInfo?: boolean
                  })
                : undefined
          })
          if (!project) return reply.code(404).send({ ok: false, error: '画布项目不存在' })
          return success(project, request.traceId)
        } catch (error) {
          return reply
            .code(400)
            .send(
              failure(
                'GRAPH_SAVE_FAILED',
                error instanceof Error ? error.message : String(error),
                request.traceId
              )
            )
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/generate',
      bodyLimit: 2 * 1024 * 1024,
      handler: async (request, reply) => {
        if (!generate) return reply.code(503).send({ ok: false, error: '画布 Agent 尚未配置' })
        const input = body(request)
        const prompt = String(input.prompt ?? '').trim()
        if (!prompt) return reply.code(400).send({ ok: false, error: '生成提示词不能为空' })
        if (!store.getProject(request.params.projectId)) {
          return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        }
        try {
          const generatedContext = generationContext(input)
          const text = await generate({
            projectId: request.params.projectId,
            nodeId: input.nodeId === undefined ? undefined : String(input.nodeId),
            prompt,
            mode: input.mode === undefined ? undefined : String(input.mode),
            ...generatedContext
          })
          return success({ text }, request.traceId)
        } catch (error) {
          request.log?.error?.(error)
          return reply
            .code(502)
            .send(
              failure(
                'TEXT_GENERATION_FAILED',
                error instanceof Error ? error.message : String(error),
                request.traceId
              )
            )
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/generate-image',
      bodyLimit: MEDIA_BODY_LIMIT,
      handler: async (request, reply) => {
        if (!generateImage)
          return reply.code(503).send({ ok: false, error: '图片 Provider 尚未配置' })
        const input = body(request)
        const prompt = String(input.prompt ?? '').trim()
        if (!prompt) return reply.code(400).send({ ok: false, error: '图片提示词不能为空' })
        if (!store.getProject(request.params.projectId))
          return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        try {
          const generatedContext = generationContext(input)
          const result = await generateImage({
            projectId: request.params.projectId,
            prompt,
            context: generatedContext.context,
            resourceContext: generatedContext.resourceContext,
            references: (() => {
              // 透传全部字符串引用，由插件层统一归一化成 data URL
              // （本地资产路径/远程 URL 都在这里转）
              const explicitReferences = Array.isArray(input.references)
                ? input.references.filter((item): item is string => typeof item === 'string' && item.length > 0)
                : []
              const structuredReferences = canvasImageDataUrls(generatedContext.resourceContext)
              return explicitReferences.length ? explicitReferences : structuredReferences.length ? structuredReferences : extractDataUrls(generatedContext.context || '')
            })(),
            model: input.model === undefined ? undefined : String(input.model),
            providerId: input.providerId === undefined ? undefined : String(input.providerId),
            size: input.size === undefined ? undefined : String(input.size),
            quality: input.quality === undefined ? undefined : String(input.quality),
            background: input.background === undefined ? undefined : String(input.background),
            count: input.count === undefined ? undefined : Number(input.count),
            traceId: request.traceId
          })
          return success(result, request.traceId)
        } catch (error) {
          return reply
            .code(502)
            .send(
              failure(
                'IMAGE_GENERATION_FAILED',
                error instanceof Error ? error.message : String(error),
                request.traceId
              )
            )
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/generate-media',
      bodyLimit: MEDIA_BODY_LIMIT,
      handler: async (request, reply) => {
        if (!generateMedia)
          return reply.code(503).send({ ok: false, error: '媒体 Provider 尚未配置' })
        const input = body(request)
        const mode = input.mode === 'audio' || input.mode === 'video' ? input.mode : undefined
        const prompt = String(input.prompt ?? '').trim()
        if (!mode || !prompt)
          return reply.code(400).send({ ok: false, error: '媒体模式和提示词不能为空' })
        if (!store.getProject(request.params.projectId))
          return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        try {
          const generatedContext = generationContext(input)
          const result = await generateMedia({
            projectId: request.params.projectId,
            mode,
            prompt,
            context: generatedContext.context,
            resourceContext: generatedContext.resourceContext,
            model: input.model === undefined ? undefined : String(input.model),
            providerId: input.providerId === undefined ? undefined : String(input.providerId),
            voice: input.voice === undefined ? undefined : String(input.voice),
            format: input.format === undefined ? undefined : String(input.format),
            speed: input.speed === undefined ? undefined : Number(input.speed),
            size: input.size === undefined ? undefined : String(input.size),
            seconds: input.seconds === undefined ? undefined : Number(input.seconds),
            image: optionalString(input.image),
            generateAudio: input.generateAudio === undefined ? undefined : Boolean(input.generateAudio),
            watermark: input.watermark === undefined ? undefined : Boolean(input.watermark)
          })
          return success(result, request.traceId)
        } catch (error) {
          return reply
            .code(502)
            .send(
              failure(
                'MEDIA_GENERATION_FAILED',
                error instanceof Error ? error.message : String(error),
                request.traceId
              )
            )
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/edit-image',
      bodyLimit: MEDIA_BODY_LIMIT,
      handler: async (request, reply) => {
        if (!editImage)
          return reply.code(503).send({ ok: false, error: '图像编辑 Provider 尚未配置' })
        const input = body(request)
        const prompt = String(input.prompt ?? '').trim()
        const image = typeof input.image === 'string' ? input.image : ''
        if (!prompt || !image)
          return reply.code(400).send({ ok: false, error: '编辑提示词和原图不能为空' })
        if (!store.getProject(request.params.projectId))
          return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        try {
          const result = await editImage({
            projectId: request.params.projectId,
            prompt,
            image,
            providerId: input.providerId === undefined ? undefined : String(input.providerId),
            images: Array.isArray(input.images)
              ? // 预过滤只丢弃非字符串垃圾项：data URL 原样、资产路径留给
                // editImageLocalized 统一归一化成 data URL
                input.images.filter(
                  (item): item is string =>
                    typeof item === 'string' &&
                    (item.startsWith('data:') || item.startsWith(`${ASSET_PATH_PREFIX}/`))
                )
              : undefined,
            mask: typeof input.mask === 'string' && input.mask ? input.mask : undefined,
            model: input.model === undefined ? undefined : String(input.model),
            size: input.size === undefined ? undefined : String(input.size),
            traceId: request.traceId
          })
          return success(result, request.traceId)
        } catch (error) {
          request.log?.error?.(error)
          return reply
            .code(502)
            .send(
              failure(
                'IMAGE_EDIT_FAILED',
                error instanceof Error ? error.message : String(error),
                request.traceId
              )
            )
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/reverse-prompt',
      bodyLimit: MEDIA_BODY_LIMIT,
      handler: async (request, reply) => {
        if (!reversePrompt)
          return reply.code(503).send({ ok: false, error: '视觉理解 Provider 尚未配置' })
        const input = body(request)
        const image = typeof input.image === 'string' ? input.image : ''
        if (!image) return reply.code(400).send({ ok: false, error: '图片内容不能为空' })
        if (!store.getProject(request.params.projectId))
          return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        try {
          const result = await reversePrompt({
            image,
            instruction: typeof input.instruction === 'string' ? input.instruction : undefined,
            model: input.model === undefined ? undefined : String(input.model)
          })
          return success(result, request.traceId)
        } catch (error) {
          request.log?.error?.(error)
          return reply
            .code(502)
            .send(
              failure(
                'REVERSE_PROMPT_FAILED',
                error instanceof Error ? error.message : String(error),
                request.traceId
              )
            )
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/nodes',
      handler: async (request, reply) => {
        try {
          const input = body(request)
          const node = store.createNode(request.params.projectId, {
            type: requireNodeType(input.type),
            title: input.title === undefined ? undefined : String(input.title),
            content: input.content === undefined ? undefined : String(input.content),
            x: Number(input.x),
            y: Number(input.y),
            width: Number(input.width),
            height: Number(input.height),
            metadata:
              input.metadata && typeof input.metadata === 'object'
                ? (input.metadata as Record<string, unknown>)
                : undefined
          })
          if (!node) return reply.code(404).send({ ok: false, error: '画布项目不存在' })
          return success(node, request.traceId)
        } catch (error) {
          return reply
            .code(400)
            .send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
    {
      method: 'PATCH',
      path: '/nodes/:nodeId',
      handler: async (request, reply) => {
        try {
          const input = body(request)
          const node = store.updateNode(request.params.nodeId, {
            type: input.type === undefined ? undefined : requireNodeType(input.type),
            title: input.title === undefined ? undefined : String(input.title),
            content: input.content === undefined ? undefined : String(input.content),
            x: input.x === undefined ? undefined : Number(input.x),
            y: input.y === undefined ? undefined : Number(input.y),
            width: input.width === undefined ? undefined : Number(input.width),
            height: input.height === undefined ? undefined : Number(input.height),
            metadata:
              input.metadata && typeof input.metadata === 'object'
                ? (input.metadata as Record<string, unknown>)
                : undefined
          })
          if (!node) return reply.code(404).send({ ok: false, error: '画布节点不存在' })
          return success(node, request.traceId)
        } catch (error) {
          return reply
            .code(400)
            .send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
    {
      method: 'DELETE',
      path: '/nodes/:nodeId',
      handler: async (request, reply) => {
        if (!store.deleteNode(request.params.nodeId))
          return reply.code(404).send({ ok: false, error: '画布节点不存在' })
        return success({ id: request.params.nodeId, deleted: true }, request.traceId)
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/connections',
      handler: async (request, reply) => {
        const input = body(request)
        const connection = store.createConnection(
          request.params.projectId,
          String(input.fromNodeId ?? ''),
          String(input.toNodeId ?? '')
        )
        if (!connection)
          return reply.code(400).send({ ok: false, error: '连线无效：项目、节点或方向不正确' })
        return success(connection, request.traceId)
      }
    },
    {
      method: 'DELETE',
      path: '/connections/:connectionId',
      handler: async (request, reply) => {
        if (!store.deleteConnection(request.params.connectionId))
          return reply.code(404).send({ ok: false, error: '连线不存在' })
        return success({ id: request.params.connectionId, deleted: true }, request.traceId)
      }
    }
  ]
}

export function extractDataUrls(value: string): string[] {
  return value.match(/data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s"']+/gi) ?? []
}
