import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { Plugin, PluginContext } from '../../core/plugin/plugin-types.js'
import { infiniteCanvasMigrations } from './migrations.js'
import { createInfiniteCanvasRoutes } from './routes.js'
import { InfiniteCanvasStore } from './store.js'
import type { AnyCanvasNodeType } from './types.js'
import { createPromptSourceService } from './prompt-source-service.js'
import { CanvasMediaSettingsService } from './media-settings.js'
import {
  defaultImageModelForBaseUrl,
  defaultImageModelForProtocol,
  normalizeImageBaseUrl,
  requestImageEdit,
  requestImageGeneration
} from '../../core/config/media-generator.js'
import {
  applyCanvasAgentOperations,
  summarizeCanvasAgentOperations,
  type CanvasAgentOperation
} from './agent-ops.js'

const NODE_TYPE_LIST: Array<AnyCanvasNodeType> = [
  'image',
  'text',
  'config',
  'video',
  'audio',
  'group',
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
      const mediaSettings = new CanvasMediaSettingsService(context.db)
      const imageLogger = context.logger.child({ module: 'infinite-canvas-image' })

      /** 画布独立生图：优先用画布自己的 Base URL + Key，否则走宿主 Provider。 */
      const generateImageWithOverride = async (input: {
        prompt: string
        references?: string[]
        model?: string
        size?: string
        count?: number
        traceId?: string
        signal?: AbortSignal
      }): Promise<{ images: string[] }> => {
        const settings = mediaSettings.get()
        const hasOverride = Boolean(settings.imageBaseUrl && settings.imageApiKey)
        const baseUrl = hasOverride ? normalizeImageBaseUrl(settings.imageBaseUrl) : ''
        const modelId =
          input.model ||
          settings.imageModel ||
          (hasOverride ? defaultImageModelForProtocol(settings.imageProtocol, baseUrl) : undefined)

        if (input.references?.length && hasOverride) {
          const [image, ...images] = input.references
          return requestImageEdit({
            context: {
              baseUrl,
              modelId: modelId || defaultImageModelForProtocol(settings.imageProtocol, baseUrl),
              mediaProtocol: settings.imageProtocol,
              mediaResolution: settings.imageResolution,
              mediaLanguage: settings.imageLanguage,
              headers: { Authorization: `Bearer ${settings.imageApiKey}` }
            },
            prompt: input.prompt,
            image,
            images,
            size: input.size || settings.imageSize,
            signal: input.signal,
            logger: imageLogger,
            traceId: input.traceId
          })
        }
        if (input.references?.length) {
          if (!context.media?.editImage) throw new Error('图像编辑 Provider 尚未配置')
          return context.media.editImage({
            prompt: input.prompt,
            image: input.references[0],
            images: input.references.slice(1),
            model: input.model,
            size: input.size,
            signal: input.signal
          })
        }
        if (hasOverride) {
          const size = input.size || settings.imageSize || (settings.imageProtocol === 'apimart' ? '1:1' : '1024x1024')
          return requestImageGeneration({
            context: {
              baseUrl,
              modelId: modelId || defaultImageModelForProtocol(settings.imageProtocol, baseUrl),
              mediaProtocol: settings.imageProtocol,
              mediaResolution: settings.imageResolution,
              mediaLanguage: settings.imageLanguage,
              headers: { Authorization: `Bearer ${settings.imageApiKey}` }
            },
            prompt: input.prompt,
            size,
            count: input.count ?? 1,
            signal: input.signal,
            logger: imageLogger,
            traceId: input.traceId
          })
        }
        if (!context.media) throw new Error('图片 Provider 尚未配置，请在设置中添加 Provider 或在画布中配置生图 API')
        return context.media.generateImage(input)
      }

      const editImageWithOverride = async (input: {
        prompt: string
        image: string
        images?: string[]
        mask?: string
        model?: string
        size?: string
        traceId?: string
        signal?: AbortSignal
      }): Promise<{ images: string[] }> => {
        const settings = mediaSettings.get()
        if (settings.imageBaseUrl && settings.imageApiKey) {
          const baseUrl = normalizeImageBaseUrl(settings.imageBaseUrl)
          return requestImageEdit({
            context: {
              baseUrl,
              modelId: input.model || settings.imageModel || defaultImageModelForProtocol(settings.imageProtocol, baseUrl),
              mediaProtocol: settings.imageProtocol,
              mediaResolution: settings.imageResolution,
              mediaLanguage: settings.imageLanguage,
              headers: { Authorization: `Bearer ${settings.imageApiKey}` }
            },
            prompt: input.prompt,
            image: input.image,
            images: input.images,
            mask: input.mask,
            size: input.size || settings.imageSize,
            signal: input.signal,
            logger: imageLogger,
            traceId: input.traceId
          })
        }
        if (!context.media?.editImage) throw new Error('图像编辑 Provider 尚未配置')
        return context.media.editImage(input)
      }

      for (const route of createInfiniteCanvasRoutes(
        store,
        async ({ prompt, mode, context: graphContext }) => {
          const session = await context.createSession({
            systemPrompt:
              '你是无限画布里的创作助手。根据提示词和画布上下文输出可直接使用的结果，只输出正文，不要解释过程，不要使用 Markdown 代码围栏。',
            userMessage: `${graphContext ? `画布上下文：\n${graphContext}\n\n` : ''}任务类型：${mode ?? 'text'}\n\n${prompt}`,
            tools: [],
            timeoutMs: 120000
          })
          try {
            return await session.prompt()
          } finally {
            session.dispose()
          }
        },
        generateImageWithOverride,
        ({ mode, prompt, model, voice, format, speed, size, seconds, signal }) => {
          if (!context.media) throw new Error('媒体 Provider 尚未配置')
          return mode === 'audio'
            ? context.media.generateAudio({ prompt, model, voice, format, speed, signal })
            : context.media.generateVideo({ prompt, model, size, seconds, signal })
        },
        editImageWithOverride,
        ({ image, instruction, model, signal }) => {
          if (!context.media?.analyzeImage) throw new Error('视觉理解 Provider 尚未配置')
          return context.media.analyzeImage({ image, instruction, model, signal })
        },
        promptSourceService,
        mediaSettings
      ))
        context.registerRoute(route)

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
                    return generateImageWithOverride({ prompt, signal: generationSignal })
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
                return generateImageWithOverride({ prompt, signal })
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
          description: '在指定无限画布创建节点。类型：image/text/config/video/audio/group。',
          parameters: Type.Object({
            projectId: Type.String({ description: '画布项目 ID' }),
            nodeType: Type.String({ description: '节点类型：image/text/config/video/audio/group' }),
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
        description: '向指定无限画布添加节点。类型：image/text/config/video/audio/group。',
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: '画布项目 ID' },
            type: { type: 'string', description: '节点类型：image/text/config/video/audio/group' },
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
      context.logger.info('Infinite Canvas 插件已初始化')
    }
  }
}

export default createInfiniteCanvasPlugin
