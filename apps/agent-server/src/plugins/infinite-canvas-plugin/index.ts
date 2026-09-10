import { Type } from 'typebox'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { Plugin, PluginContext } from '../../core/plugin/plugin-types.js'
import { infiniteCanvasMigrations } from './migrations.js'
import { createInfiniteCanvasRoutes } from './routes.js'
import { createMediaProviderRoutes } from './media-provider-routes.js'
import { InfiniteCanvasStore } from './store.js'
import type { AnyCanvasNodeType } from './types.js'
import { createPromptSourceService } from './prompt-source-service.js'
import { CanvasAssetStore, MediaLogStore, referencesToDataUrls } from './canvas-assets.js'
import { normalizeOpenAiCompatibleSize } from './media/shared.js'
import { MediaProviderStore } from './media/media-provider-store.js'
import { createMediaProviderRegistry } from './media/registry.js'
import { createMediaGenerator, IMAGE_ANALYZE_UNSUPPORTED_MESSAGE } from './media/generator.js'
import {
  applyCanvasAgentOperations,
  summarizeCanvasAgentOperations,
  type CanvasAgentOperation
} from './agent-ops.js'
import { formatCanvasGenerationContext } from './generation-context.js'

const NODE_TYPE_LIST: Array<AnyCanvasNodeType> = [
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
]
const EXTENSION_NODE_TYPE = /^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9_-]{0,63}$/

function nodeType(value: unknown): AnyCanvasNodeType {
  const type = String(value ?? 'text') as AnyCanvasNodeType
  return NODE_TYPE_LIST.includes(type) || EXTENSION_NODE_TYPE.test(type) ? type : 'text'
}

export function createInfiniteCanvasPlugin(): Plugin {
  return {
    manifest: {
      name: 'infinite-canvas',
      version: '0.1.0',
      description: 'PI Agent 无限画布：组织提示词、文件、Agent 结果和工作流节点',
      author: 'wenlang-agent',
      permissions: [
        'tools.register',
        'routes.register',
        'storage.plugin',
        'ui.contribute',
        'session.create',
        'media.generate'
      ],
      builtin: true
    },
    migrations: infiniteCanvasMigrations,
    setup(context: PluginContext) {
      const store = new InfiniteCanvasStore(context.db)
      context.registerService('infiniteCanvasStore', store)
      const promptSourceService = createPromptSourceService(context.db, context)
      const imageLogger = context.logger.child({ module: 'infinite-canvas-image' })
      // 媒体 Provider 体系归属本插件：store/Registry/facade 均以 context.db（宿主同库）
      // 自建，配置表 infinite_canvas_media_providers 由本插件迁移 018 创建。
      const mediaProviderStore = new MediaProviderStore(context.db)
      const mediaLogger = context.logger.child({ module: 'infinite-canvas-media' })
      const mediaProviderRegistry = createMediaProviderRegistry(mediaProviderStore, {
        logger: mediaLogger
      })
      const media = createMediaGenerator(mediaProviderRegistry, { logger: mediaLogger })
      // 旧 media-config 兼容路由的读写入口：本插件自建的媒体 Provider store。
      const getMediaProviderStore = (): MediaProviderStore => mediaProviderStore
      // 生成结果本地资产：落盘后前端拿稳定的 /assets/:id，不再依赖慢 CDN
      const dataDir = process.env.PI_DATA_DIR ?? join(homedir(), '.pi')
      const assets = new CanvasAssetStore(context.db, join(dataDir, 'agent', 'canvas-assets'))
      // 媒体生成日志：请求/响应留痕，画布内"生成日志"面板可查
      const mediaLogs = new MediaLogStore(context.db)

      /**
       * 把生成结果统一转成本地资产路径：远程 URL 后台转存（立即返回资产路径），
       * data URL 同步落盘。转存失败时资产路由会 302 回源，显示不受影响。
       */
      const localizeImages = (projectId: string | undefined, images: string[]): string[] =>
        images.map((image) => {
          if (image.startsWith('data:')) return assets.storeFromDataUrl(projectId ?? null, image) ?? image
          if (image.startsWith('http://') || image.startsWith('https://')) {
            return assets.beginRemoteAsset(projectId ?? '', image)
          }
          return image
        })

      /**
       * 画布生图：providerId/model/size 等输入透传插件媒体 facade
       * （Registry 按「画布 providerId 优先 → image 默认」解析，旧双路已删除）。
       * 参考图统一归一化成 data URL：本地资产/localhost/内网 URL 服务商取不到，
       * 直接透传必然被上游拒绝或悄悄忽略。
       */
      const generateImageCore = async (input: {
        projectId?: string
        prompt: string
        providerId?: string
        references?: string[]
        model?: string
        size?: string
        count?: number
        traceId?: string
        signal?: AbortSignal
      }): Promise<{ images: string[] }> => {
        if (!media.generateImage)
          throw new Error('图片 Provider 尚未配置，请到 设置 → 媒体生成 配置')
        const references = input.references?.length
          ? await referencesToDataUrls(assets, input.references)
          : input.references
        return media.generateImage({
          providerId: input.providerId,
          prompt: input.prompt,
          references,
          model: input.model,
          size: input.size,
          count: input.count,
          traceId: input.traceId,
          signal: input.signal
        })
      }

      /** 对外入口：归一化参考图 → 生图 → 本地化结果 → 记录日志。 */
      const generateImageLocalized = async (input: Parameters<typeof generateImageCore>[0]): Promise<{ images: string[] }> => {
        const startedAt = Date.now()
        const endpoint = input.references?.length ? '/images/edits' : '/images/generations'
        const logBase = {
          kind: 'generate' as const,
          projectId: input.projectId ?? null,
          endpoint,
          model: input.model ?? null,
          size: normalizeOpenAiCompatibleSize(input.size) ?? null,
          prompt: input.prompt,
          traceId: input.traceId ?? null
        }
        let referencePreviews: Array<{ preview: string; bytes: number }> = []
        try {
          const references = (await referencesToDataUrls(assets, input.references)) ?? []
          referencePreviews = references.map((ref) => ({
            preview: assets.storeFromDataUrl(input.projectId ?? null, ref) ?? '',
            bytes: ref.length
          }))
          const result = await generateImageCore({ ...input, references })
          let images = result.images
          try {
            images = localizeImages(input.projectId, result.images)
          } catch (error) {
            imageLogger?.warn?.({ error }, '生成结果本地化失败，保留原始 URL')
          }
          mediaLogs?.insert({
            ...logBase,
            references: referencePreviews,
            responseImages: images,
            status: 'ok',
            durationMs: Date.now() - startedAt
          })
          return { images }
        } catch (error) {
          mediaLogs?.insert({
            ...logBase,
            references: referencePreviews,
            responseImages: [],
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt
          })
          throw error
        }
      }

      const editImageCore = async (input: {
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
      }): Promise<{ images: string[] }> => {
        if (!media.editImage)
          throw new Error('图像编辑 Provider 尚未配置，请到 设置 → 媒体生成 配置')
        return media.editImage({
          providerId: input.providerId,
          prompt: input.prompt,
          image: input.image,
          images: input.images,
          mask: input.mask,
          model: input.model,
          size: input.size,
          traceId: input.traceId,
          signal: input.signal
        })
      }

      /** 对外编辑入口：归一化原图 → 编辑 → 本地化结果 → 记录日志。 */
      const editImageLocalized = async (input: Parameters<typeof editImageCore>[0]): Promise<{ images: string[] }> => {
        const startedAt = Date.now()
        const logBase = {
          kind: 'edit' as const,
          projectId: input.projectId ?? null,
          endpoint: '/images/edits',
          model: input.model ?? null,
          size: normalizeOpenAiCompatibleSize(input.size) ?? null,
          prompt: input.prompt,
          traceId: input.traceId ?? null
        }
        let referencePreviews: Array<{ preview: string; bytes: number }> = []
        let maskPath: string | null = null
        try {
          // 原图/附加图归一化：本地资产路径服务商取不到
          const [image, ...images] = (await referencesToDataUrls(assets, [
            input.image,
            ...(input.images ?? [])
          ]))!
          referencePreviews = [image, ...images].map((ref) => ({
            preview: assets.storeFromDataUrl(input.projectId ?? null, ref) ?? '',
            bytes: ref.length
          }))
          maskPath = input.mask
            ? assets.storeFromDataUrl(input.projectId ?? null, input.mask)
            : null
          const result = await editImageCore({
            ...input,
            image,
            images: images.length ? images : undefined
          })
          let responseImages = result.images
          try {
            responseImages = localizeImages(undefined, result.images)
          } catch (error) {
            imageLogger?.warn?.({ error }, '编辑结果本地化失败，保留原始 URL')
          }
          mediaLogs?.insert({
            ...logBase,
            references: referencePreviews,
            maskPath,
            responseImages,
            status: 'ok',
            durationMs: Date.now() - startedAt
          })
          return { images: responseImages }
        } catch (error) {
          mediaLogs?.insert({
            ...logBase,
            references: referencePreviews,
            maskPath,
            responseImages: [],
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt
          })
          throw error
        }
      }

      /** 视频 size 'WxH' → width/height（newapi-video 的显式分辨率入参）。 */
      const parseVideoSize = (size: string | undefined): { width?: number; height?: number } => {
        const match = /^(\d+)x(\d+)$/.exec(size?.trim() ?? '')
        return match ? { width: Number(match[1]), height: Number(match[2]) } : {}
      }

      /**
       * 对外音视频入口：providerId 透传（画布节点指定 → 模态默认）→ adapter 生成 →
       * 输出统一走资产本地化。音频结果是 data URL（同步落盘），视频结果是远程 URL
       * （后台转存）；本地化失败保留原始地址，与图片链路的兜底一致。
       */
      const generateMediaLocalized = async (input: {
        projectId?: string
        mode: 'audio' | 'video'
        prompt: string
        providerId?: string
        model?: string
        voice?: string
        format?: string
        speed?: number
        size?: string
        seconds?: number
        image?: string
        signal?: AbortSignal
      }): Promise<{ outputs: Array<{ url: string; mimeType: string }> }> => {
        const result =
          input.mode === 'audio'
            ? await media.generateAudio({
                prompt: input.prompt,
                model: input.model,
                voice: input.voice,
                format: input.format,
                speed: input.speed,
                providerId: input.providerId,
                signal: input.signal
              })
            : await media.generateVideo({
                prompt: input.prompt,
                model: input.model,
                image: input.image,
                providerId: input.providerId,
                duration: input.seconds,
                ...parseVideoSize(input.size),
                signal: input.signal
              })
        let outputs = result.outputs
        try {
          outputs = outputs.map((output) => ({
            mimeType: output.mimeType,
            url: localizeImages(input.projectId, [output.url])[0] ?? output.url
          }))
        } catch (error) {
          mediaLogger?.warn?.({ error }, '音视频输出本地化失败，保留原始地址')
        }
        return { outputs }
      }

      for (const route of createInfiniteCanvasRoutes(
        store,
        async ({ prompt, mode, context: graphContext, resourceContext }) => {
          const structuredContext = formatCanvasGenerationContext(resourceContext)
          const contextText = [graphContext, structuredContext].filter(Boolean).join('\n\n')
          const session = await context.createSession({
            systemPrompt:
              '你是无限画布里的创作助手。根据提示词和画布上下文输出可直接使用的结果，只输出正文，不要解释过程，不要使用 Markdown 代码围栏。',
            userMessage: `${contextText ? `画布上下文：\n${contextText}\n\n` : ''}任务类型：${mode ?? 'text'}\n\n${prompt}`,
            tools: [],
            timeoutMs: 120000
          })
          try {
            return await session.prompt()
          } finally {
            session.dispose()
          }
        },
        generateImageLocalized,
        generateMediaLocalized,
        editImageLocalized,
        ({ image, instruction, model, signal }) => {
          if (!media.analyzeImage) throw new Error(IMAGE_ANALYZE_UNSUPPORTED_MESSAGE)
          return media.analyzeImage({ image, instruction, model, signal })
        },
        promptSourceService,
        getMediaProviderStore,
        assets,
        mediaLogs
      ))
        context.registerRoute(route)

      // 媒体 Provider CRUD（/media-providers、/:id、/:id/default）：
      // 实际路径为 /api/plugins/infinite-canvas/media-providers…
      for (const mediaRoute of createMediaProviderRoutes(
        mediaProviderStore,
        mediaProviderRegistry,
        mediaLogger
      )) {
        context.registerRoute(mediaRoute)
      }

      context.registerSessionTools([
        defineTool({
          name: 'canvas_get_state',
          label: '读取画布状态',
          description: '读取当前无限画布的节点、连线和视口。',
          parameters: Type.Object({ projectId: Type.String() }),
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted)
              return { content: [{ type: 'text' as const, text: 'aborted' }], details: {} }
            const project = store.getProject(params.projectId)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(project ?? { error: 'canvas project not found' })
                }
              ],
              details: {}
            }
          }
        }),
        defineTool({
          name: 'canvas_apply_ops',
          label: '修改画布',
          description: '执行结构化无限画布操作。',
          parameters: Type.Object({
            projectId: Type.String(),
            ops: Type.Array(Type.Record(Type.String(), Type.Unknown()))
          }),
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted)
              return { content: [{ type: 'text' as const, text: 'aborted' }], details: {} }
            const project = store.getProject(params.projectId)
            if (!project)
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ error: 'canvas project not found' })
                  }
                ],
                details: {}
              }
            const result = await applyCanvasAgentOperations(
              store,
              project.id,
              params.ops as CanvasAgentOperation[],
              {
                signal,
                generate: async ({ prompt, mode, signal: generationSignal }) => {
                  if (mode === 'image')
                    return generateImageLocalized({
                      projectId: project.id,
                      prompt,
                      signal: generationSignal
                    })
                  const session = await context.createSession({
                    systemPrompt: '你是画布 Agent，只输出可直接写入节点的结果正文。',
                    userMessage: prompt,
                    tools: [],
                    signal: generationSignal,
                    timeoutMs: 120000
                  })
                  try {
                    return { text: await session.prompt() }
                  } finally {
                    session.dispose()
                  }
                }
              }
            )
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    summary: summarizeCanvasAgentOperations(params.ops as CanvasAgentOperation[]),
                    ...(result ?? { error: 'canvas project not found' })
                  })
                }
              ],
              details: {}
            }
          }
        })
      ])
      context.registerTool({
        name: 'canvas.list_projects',
        description: '列出 PI Agent 无限画布项目，适合在用户要查找或继续画布工作时使用。',
        async execute(_args, toolContext) {
          if (toolContext.signal?.aborted) return { ok: false, error: 'aborted' }
          return { ok: true, data: store.listProjects() }
        }
      })
      context.registerTool({
        name: 'canvas.create_image_flow',
        description: '在画布中创建文本→生成配置→图片的基础工作流，并自动连线。',
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            prompt: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' }
          },
          required: ['projectId', 'prompt']
        },
        async execute(args, toolContext) {
          if (toolContext.signal?.aborted) return { ok: false, error: 'aborted' }
          const projectId = String(args.projectId ?? '')
          if (!store.getProject(projectId)) return { ok: false, error: 'canvas project not found' }
          const x = Number(args.x ?? 100)
          const y = Number(args.y ?? 100)
          const text = store.createNode(projectId, {
            type: 'text',
            title: '图片提示词',
            content: String(args.prompt ?? ''),
            x,
            y,
            metadata: { content: String(args.prompt ?? ''), status: 'success' }
          })
          const config = store.createNode(projectId, {
            type: 'config',
            title: '图片生成配置',
            x: x + 420,
            y,
            metadata: { prompt: String(args.prompt ?? ''), generationMode: 'image' }
          })
          const image = store.createNode(projectId, {
            type: 'image',
            title: '生成图片',
            x: x + 840,
            y,
            metadata: { prompt: String(args.prompt ?? ''), status: 'idle' }
          })
          if (text && config) store.createConnection(projectId, text.id, config.id)
          if (config && image) store.createConnection(projectId, config.id, image.id)
          return { ok: true, data: store.getProject(projectId) }
        }
      })
      context.registerTool({
        name: 'canvas.get_state',
        description: '读取指定无限画布的当前节点、连线、视口与选区上下文。',
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            selectedNodeIds: { type: 'array', items: { type: 'string' } }
          },
          required: ['projectId']
        },
        async execute(args, toolContext) {
          if (toolContext.signal?.aborted) return { ok: false, error: 'aborted' }
          const project = store.getProject(String(args.projectId ?? ''))
          if (!project) return { ok: false, error: 'canvas project not found' }
          return {
            ok: true,
            data: {
              projectId: project.id,
              title: project.title,
              nodes: project.nodes,
              connections: project.connections,
              viewport: project.viewport,
              selectedNodeIds: Array.isArray(args.selectedNodeIds) ? args.selectedNodeIds : []
            }
          }
        }
      })
      context.registerTool({
        name: 'canvas.apply_ops',
        description:
          '对无限画布执行结构化操作：add_node/update_node/delete_node/delete_connections/connect_nodes/set_viewport/select_nodes/run_generation。',
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            ops: { type: 'array', items: { type: 'object' } }
          },
          required: ['projectId', 'ops']
        },
        async execute(args, toolContext) {
          if (toolContext.signal?.aborted) return { ok: false, error: 'aborted' }
          const project = store.getProject(String(args.projectId ?? ''))
          if (!project) return { ok: false, error: 'canvas project not found' }
          const ops = Array.isArray(args.ops) ? (args.ops as Array<Record<string, unknown>>) : []
          const result = await applyCanvasAgentOperations(store, project.id, ops, {
            signal: toolContext.signal,
            generate: async ({ prompt, mode, signal }) => {
              if (mode === 'image')
                return generateImageLocalized({ projectId: project.id, prompt, signal })
              const session = await context.createSession({
                systemPrompt: '你是画布 Agent，只输出可直接写入节点的结果正文。',
                userMessage: prompt,
                tools: [],
                signal,
                timeoutMs: 120000
              })
              try {
                return { text: await session.prompt() }
              } finally {
                session.dispose()
              }
            }
          })
          return result
            ? { ok: true, data: result }
            : { ok: false, error: 'canvas project not found' }
        }
      })

      // Session tools are the Agent-facing surface. The lightweight
      // registerTool definitions above remain available to the host registry;
      // these Pi definitions make the same canvas operations callable in every
      // new Agent session.
      context.registerSessionTools([
        defineTool({
          name: 'canvas_list_projects',
          label: '列出无限画布',
          description: '列出 PI Agent 中的无限画布项目。',
          parameters: Type.Object({}),
          async execute() {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(store.listProjects()) }],
              details: {}
            }
          }
        }),
        defineTool({
          name: 'canvas_get_project',
          label: '读取无限画布',
          description: '读取指定无限画布的节点和连线。',
          parameters: Type.Object({ projectId: Type.String({ description: '画布项目 ID' }) }),
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted)
              return { content: [{ type: 'text' as const, text: 'aborted' }], details: {} }
            const project = store.getProject(params.projectId)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(project ?? { error: 'canvas project not found' })
                }
              ],
              details: {}
            }
          }
        }),
        defineTool({
          name: 'canvas_create_node',
          label: '创建画布节点',
          description:
            '在指定无限画布创建节点。类型：image/text/config/video/audio/group/design-board。',
          parameters: Type.Object({
            projectId: Type.String({ description: '画布项目 ID' }),
            nodeType: Type.String({
              description: '节点类型：image/text/config/video/audio/group/design-board'
            }),
            title: Type.Optional(Type.String()),
            content: Type.Optional(Type.String()),
            x: Type.Optional(Type.Number()),
            y: Type.Optional(Type.Number())
          }),
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted)
              return { content: [{ type: 'text' as const, text: 'aborted' }], details: {} }
            const node = store.createNode(params.projectId, {
              type: nodeType(params.nodeType),
              title: params.title,
              content: params.content,
              x: params.x,
              y: params.y
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(node ?? { error: 'canvas project not found' })
                }
              ],
              details: {}
            }
          }
        })
      ])
      context.registerTool({
        name: 'canvas.get_project',
        description: '读取一个无限画布项目的完整节点和连线。',
        parameters: {
          type: 'object',
          properties: { projectId: { type: 'string', description: '画布项目 ID' } },
          required: ['projectId']
        },
        async execute(args, toolContext) {
          if (toolContext.signal?.aborted) return { ok: false, error: 'aborted' }
          const project = store.getProject(String(args.projectId ?? ''))
          return project
            ? { ok: true, data: project }
            : { ok: false, error: 'canvas project not found' }
        }
      })
      context.registerTool({
        name: 'canvas.add_node',
        description:
          '向指定无限画布添加节点。类型：image/text/config/video/audio/group/design-board。',
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: '画布项目 ID' },
            type: {
              type: 'string',
              description: '节点类型：image/text/config/video/audio/group/design-board'
            },
            title: { type: 'string', description: '节点标题' },
            content: { type: 'string', description: '节点内容' },
            x: { type: 'number', description: '画布 X 坐标' },
            y: { type: 'number', description: '画布 Y 坐标' }
          },
          required: ['projectId', 'type']
        },
        async execute(args, toolContext) {
          if (toolContext.signal?.aborted) return { ok: false, error: 'aborted' }
          const node = store.createNode(String(args.projectId ?? ''), {
            type: nodeType(args.type),
            title: args.title === undefined ? undefined : String(args.title),
            content: args.content === undefined ? undefined : String(args.content),
            x: Number(args.x),
            y: Number(args.y)
          })
          return node ? { ok: true, data: node } : { ok: false, error: 'canvas project not found' }
        }
      })

      context.registerPanel({
        id: 'infinite-canvas-workspace',
        title: '无限画布',
        component: 'InfiniteCanvasWorkspace',
        slot: 'workspace.main',
        scope: 'page',
        priority: 30,
        rendererKey: 'infinite-canvas.workspace',
        entryKey: 'infinite-canvas'
      })
      context.registerPanel({
        id: 'infinite-canvas-navigation',
        title: '无限画布',
        component: 'InfiniteCanvasNavigation',
        slot: 'app.navigation',
        scope: 'app',
        priority: 30,
        rendererKey: 'infinite-canvas.navigation'
      })
      // 媒体生成设置面板：设置中心「插件设置」分区的自定义面板（plugin-settings
      // slot 不需要 entryKey，只有 keyed slot 需要）；渲染组件在桌面端受信
      // renderer 白名单登记（rendererKey 'infinite-canvas.media-settings'）。
      context.registerPanel({
        id: 'infinite-canvas-media-settings',
        title: '媒体生成',
        component: 'InfiniteCanvasMediaSettings',
        slot: 'plugin-settings',
        scope: 'app',
        priority: 10,
        rendererKey: 'infinite-canvas.media-settings'
      })
      context.logger.info('Infinite Canvas 插件已初始化')
    }
  }
}

export default createInfiniteCanvasPlugin
