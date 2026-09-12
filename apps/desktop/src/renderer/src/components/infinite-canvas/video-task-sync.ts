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

/**
 * 把一个已完成的视频任务落到画布：为 nodeId 源节点追加视频子节点 + 连线；幂等。
 *
 * 返回 null（不产生任何变更）的情况：
 * - 任务非 success 终态（running/failed/timeout）；
 * - success 但没有本地结果路径（resultPath 缺失）；
 * - task.nodeId 在画布上找不到对应源节点（节点已删 / 任务未关联节点）；
 * - 任务 id 已在 handledTaskIds 中（重复投递）。
 *
 * 子节点镜像 generateNode 同步视频产物节点的 metadata 形状（content/mimeType/
 * prompt/generationMode），尺寸保持视频节点默认值；媒体尺寸精修由工作区的
 * readMediaSize + fitNodeSize 链路按需补齐，纯函数不做异步测量。
 */
export function applyCompletedVideoTask(
  nodes: CanvasNodeData[],
  connections: CanvasGraphConnection[],
  task: CanvasVideoTask,
  opts: ApplyCompletedVideoTaskOptions
): VideoTaskSyncResult | null {
  if (task.status !== 'success' || !task.resultPath) return null
  if (opts.handledTaskIds?.has(task.id)) return null
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
