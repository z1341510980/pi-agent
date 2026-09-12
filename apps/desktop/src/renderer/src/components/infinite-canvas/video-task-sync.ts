import {
  proxyExternalImageUrl,
  type CanvasGraphConnection,
  type CanvasNodeData,
  type CanvasVideoTask
} from '@/api/infinite-canvas-client'
import { createNodeData } from './geometry'

/** applyCompletedVideoTask 的落画布结果：handled=false 时为 null，此形状仅在成功时返回。 */
export interface VideoTaskSyncResult {
  nodes: CanvasNodeData[]
  connections: CanvasGraphConnection[]
  handled: boolean
}

export interface ApplyCompletedVideoTaskOptions {
  /** 视频子节点落点（与派生节点一致：源节点右侧 +96，y 传源节点垂直中心）。 */
  position: { x: number; y: number }
  /**
   * 调用方持有的已处理任务集合：命中即跳过（幂等），成功落画布后回写 task.id。
   * 由调用方跨轮询周期持有，同一任务不会重复生成子节点。
   */
  handledTaskIds?: Set<string>
}

/** 服务端本地资产路径前缀（canvas-assets 的 ASSET_PATH_PREFIX，resultPath 按契约是相对路径）。 */
const ASSET_PATH_MARKER = '/api/plugins/infinite-canvas/assets/'

/**
 * resultPath → 本地资产 id（/api/plugins/infinite-canvas/assets/{id} 的 {id} 段）。
 * 非资产路径（理论上的外部 URL）返回 undefined，跳过内容级幂等检查。
 */
function resultAssetId(resultPath: string): string | undefined {
  const start = resultPath.indexOf(ASSET_PATH_MARKER)
  if (start < 0) return undefined
  const id = resultPath.slice(start + ASSET_PATH_MARKER.length).split(/[?#]/)[0]
  return id || undefined
}

/** 节点已承载该资产：content 或 images（字符串 / {content} 对象两种形式）包含资产 id。 */
function nodeContainsAsset(node: CanvasNodeData, assetId: string): boolean {
  const metadata = node.metadata
  if (!metadata) return false
  if (typeof metadata.content === 'string' && metadata.content.includes(assetId)) return true
  if (Array.isArray(metadata.images)) {
    for (const image of metadata.images) {
      const content = typeof image === 'string' ? image : image?.content
      if (typeof content === 'string' && content.includes(assetId)) return true
    }
  }
  return false
}

/**
 * 把一个已完成的视频任务落到画布：为 nodeId 源节点追加视频子节点 + 连线；幂等。
 *
 * 返回 null（不产生任何变更）的情况：
 * - 任务非 success 终态（running/failed/timeout）；
 * - success 但没有本地结果路径（resultPath 缺失）；
 * - task.nodeId 在画布上找不到对应源节点（节点已删 / 任务未关联节点）；
 * - 任务 id 已在 handledTaskIds 中（同会话重复投递的快速路径）；
 * - 画布已有节点承载该任务的成品资产（resultPath 资产 id 命中现有节点的
 *   content/images）：检查的是持久化的图状态而非内存集合，应用重启后
 *   handled 集合清零也不会对 last-100 任务列表重复落子节点。
 *
 * 子节点镜像 generateNode 同步视频产物节点的 metadata 形状（content/mimeType/
 * prompt/generationMode），尺寸保持视频节点默认值 420×236 —— 轮询落图的子节点
 * 不经过工作区的 readMediaSize + fitNodeSize 精修链路，该默认尺寸即最终尺寸。
 */
export function applyCompletedVideoTask(
  nodes: CanvasNodeData[],
  connections: CanvasGraphConnection[],
  task: CanvasVideoTask,
  opts: ApplyCompletedVideoTaskOptions
): VideoTaskSyncResult | null {
  if (task.status !== 'success' || !task.resultPath) return null
  if (opts.handledTaskIds?.has(task.id)) return null
  // 内容级幂等（跨重启）：成品资产已在画布上 → 记已处理并跳过
  const assetId = resultAssetId(task.resultPath)
  if (assetId && nodes.some((node) => nodeContainsAsset(node, assetId))) {
    opts.handledTaskIds?.add(task.id)
    return null
  }
  const source = nodes.find((node) => node.id === task.nodeId)
  if (!source) return null
  const child = createNodeData('video', opts.position, {
    content: proxyExternalImageUrl(task.resultPath),
    status: undefined,
    prompt: typeof source.metadata?.prompt === 'string' ? source.metadata.prompt : undefined,
    generationMode: 'video',
    mimeType: 'video/mp4'
  })
  child.title = `${source.title} 视频`
  opts.handledTaskIds?.add(task.id)
  return {
    nodes: [...nodes, child],
    connections: [
      ...connections,
      {
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        fromNodeId: source.id,
        toNodeId: child.id
      }
    ],
    handled: true
  }
}
