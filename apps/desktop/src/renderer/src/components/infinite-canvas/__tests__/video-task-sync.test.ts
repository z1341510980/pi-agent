import { describe, expect, it } from 'vitest'
import type {
  CanvasGraphConnection,
  CanvasNodeData,
  CanvasVideoTask
} from '@/api/infinite-canvas-client'
import { applyCompletedVideoTask, type VideoTaskSyncResult } from '../video-task-sync'

const source = (overrides: Partial<CanvasNodeData> = {}): CanvasNodeData => ({
  id: 'config-1',
  type: 'config',
  title: '视频配置',
  position: { x: 100, y: 100 },
  width: 340,
  height: 240,
  metadata: { prompt: '一只奔跑的猫' },
  ...overrides
})

const task = (overrides: Partial<CanvasVideoTask> = {}): CanvasVideoTask => ({
  id: 'task-1',
  nodeId: 'config-1',
  taskId: 'upstream-1',
  status: 'success',
  progress: '100',
  error: null,
  model: 'wan-video',
  createdAt: 1_000,
  updatedAt: 2_000,
  resultPath: '/api/plugins/infinite-canvas/assets/abc123',
  ...overrides
})

const apply = (
  nodes: CanvasNodeData[],
  connections: CanvasGraphConnection[] = [],
  overrides: Partial<CanvasVideoTask> = {},
  handledTaskIds?: Set<string>
): VideoTaskSyncResult | null =>
  applyCompletedVideoTask(nodes, connections, task(overrides), {
    // 与工作区一致：源节点右侧 +96，y 取源节点垂直中心
    position: { x: 100 + 340 + 96, y: 100 + 240 / 2 },
    handledTaskIds
  })

describe('applyCompletedVideoTask', () => {
  it('成功任务落成视频子节点 + 连线，并回写已处理集合', () => {
    const handled = new Set<string>()
    const result = apply([source()], [], {}, handled)

    expect(result).not.toBeNull()
    expect(result!.handled).toBe(true)
    expect(result!.nodes).toHaveLength(2)
    expect(result!.connections).toHaveLength(1)

    const child = result!.nodes[1]
    expect(child.type).toBe('video')
    expect(child.title).toBe('视频配置 视频')
    // 资产路径补全为后端绝对地址（测试环境默认 base http://127.0.0.1:3900）
    expect(child.metadata?.content).toBe(
      'http://127.0.0.1:3900/api/plugins/infinite-canvas/assets/abc123'
    )
    expect(child.metadata?.mimeType).toBe('video/mp4')
    expect(child.metadata?.generationMode).toBe('video')
    expect(child.metadata?.prompt).toBe('一只奔跑的猫')
    expect(child.metadata?.videoTaskId).toBeUndefined()
    // 视频节点默认尺寸（420×236），落点以传入 position 为中心
    expect(child.width).toBe(420)
    expect(child.height).toBe(236)
    expect(child.position).toEqual({ x: 100 + 340 + 96 - 210, y: 100 + 120 - 118 })

    const connection = result!.connections[0]
    expect(connection.fromNodeId).toBe('config-1')
    expect(connection.toNodeId).toBe(child.id)

    expect(handled.has('task-1')).toBe(true)
  })

  it('同一任务重复投递时幂等：第二次返回 null 且不再追加节点', () => {
    const handled = new Set<string>()
    const nodes = [source()]
    const first = apply(nodes, [], {}, handled)
    expect(first).not.toBeNull()

    const second = apply(first!.nodes, first!.connections, {}, handled)
    expect(second).toBeNull()
    expect(first!.nodes).toHaveLength(2)
    expect(first!.connections).toHaveLength(1)
  })

  it('未提供 handledTaskIds 时直接追加（由调用方负责幂等）', () => {
    const result = apply([source()])
    expect(result).not.toBeNull()
    expect(result!.handled).toBe(true)
  })

  it('非 success 终态任务一律返回 null', () => {
    for (const status of ['running', 'failed', 'timeout'] as const) {
      expect(apply([source()], [], { status, resultPath: undefined })).toBeNull()
    }
  })

  it('success 但缺少本地结果路径时返回 null', () => {
    expect(apply([source()], [], { resultPath: undefined })).toBeNull()
  })

  it('源节点缺失（已删 / 未关联 nodeId）时返回 null', () => {
    expect(apply([source()], [], { nodeId: 'deleted-node' })).toBeNull()
    expect(apply([source()], [], { nodeId: null })).toBeNull()
  })

  it('不修改传入的 nodes/connections 原数组', () => {
    const nodes = [source()]
    const connections: CanvasGraphConnection[] = [
      { id: 'conn-0', fromNodeId: 'other', toNodeId: 'config-1' }
    ]
    const result = applyCompletedVideoTask(nodes, connections, task(), {
      position: { x: 0, y: 0 }
    })
    expect(result).not.toBeNull()
    expect(nodes).toHaveLength(1)
    expect(connections).toHaveLength(1)
    expect(result!.nodes[0]).toBe(nodes[0])
    expect(result!.connections[0]).toBe(connections[0])
  })
})
