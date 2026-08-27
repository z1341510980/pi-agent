import { success } from '../../lib/api-response.js'
import type { RouteDefinition } from '../../core/plugin/plugin-types.js'
import type { InfiniteCanvasStore } from './store.js'
import type { AnyCanvasNodeType } from './types.js'
import type { PromptSourceService } from './prompt-source-service.js'
import type { CanvasMediaSettingsService } from './media-settings.js'

export type CanvasGenerateHandler = (input: {
  projectId: string
  nodeId?: string
  prompt: string
  mode?: string
  context?: string
}) => Promise<string>

export type CanvasImageGenerateHandler = (input: {
  prompt: string
  references?: string[]
  model?: string
  size?: string
  count?: number
  traceId?: string
  signal?: AbortSignal
}) => Promise<{ images: string[] }>

export type CanvasMediaGenerateHandler = (input: {
  mode: 'audio' | 'video'
  prompt: string
  model?: string
  voice?: string
  format?: string
  speed?: number
  size?: string
  seconds?: number
  signal?: AbortSignal
}) => Promise<{ outputs: Array<{ url: string; mimeType: string }> }>

export type CanvasImageEditHandler = (input: {
  prompt: string
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

function requireNodeType(value: unknown): AnyCanvasNodeType {
  const type = String(value ?? 'text') as AnyCanvasNodeType
  if (!NODE_TYPES.has(type) && !EXTENSION_NODE_TYPE.test(type)) {
    throw new Error(`不支持的画布节点类型: ${type}`)
  }
  return type
}

export function createInfiniteCanvasRoutes(
  store: InfiniteCanvasStore,
  generate?: CanvasGenerateHandler,
  generateImage?: CanvasImageGenerateHandler,
  generateMedia?: CanvasMediaGenerateHandler,
  editImage?: CanvasImageEditHandler,
  reversePrompt?: CanvasReversePromptHandler,
  promptSources?: PromptSourceService,
  mediaSettings?: CanvasMediaSettingsService
): RouteDefinition[] {
  return [
    {
      // 图片代理：绕过 CSP 加载外部封面图；只允许 http(s)，30s 超时。
      method: 'GET',
      path: '/proxy-image',
      handler: async (request, reply) => {
        const query = request.query as { url?: string }
        const url = query.url
        if (!url || !/^https?:\/\//.test(url)) {
          return reply.code(400).send({ ok: false, error: '无效图片 URL' })
        }
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(30_000),
            headers: { Accept: 'image/*' }
          })
          if (!response.ok) return reply.code(response.status).send()
          const contentType = response.headers.get('content-type') ?? 'image/png'
          if (!contentType.startsWith('image/')) {
            return reply.code(400).send({ ok: false, error: '非图片资源' })
          }
          const buffer = await response.arrayBuffer()
          return reply
            .header('Content-Type', contentType)
            .header('Cache-Control', 'public, max-age=86400')
            .send(Buffer.from(buffer))
        } catch {
          return reply.code(502).send({ ok: false, error: '图片代理请求失败' })
        }
      }
    },
    {
      method: 'GET',
      path: '/media-config',
      handler: async (request, reply) => {
        if (!mediaSettings) return reply.code(503).send({ ok: false, error: '媒体配置服务未初始化' })
        return success(mediaSettings.getStatus(), request.traceId)
      }
    },
    {
      method: 'PUT',
      path: '/media-config',
      bodyLimit: 4096,
      handler: async (request, reply) => {
        if (!mediaSettings) return reply.code(503).send({ ok: false, error: '媒体配置服务未初始化' })
        const input = body(request)
        mediaSettings.update({
          imageBaseUrl: typeof input.imageBaseUrl === 'string' ? input.imageBaseUrl : undefined,
          imageApiKey: typeof input.imageApiKey === 'string' ? input.imageApiKey : undefined,
          imageModel: typeof input.imageModel === 'string' ? input.imageModel : undefined,
          imageSize: typeof input.imageSize === 'string' ? input.imageSize : undefined,
          imageProtocol: input.imageProtocol === 'apimart' || input.imageProtocol === 'openai-images'
            ? input.imageProtocol
            : undefined,
          imageResolution: typeof input.imageResolution === 'string' ? input.imageResolution : undefined,
          imageLanguage: typeof input.imageLanguage === 'string' ? input.imageLanguage : undefined
        })
        return success(mediaSettings.getStatus(), request.traceId)
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
      method: 'GET',
      path: '/prompt-sources/refresh',
      bodyLimit: 1024,
      handler: async (request, reply) => {
        if (!promptSources) return reply.code(503).send({ ok: false, error: '提示词源服务未初始化' })
        try {
          const result = await promptSources.refreshAll()
          return success(result, request.traceId)
        } catch (error) {
          return reply.code(502).send({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
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
      bodyLimit: 32 * 1024 * 1024,
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
            .send({ ok: false, error: error instanceof Error ? error.message : String(error) })
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
          const text = await generate({
            projectId: request.params.projectId,
            nodeId: input.nodeId === undefined ? undefined : String(input.nodeId),
            prompt,
            mode: input.mode === undefined ? undefined : String(input.mode),
            context: input.context === undefined ? undefined : String(input.context)
          })
          return success({ text }, request.traceId)
        } catch (error) {
          request.log?.error?.(error)
          return reply
            .code(502)
            .send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/generate-image',
      bodyLimit: 32 * 1024 * 1024,
      handler: async (request, reply) => {
        if (!generateImage)
          return reply.code(503).send({ ok: false, error: '图片 Provider 尚未配置' })
        const input = body(request)
        const prompt = String(input.prompt ?? '').trim()
        if (!prompt) return reply.code(400).send({ ok: false, error: '图片提示词不能为空' })
        if (!store.getProject(request.params.projectId))
          return reply.code(404).send({ ok: false, error: '画布项目不存在' })
        try {
          const explicitReferences = Array.isArray(input.references)
            ? input.references.filter((item): item is string => typeof item === 'string' && item.startsWith('data:'))
            : []
          const result = await generateImage({
            prompt,
            references: explicitReferences.length
              ? explicitReferences
              : extractDataUrls(typeof input.context === 'string' ? input.context : ''),
            model: input.model === undefined ? undefined : String(input.model),
            size: input.size === undefined ? undefined : String(input.size),
            count: input.count === undefined ? undefined : Number(input.count),
            traceId: request.traceId
          })
          return success(result, request.traceId)
        } catch (error) {
          return reply
            .code(502)
            .send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/generate-media',
      bodyLimit: 8 * 1024 * 1024,
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
          const result = await generateMedia({
            mode,
            prompt,
            model: input.model === undefined ? undefined : String(input.model),
            voice: input.voice === undefined ? undefined : String(input.voice),
            format: input.format === undefined ? undefined : String(input.format),
            speed: input.speed === undefined ? undefined : Number(input.speed),
            size: input.size === undefined ? undefined : String(input.size),
            seconds: input.seconds === undefined ? undefined : Number(input.seconds)
          })
          return success(result, request.traceId)
        } catch (error) {
          return reply
            .code(502)
            .send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/edit-image',
      bodyLimit: 32 * 1024 * 1024,
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
            prompt,
            image,
            images: Array.isArray(input.images)
              ? input.images.filter((item): item is string => typeof item === 'string' && item.startsWith('data:'))
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
            .send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
    {
      method: 'POST',
      path: '/projects/:projectId/reverse-prompt',
      bodyLimit: 32 * 1024 * 1024,
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
            .send({ ok: false, error: error instanceof Error ? error.message : String(error) })
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
