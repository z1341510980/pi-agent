import type {
  CanvasGenerationContext,
  CanvasGenerationReference,
  CanvasNodeData,
  CanvasGraphConnection
} from '@/api/infinite-canvas-client'

export type { CanvasGenerationContext, CanvasGenerationReference }

const MAX_TEXT_LENGTH = 12_000

function textContent(node: CanvasNodeData): string {
  const value = node.metadata?.content ?? node.metadata?.prompt ?? ''
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT_LENGTH) : ''
}

function mediaContent(node: CanvasNodeData): string {
  const value = node.metadata?.content
  return typeof value === 'string' ? value.trim() : ''
}

function resourceKind(node: CanvasNodeData): CanvasGenerationReference['kind'] | null {
  if (node.type === 'image' && mediaContent(node)) return 'image'
  if (node.type === 'video' && mediaContent(node)) return 'video'
  if (node.type === 'audio' && mediaContent(node)) return 'audio'
  if (node.type === 'text' && textContent(node)) return 'text'
  return null
}

function labelFor(kind: CanvasGenerationReference['kind'], index: number): string {
  const labels: Record<CanvasGenerationReference['kind'], string> = {
    text: '文本参考',
    image: '图片参考',
    video: '视频参考',
    audio: '音频参考'
  }
  return `${labels[kind]} ${index + 1}`
}

function directUpstreamNodes(
  nodeId: string,
  nodes: CanvasNodeData[],
  connections: CanvasGraphConnection[]
): CanvasNodeData[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const direct = connections
    .filter((connection) => connection.toNodeId === nodeId)
    .map((connection) => byId.get(connection.fromNodeId))
    .filter((node): node is CanvasNodeData => Boolean(node && node.type !== 'group'))

  // A generated result connected from a config node inherits the config node's
  // actual resource inputs, matching the reference canvas semantics.
  const configInputs = direct
    .filter((node) => node.type === 'config')
    .flatMap((config) =>
      connections
        .filter((connection) => connection.toNodeId === config.id)
        .map((connection) => byId.get(connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && node.type !== 'group' && node.type !== 'config'))
    )
  return configInputs.length ? configInputs : direct.filter((node) => node.type !== 'config')
}

function referenceFromNode(
  node: CanvasNodeData,
  indexes: Record<CanvasGenerationReference['kind'], number>
): CanvasGenerationReference | undefined {
  const kind = resourceKind(node)
  if (!kind) return undefined
  const index = indexes[kind]++
  const content = mediaContent(node)
  const base = {
    nodeId: node.id,
    title: node.title || labelFor(kind, index),
    kind,
    label: labelFor(kind, index)
  } satisfies Pick<CanvasGenerationReference, 'nodeId' | 'title' | 'kind' | 'label'>

  if (kind === 'text') return { ...base, text: textContent(node) }
  const metadata = node.metadata ?? {}
  return {
    ...base,
    ...(content.startsWith('data:') ? { dataUrl: content } : { url: content }),
    ...(typeof metadata.storageKey === 'string' ? { storageKey: metadata.storageKey } : {}),
    ...(typeof metadata.mimeType === 'string' ? { mimeType: metadata.mimeType } : {}),
    ...(typeof metadata.bytes === 'number' ? { bytes: metadata.bytes } : {}),
    ...(typeof metadata.naturalWidth === 'number' ? { width: metadata.naturalWidth } : {}),
    ...(typeof metadata.naturalHeight === 'number' ? { height: metadata.naturalHeight } : {}),
    ...(typeof metadata.durationMs === 'number' ? { durationMs: metadata.durationMs } : {})
  }
}

function selectPromptReferences(
  prompt: string,
  references: CanvasGenerationReference[]
): { prompt: string; references: CanvasGenerationReference[] } {
  if (!/@\[node:[^\]]+\]/.test(prompt)) return { prompt, references }
  const byNodeId = new Map(references.map((reference) => [reference.nodeId, reference]))
  const selected = new Map<string, CanvasGenerationReference>()
  let lastIndex = 0
  let resolved = ''
  for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
    const index = match.index ?? 0
    resolved += prompt.slice(lastIndex, index)
    const reference = byNodeId.get(match[1].trim())
    if (reference) {
      selected.set(reference.nodeId, reference)
      resolved += reference.kind === 'text' ? `【${reference.label}】` : reference.label || reference.title
    }
    lastIndex = index + match[0].length
  }
  resolved += prompt.slice(lastIndex)
  return { prompt: resolved.replace(/[ \t]{2,}/g, ' ').trim(), references: [...selected.values()] }
}

export function buildCanvasGenerationContext(
  nodeId: string,
  nodes: CanvasNodeData[],
  connections: CanvasGraphConnection[],
  prompt: string
): { prompt: string; context: CanvasGenerationContext; contextText: string } {
  const indexes: Record<CanvasGenerationReference['kind'], number> = {
    text: 0,
    image: 0,
    video: 0,
    audio: 0
  }
  const references = directUpstreamNodes(nodeId, nodes, connections)
    .map((node) => referenceFromNode(node, indexes))
    .filter((reference): reference is CanvasGenerationReference => Boolean(reference))
  const selected = selectPromptReferences(prompt.trim(), references)
  const active = selected.references
  // 在媒体节点上直接生图时，节点自身的内容就是编辑对象：
  // 作为第一张参考图传入（多图提示词约定"第一张是原图"），否则请求退化成纯文字生图
  const source = nodes.find((node) => node.id === nodeId)
  const selfReference =
    source && source.type !== 'text' ? referenceFromNode(source, indexes) : undefined
  const withSelf = (kind: CanvasGenerationReference['kind']): CanvasGenerationReference[] => {
    const bucket = active.filter((reference) => reference.kind === kind)
    return selfReference?.kind === kind ? [selfReference, ...bucket] : bucket
  }
  const context: CanvasGenerationContext = {
    text: active.filter((reference) => reference.kind === 'text'),
    images: withSelf('image'),
    videos: withSelf('video'),
    audios: withSelf('audio')
  }
  const contextText = formatCanvasGenerationContext(context)
  return {
    prompt: selected.prompt || (references.length ? '根据已连接的上游内容执行本次生成任务。' : ''),
    context,
    contextText
  }
}

export function formatCanvasGenerationContext(context: CanvasGenerationContext): string {
  const lines: string[] = []
  for (const reference of context.text) {
    lines.push(`${reference.label || reference.title}：\n${reference.text || ''}`)
  }
  for (const reference of context.images) {
    const dimensions = reference.width && reference.height ? `（${reference.width}×${reference.height}）` : ''
    lines.push(`${reference.label || reference.title}： [图片参考]${dimensions}`)
  }
  for (const reference of context.videos) {
    const dimensions = reference.width && reference.height ? `（${reference.width}×${reference.height}）` : ''
    lines.push(`${reference.label || reference.title}： [视频参考]${dimensions}`)
  }
  for (const reference of context.audios) {
    const duration = reference.durationMs ? `（${Math.round(reference.durationMs / 1000)}s）` : ''
    lines.push(`${reference.label || reference.title}： [音频参考]${duration}`)
  }
  return lines.join('\n')
}

export function withHydratedImageReferences(
  context: CanvasGenerationContext,
  images: string[]
): CanvasGenerationContext {
  const byNodeId = new Map(context.images.map((reference, index) => [reference.nodeId, images[index] || '']))
  return {
    ...context,
    images: context.images.map((reference) => {
      const dataUrl = byNodeId.get(reference.nodeId)
      return dataUrl ? { ...reference, dataUrl, url: dataUrl } : reference
    })
  }
}
