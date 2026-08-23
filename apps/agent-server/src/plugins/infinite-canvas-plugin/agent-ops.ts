import { randomUUID } from 'node:crypto'

import type { InfiniteCanvasStore } from './store.js'
import type { AnyCanvasNodeType, CanvasProject } from './types.js'

export interface CanvasAgentOperation {
  type?: string
  id?: string
  ids?: unknown
  nodeType?: unknown
  nodeId?: string
  fromNodeId?: string
  toNodeId?: string
  title?: unknown
  content?: unknown
  position?: unknown
  x?: unknown
  y?: unknown
  width?: unknown
  height?: unknown
  metadata?: unknown
  patch?: unknown
  all?: unknown
  viewport?: unknown
  mode?: unknown
  prompt?: unknown
}

export interface CanvasAgentOutput {
  text?: string
  images?: string[]
}

export type CanvasAgentGenerator = (input: {
  prompt: string
  mode: 'text' | 'image' | 'video' | 'audio'
  signal?: AbortSignal
}) => Promise<CanvasAgentOutput>

export interface CanvasAgentApplyResult {
  project: CanvasProject
  selectedNodeIds: string[]
  applied: string[]
  ignored: string[]
}

type GraphNode = {
  id: string
  type: AnyCanvasNodeType
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  metadata: Record<string, unknown>
}

type GraphConnection = { id: string; fromNodeId: string; toNodeId: string }

const BUILTIN_TYPES = new Set([
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
const EXTENSION_TYPE = /^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9_-]{0,63}$/

function nodeType(value: unknown): AnyCanvasNodeType {
  const type = String(value ?? 'text')
  return BUILTIN_TYPES.has(type) || EXTENSION_TYPE.test(type) ? (type as AnyCanvasNodeType) : 'text'
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function initialGraph(project: CanvasProject): {
  nodes: GraphNode[]
  connections: GraphConnection[]
} {
  return {
    nodes: project.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      content: node.content,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      metadata: { ...node.metadata }
    })),
    connections: project.connections.map((connection) => ({
      id: connection.id,
      fromNodeId: connection.fromNodeId,
      toNodeId: connection.toNodeId
    }))
  }
}

function graphNodeFromOperation(operation: CanvasAgentOperation, index: number): GraphNode {
  const metadata = { ...record(operation.metadata) }
  const content =
    typeof operation.content === 'string'
      ? operation.content
      : typeof metadata.content === 'string'
        ? metadata.content
        : ''
  if (content && metadata.content === undefined) metadata.content = content
  const position = record(operation.position)
  return {
    id:
      typeof operation.id === 'string' && operation.id
        ? operation.id
        : `${nodeType(operation.nodeType)}-${Date.now()}-${index}-${randomUUID().slice(0, 6)}`,
    type: nodeType(operation.nodeType),
    title: typeof operation.title === 'string' ? operation.title : '',
    content,
    x: finite(position.x ?? operation.x, index * 48 + 80),
    y: finite(position.y ?? operation.y, index * 48 + 80),
    width: Math.max(40, finite(operation.width, 340)),
    height: Math.max(40, finite(operation.height, 240)),
    metadata
  }
}

function updateGraphNode(node: GraphNode, operation: CanvasAgentOperation): void {
  const patch = record(operation.patch)
  if (typeof patch.type === 'string') node.type = nodeType(patch.type)
  if (typeof patch.title === 'string') node.title = patch.title
  if (typeof patch.content === 'string') {
    node.content = patch.content
    node.metadata.content = patch.content
  }
  if (patch.position && typeof patch.position === 'object') {
    const position = record(patch.position)
    node.x = finite(position.x, node.x)
    node.y = finite(position.y, node.y)
  }
  node.x = finite(patch.x, node.x)
  node.y = finite(patch.y, node.y)
  node.width = Math.max(40, finite(patch.width, node.width))
  node.height = Math.max(40, finite(patch.height, node.height))
  const metadataPatch = { ...record(patch.metadata), ...record(operation.metadata) }
  node.metadata = { ...node.metadata, ...metadataPatch }
  if (typeof node.metadata.content === 'string') node.content = node.metadata.content
}

function normalizeViewport(
  value: unknown,
  fallback: CanvasProject['viewport']
): CanvasProject['viewport'] {
  const viewport = record(value)
  return {
    x: finite(viewport.x, fallback.x),
    y: finite(viewport.y, fallback.y),
    zoom: Math.min(5, Math.max(0.1, finite(viewport.zoom, fallback.zoom)))
  }
}

export async function applyCanvasAgentOperations(
  store: InfiniteCanvasStore,
  projectId: string,
  operations: CanvasAgentOperation[],
  options: { signal?: AbortSignal; generate?: CanvasAgentGenerator } = {}
): Promise<CanvasAgentApplyResult | undefined> {
  const project = store.getProject(projectId)
  if (!project) return undefined
  const graph = initialGraph(project)
  let viewport = project.viewport
  let selectedNodeIds: string[] = []
  const applied: string[] = []
  const ignored: string[] = []
  const generationOps: CanvasAgentOperation[] = []

  for (const operation of operations) {
    const type = operation.type
    if (!type) {
      ignored.push('unknown')
      continue
    }
    if (type === 'add_node') {
      graph.nodes.push(graphNodeFromOperation(operation, graph.nodes.length))
      applied.push(type)
    } else if (type === 'update_node') {
      const target = graph.nodes.find((node) => node.id === operation.id)
      if (target) {
        updateGraphNode(target, operation)
        applied.push(type)
      } else ignored.push(type)
    } else if (type === 'delete_node') {
      const ids = new Set([
        ...stringIds(operation.ids),
        ...(operation.id ? [operation.id] : []),
        ...(operation.nodeType
          ? graph.nodes
              .filter((node) => node.type === nodeType(operation.nodeType))
              .map((node) => node.id)
          : [])
      ])
      graph.nodes = graph.nodes.filter((node) => !ids.has(node.id))
      graph.connections = graph.connections.filter(
        (connection) => !ids.has(connection.fromNodeId) && !ids.has(connection.toNodeId)
      )
      selectedNodeIds = selectedNodeIds.filter((id) => !ids.has(id))
      applied.push(type)
    } else if (type === 'delete_connections') {
      if (operation.all) graph.connections = []
      else {
        const ids = new Set([...stringIds(operation.ids), ...(operation.id ? [operation.id] : [])])
        graph.connections = graph.connections.filter((connection) => !ids.has(connection.id))
      }
      applied.push(type)
    } else if (type === 'connect_nodes') {
      const fromNodeId = String(operation.fromNodeId ?? '')
      const toNodeId = String(operation.toNodeId ?? '')
      if (
        fromNodeId &&
        toNodeId &&
        fromNodeId !== toNodeId &&
        graph.nodes.some((node) => node.id === fromNodeId) &&
        graph.nodes.some((node) => node.id === toNodeId) &&
        !graph.connections.some(
          (connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId
        )
      ) {
        graph.connections.push({ id: operation.id || randomUUID(), fromNodeId, toNodeId })
        applied.push(type)
      } else ignored.push(type)
    } else if (type === 'set_viewport') {
      viewport = normalizeViewport(operation.viewport, viewport)
      applied.push(type)
    } else if (type === 'select_nodes') {
      const requested = stringIds(operation.ids)
      selectedNodeIds = requested.filter((id) => graph.nodes.some((node) => node.id === id))
      applied.push(type)
    } else if (type === 'run_generation') {
      generationOps.push(operation)
      applied.push(type)
    } else {
      ignored.push(type)
    }
  }

  if (options.signal?.aborted) return undefined
  let updated = store.replaceGraph(projectId, {
    nodes: graph.nodes,
    connections: graph.connections,
    viewport
  })
  if (!updated) return undefined

  for (const operation of generationOps) {
    if (!options.generate || options.signal?.aborted) break
    const target: CanvasProject['nodes'][number] | undefined = updated.nodes.find(
      (node) => node.id === operation.nodeId
    )
    if (!target) {
      ignored.push('run_generation:missing_node')
      continue
    }
    const mode =
      operation.mode === 'image' || operation.mode === 'video' || operation.mode === 'audio'
        ? operation.mode
        : 'text'
    const prompt =
      typeof operation.prompt === 'string' && operation.prompt.trim()
        ? operation.prompt.trim()
        : String(target.metadata.composerContent ?? target.metadata.prompt ?? target.content ?? '')
    if (!prompt) {
      ignored.push('run_generation:empty_prompt')
      continue
    }
    const output = await options.generate({ prompt, mode, signal: options.signal })
    if (output.images?.length) {
      const newNodes: GraphNode[] = output.images.map((image, index) => ({
        id: randomUUID(),
        type: 'image',
        title: `${target.title || '生成图片'} ${index + 1}`,
        content: image,
        x: target.x + target.width + 96,
        y: target.y + index * (target.height + 24),
        width: 340,
        height: 240,
        metadata: { content: image, status: 'success', prompt, generationMode: mode }
      }))
      const generatedProject = store.replaceGraph(projectId, {
        nodes: [
          ...updated.nodes.map((node) => ({
            id: node.id,
            type: node.type,
            title: node.title,
            content: node.content,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            metadata: node.metadata
          })),
          ...newNodes
        ],
        connections: [
          ...updated.connections.map((connection) => ({
            id: connection.id,
            fromNodeId: connection.fromNodeId,
            toNodeId: connection.toNodeId
          })),
          ...newNodes.map((node) => ({
            id: randomUUID(),
            fromNodeId: target.id,
            toNodeId: node.id
          }))
        ],
        viewport: updated.viewport
      })
      if (!generatedProject) return undefined
      updated = generatedProject
    } else if (output.text) {
      const node: CanvasProject['nodes'][number] | undefined = updated.nodes.find(
        (candidate) => candidate.id === target.id
      )
      if (!node) continue
      const updatedNode = store.updateNode(node.id, {
        content: output.text,
        metadata: {
          ...node.metadata,
          content: output.text,
          status: 'success',
          generationMode: mode,
          prompt
        }
      })
      if (updatedNode) {
        const refreshed = store.getProject(projectId)
        if (refreshed) updated = refreshed
      }
    }
  }

  return { project: updated, selectedNodeIds, applied, ignored }
}

export function summarizeCanvasAgentOperations(operations: CanvasAgentOperation[]): string {
  const counts = new Map<string, number>()
  for (const operation of operations) {
    const type = operation.type || 'unknown'
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()].map(([type, count]) => `${type} ${count}`).join('，')
}
