import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import {
  BookOpen,
  BookmarkPlus,
  Brush,
  Copy,
  Crop,
  Download,
  FilePlus2,
  FileUp,
  FolderOpen,
  Grid2x2,
  ImageIcon,
  Maximize2,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ScanText,
  Trash2
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  createCanvasProject,
  deleteCanvasProject,
  editCanvasImage,
  generateCanvasImage,
  generateCanvasMedia,
  generateCanvasText,
  getCanvasProject,
  listCanvasProjects,
  proxyExternalImageUrl,
  renameCanvasProject,
  reverseCanvasPrompt,
  saveCanvasGraphBody,
  uploadCanvasAsset,
  type CanvasGraphPayload,
  type CanvasNodeRow,
  type CanvasProject,
  type CanvasProjectSettings,
  type CanvasNodeData as ApiCanvasNodeData,
  type ViewportTransform
} from '@/api/infinite-canvas-client'
import { cn } from '@/lib/utils'
import {
  downloadJson,
  downloadUrl,
  imageFileExtension,
  resolveDownloadBlob,
  withImageExtension
} from '@/lib/download'
import { CanvasNode } from './canvas-node'
import {
  GRAPH_PAYLOAD_LIMIT_BYTES,
  compressImageDataUrl,
  formatBytes,
  graphPayload as buildGraphPayload,
  shouldPersistGraph
} from './graph-persistence'
import { CanvasNodePanel, type MentionReference } from './canvas-node-panel'
import { ConnectionPath, ActiveConnectionPath } from './canvas-connections'
import { useCanvasTheme } from './canvas-theme'
import {
  createNodeData,
  findContainingGroupId,
  findGroupDropTarget,
  fitNodeSize,
  nodeBounds,
  normalizeConnection,
  snapNodesIntoGroup
} from './geometry'
import { getCanvasExtensionDefinition } from './node-registry'
import { InfiniteCanvas } from './infinite-canvas'
import {
  CanvasContextMenu,
  CanvasToolbar,
  CanvasTopBar,
  ConnectionCreateMenu,
  Minimap,
  NodeCreateMenu,
  CanvasZoomControls
} from './canvas-chrome'
import type {
  CanvasTool,
  ConnectionHandle,
  ContextMenuState,
  PendingConnectionCreate,
  Position,
  SelectionBox
} from './types'
import {
  CropDialog,
  MaskEditDialog,
  SplitDialog,
  UpscaleDialog,
  cropDataUrl,
  splitDataUrls,
  upscaleDataUrl
} from './media-dialog'
import { CanvasAssetLibrary, saveCanvasAsset, type CanvasAsset } from './asset-library'
import { CanvasAgentPanel } from './canvas-agent-panel'
import { MediaConfigDialog } from './media-config-dialog'
import { MediaLogPanel } from './media-log-panel'
import {
  buildCanvasGenerationContext,
  withHydratedImageReferences
} from './generation-context'
import {
  buildZipBlob,
  collectBatchDownloadItemsWithEmptyNodes,
  mediaFileExtension,
  uniqueBatchFilename
} from './batch-download'

type LocalNode = ApiCanvasNodeData
type LocalConnection = { id: string; fromNodeId: string; toNodeId: string }
type ProjectListItem = Omit<CanvasProject, 'nodes' | 'connections'>

type HistorySnapshot = {
  nodes: LocalNode[]
  connections: LocalConnection[]
  viewport: ViewportTransform
  settings: CanvasProjectSettings
}

type DragState = {
  startX: number
  startY: number
  initial: Array<{ id: string; x: number; y: number }>
  moved: boolean
  pendingSnapshot?: HistorySnapshot
}

const DEFAULT_SETTINGS: CanvasProjectSettings = { backgroundMode: 'lines', showImageInfo: false }
const DEFAULT_VIEWPORT: ViewportTransform = { x: 0, y: 0, k: 1 }

function cloneNodes(nodes: LocalNode[]): LocalNode[] {
  return nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    metadata: node.metadata ? { ...node.metadata } : undefined
  }))
}

function cloneConnections(connections: LocalConnection[]): LocalConnection[] {
  return connections.map((connection) => ({ ...connection }))
}

function projectNodeFromRow(row: CanvasNodeRow): LocalNode {
  const metadata = { ...(row.metadata ?? {}) }
  if (metadata.content === undefined && row.content) metadata.content = row.content
  // 图片节点的外部生成 URL 统一换成服务端代理地址，避免渲染层 CSP 拦截。
  if (row.type === 'image' && typeof metadata.content === 'string') {
    metadata.content = proxyExternalImageUrl(metadata.content)
  }
  if (Array.isArray(metadata.images)) {
    metadata.images = metadata.images.map((image) =>
      typeof image === 'string' ? proxyExternalImageUrl(image) : image
    )
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    position: { x: row.x, y: row.y },
    width: row.width,
    height: row.height,
    metadata
  }
}

function localGraphFromProject(project: CanvasProject): {
  nodes: LocalNode[]
  connections: LocalConnection[]
  viewport: ViewportTransform
  settings: CanvasProjectSettings
} {
  return {
    nodes: project.nodes.map(projectNodeFromRow),
    connections: project.connections.map((connection) => ({
      id: connection.id,
      fromNodeId: connection.fromNodeId,
      toNodeId: connection.toNodeId
    })),
    viewport: { x: project.viewport.x, y: project.viewport.y, k: project.viewport.zoom },
    settings: { ...DEFAULT_SETTINGS, ...(project.settings ?? {}) }
  }
}

function graphPayload(
  nodes: LocalNode[],
  connections: LocalConnection[],
  viewport: ViewportTransform,
  settings: CanvasProjectSettings
): CanvasGraphPayload {
  return buildGraphPayload(nodes, connections, viewport, settings)
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

async function imageContentAsDataUrl(content: string): Promise<string> {
  if (content.startsWith('data:')) return content
  // 外部 URL 直连会被 connect-src CSP 拦截，经服务端代理取回。
  const response = await fetch(proxyExternalImageUrl(content))
  if (!response.ok) throw new Error(`参考图片读取失败（HTTP ${response.status}）`)
  const blob = await response.blob()
  return fileAsDataUrl(new File([blob], 'reference-image', { type: blob.type || 'image/png' }))
}

function readMediaSize(
  url: string,
  type: 'image' | 'video'
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const element = type === 'image' ? new Image() : document.createElement('video')
    const finish = (): void => {
      const width =
        type === 'image'
          ? (element as HTMLImageElement).naturalWidth
          : (element as HTMLVideoElement).videoWidth
      const height =
        type === 'image'
          ? (element as HTMLImageElement).naturalHeight
          : (element as HTMLVideoElement).videoHeight
      resolve({ width: width || 1280, height: height || 720 })
    }
    element.onload = finish
    element.onloadedmetadata = finish
    element.onerror = finish
    element.src = url
  })
}

export function InfiniteCanvasWorkspace({
  onClose,
  active = true,
}: {
  onClose?: () => void
  /**
   * 当前视图是否可见。keep-alive 下隐藏挂载时必须关闭全局按键监听：
   * 这里的 Delete/Backspace/Ctrl+Z/Ctrl+A 都带 preventDefault，会在
   * 其他页面上吞键并操作不可见画布的选区。
   */
  active?: boolean
}): ReactElement {
  const theme = useCanvasTheme()
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [project, setProject] = useState<CanvasProject | null>(null)
  const [nodes, setNodes] = useState<LocalNode[]>([])
  const [connections, setConnections] = useState<LocalConnection[]>([])
  const [viewport, setViewport] = useState<ViewportTransform>(DEFAULT_VIEWPORT)
  const [settings, setSettings] = useState<CanvasProjectSettings>(DEFAULT_SETTINGS)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set())
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  // Reference behavior starts in pan mode; Space/Ctrl temporarily invert it.
  const [tool, setTool] = useState<CanvasTool>('pan')
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null)
  const [pendingConnectionCreate, setPendingConnectionCreate] =
    useState<PendingConnectionCreate | null>(null)
  const [connecting, setConnecting] = useState<ConnectionHandle | null>(null)
  const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null)
  const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 })
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null)
  const [miniMapOpen, setMiniMapOpen] = useState(false)
  const [sidePanelOpen, setSidePanelOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 整图保存失败/被跳过的提示：不能用 error，那会整屏替换掉还没落库的画布。 */
  const [saveError, setSaveError] = useState<string | null>(null)
  const [batchDownloading, setBatchDownloading] = useState(false)
  const [canvasSize, setCanvasSize] = useState({ width: 1200, height: 720 })
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false })
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [panelNodeId, setPanelNodeId] = useState<string | null>(null)
  const [runningNodeId, setRunningNodeId] = useState<string | null>(null)
  const [mediaDialog, setMediaDialog] = useState<{
    type: 'crop' | 'split' | 'upscale' | 'mask'
    nodeId: string
  } | null>(null)
  const [replaceMediaNodeId, setReplaceMediaNodeId] = useState<string | null>(null)
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [mediaConfigOpen, setMediaConfigOpen] = useState(false)
  const [mediaLogsOpen, setMediaLogsOpen] = useState(false)
  const [assetLibraryState, setAssetLibraryState] = useState<{
    open: boolean
    tab: 'assets' | 'prompts'
  }>({ open: false, tab: 'assets' })

  const canvasRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const jsonInputRef = useRef<HTMLInputElement>(null)
  const replaceMediaInputRef = useRef<HTMLInputElement>(null)
  const nodesRef = useRef(nodes)
  const connectionsRef = useRef(connections)
  const viewportRef = useRef(viewport)
  const settingsRef = useRef(settings)
  const selectedRef = useRef(selectedNodeIds)
  const connectingRef = useRef(connecting)
  const selectionRef = useRef<SelectionBox | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const historyRef = useRef<{ past: HistorySnapshot[]; future: HistorySnapshot[] }>({
    past: [],
    future: []
  })
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipPersistRef = useRef(false)
  /** 服务端最近一次确认保存的节点数，用于空图覆盖防护。 */
  const savedNodeCountRef = useRef(0)
  /** 最近一次成功保存的载荷原文：内容未变（撤销/重做/视口回位）时跳过重复上传。 */
  const lastSavedBodyRef = useRef<string | null>(null)
  const initialCenterRef = useRef(false)
  const clipboardRef = useRef<{ nodes: LocalNode[]; connections: LocalConnection[] } | null>(null)
  const viewportAnimationRef = useRef<number | null>(null)
  const generationControllersRef = useRef(new Map<string, AbortController>())
  const pendingSelectionRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    nodesRef.current = nodes
    connectionsRef.current = connections
    viewportRef.current = viewport
    settingsRef.current = settings
    selectedRef.current = selectedNodeIds
    connectingRef.current = connecting
  }, [nodes, connections, viewport, settings, selectedNodeIds, connecting])

  const screenToWorld = useCallback((clientX: number, clientY: number): Position => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    const current = viewportRef.current
    return {
      x: (clientX - left - current.x) / current.k,
      y: (clientY - top - current.y) / current.k
    }
  }, [])

  const canvasCenter = useCallback((): Position => {
    const current = viewportRef.current
    return {
      x: (canvasSize.width / 2 - current.x) / current.k,
      y: (canvasSize.height / 2 - current.y) / current.k
    }
  }, [canvasSize.height, canvasSize.width])

  const snapshot = useCallback(
    (): HistorySnapshot => ({
      nodes: cloneNodes(nodesRef.current),
      connections: cloneConnections(connectionsRef.current),
      viewport: { ...viewportRef.current },
      settings: { ...settingsRef.current }
    }),
    []
  )

  const pushHistory = useCallback(
    (entry?: HistorySnapshot): void => {
      const current = entry ?? snapshot()
      historyRef.current.past = [...historyRef.current.past.slice(-49), current]
      historyRef.current.future = []
      setHistoryState({ canUndo: true, canRedo: false })
    },
    [snapshot]
  )

  const applySnapshot = useCallback((next: HistorySnapshot): void => {
    skipPersistRef.current = true
    setNodes(cloneNodes(next.nodes))
    setConnections(cloneConnections(next.connections))
    setViewport({ ...next.viewport })
    setSettings({ ...next.settings })
    setSelectedNodeIds(new Set())
    setSelectedConnectionId(null)
    setContextMenu(null)
  }, [])

  const undo = useCallback((): void => {
    const previous = historyRef.current.past.pop()
    if (!previous) return
    historyRef.current.future.push(snapshot())
    applySnapshot(previous)
    setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: true })
  }, [applySnapshot, snapshot])

  const redo = useCallback((): void => {
    const next = historyRef.current.future.pop()
    if (!next) return
    historyRef.current.past.push(snapshot())
    applySnapshot(next)
    setHistoryState({ canUndo: true, canRedo: historyRef.current.future.length > 0 })
  }, [applySnapshot, snapshot])

  const restoreProject = useCallback((nextProject: CanvasProject): void => {
    const graph = localGraphFromProject(nextProject)
    skipPersistRef.current = true
    savedNodeCountRef.current = nextProject.nodes.length
    lastSavedBodyRef.current = null
    setSaveError(null)
    setProject(nextProject)
    setSelectedProjectId(nextProject.id)
    setNodes(graph.nodes)
    setConnections(graph.connections)
    setViewport(graph.viewport)
    setSettings(graph.settings)
    setSelectedNodeIds(new Set())
    setSelectedConnectionId(null)
    setConnecting(null)
    setContextMenu(null)
    setNodeCreatePosition(null)
    setPendingConnectionCreate(null)
    setDropTargetGroupId(null)
    historyRef.current = { past: [], future: [] }
    setHistoryState({ canUndo: false, canRedo: false })
    initialCenterRef.current =
      graph.viewport.x !== 0 || graph.viewport.y !== 0 || graph.viewport.k !== 1
  }, [])

  const loadProject = useCallback(
    async (id: string): Promise<void> => {
      setLoading(true)
      try {
        restoreProject(await getCanvasProject(id))
        setError(null)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '画布加载失败')
      } finally {
        setLoading(false)
      }
    },
    [restoreProject]
  )

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await listCanvasProjects()
      setProjects(list)
      const id =
        selectedProjectId && list.some((item) => item.id === selectedProjectId)
          ? selectedProjectId
          : list[0]?.id
      if (id) await loadProject(id)
      else {
        const created = await createCanvasProject({ title: '未命名画布' })
        setProjects((current) => [created, ...current])
        restoreProject(created)
      }
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '画布加载失败')
    } finally {
      setLoading(false)
    }
  }, [loadProject, restoreProject, selectedProjectId])

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const element = canvasRef.current
    if (!element) return
    const updateSize = (): void => {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      setCanvasSize({ width: rect.width, height: rect.height })
      if (!initialCenterRef.current && project) {
        initialCenterRef.current = true
        setViewport((current) =>
          current.x === 0 && current.y === 0 && current.k === 1
            ? { ...current, x: rect.width / 2, y: rect.height / 2 }
            : current
        )
      }
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [project])

  // 本地优先：任何画布状态变化在 400ms 后整图保存。
  useEffect(() => {
    const projectId = project?.id
    if (!projectId || loading) return
    if (skipPersistRef.current) {
      skipPersistRef.current = false
      return
    }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      // 整图保存会先删光服务端节点：本地为空且服务端有节点时必须是用户显式清空，
      // 否则一次失败的加载就会把画布内容永久删掉。历史栈非空代表加载后有过用户编辑。
      if (
        !shouldPersistGraph({
          localNodeCount: nodesRef.current.length,
          savedNodeCount: savedNodeCountRef.current,
          allowEmpty:
            historyRef.current.past.length > 0 || historyRef.current.future.length > 0
        })
      ) {
        setSaveError('画布内容未加载完整，已跳过本次保存以避免覆盖已保存的节点。')
        return
      }
      const payload = graphPayload(
        nodesRef.current,
        connectionsRef.current,
        viewportRef.current,
        settingsRef.current
      )
      // 只序列化一次：体积检查与请求体共用同一份字符串（大画布 stringify 可观）
      const body = JSON.stringify(payload)
      // 内容与上次保存一致（如仅撤销/重做到已存状态）则跳过 9MB 级的重复上传
      if (body === lastSavedBodyRef.current) return
      if (body.length > GRAPH_PAYLOAD_LIMIT_BYTES) {
        setSaveError(
          `画布内容约 ${formatBytes(body.length)}，超过单次保存上限 ${formatBytes(GRAPH_PAYLOAD_LIMIT_BYTES)}，本次未保存。请删除或压缩体积最大的图片后重试。`
        )
        return
      }
      void saveCanvasGraphBody(projectId, body)
        .then((saved) => {
          savedNodeCountRef.current = saved.nodes.length
          lastSavedBodyRef.current = body
          setSaveError(null)
          setProject(saved)
          setProjects((current) =>
            current.map((item) =>
              item.id === saved.id
                ? {
                    ...item,
                    title: saved.title,
                    description: saved.description,
                    viewport: saved.viewport,
                    settings: saved.settings,
                    updatedAt: saved.updatedAt
                  }
                : item
            )
          )
        })
        .catch((reason) =>
          setSaveError(
            `画布保存失败：${reason instanceof Error ? reason.message : '未知错误'}（本地修改仍在，请重试）`
          )
        )
    }, 400)
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [nodes, connections, viewport, settings, project?.id, loading])

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const groupChildCount = useMemo(() => {
    const counts = new Map<string, number>()
    nodes.forEach((node) => {
      const groupId = node.metadata?.groupId
      if (typeof groupId === 'string') counts.set(groupId, (counts.get(groupId) ?? 0) + 1)
    })
    return counts
  }, [nodes])
  // 每个节点的上游输入统计（config 面板芯片）：按连入的来源节点类型计数。
  const upstreamSummaries = useMemo(() => {
    const summaries = new Map<
      string,
      { textCount: number; imageCount: number; videoCount: number; audioCount: number }
    >()
    for (const connection of connections) {
      const from = nodeMap.get(connection.fromNodeId)
      if (!from || from.type === 'group') continue
      const entry = summaries.get(connection.toNodeId) ?? {
        textCount: 0,
        imageCount: 0,
        videoCount: 0,
        audioCount: 0
      }
      if (from.type === 'image') entry.imageCount += 1
      else if (from.type === 'video') entry.videoCount += 1
      else if (from.type === 'audio') entry.audioCount += 1
      else if (from.type !== 'config') entry.textCount += 1
      summaries.set(connection.toNodeId, entry)
    }
    return summaries
  }, [connections, nodeMap])

  // @引用候选（对齐参考 CanvasConfigComposer 的 mention 数据源）。
  const upstreamMentions = useMemo(() => {
    const map = new Map<string, MentionReference[]>()
    for (const connection of connections) {
      const from = nodeMap.get(connection.fromNodeId)
      if (!from || from.type === 'group' || from.type === 'config') continue
      const list = map.get(connection.toNodeId) ?? []
      if (list.some((item) => item.nodeId === from.id)) continue
      list.push({
        nodeId: from.id,
        title: from.title,
        kind:
          from.type === 'image'
            ? 'image'
            : from.type === 'video'
              ? 'video'
              : from.type === 'audio'
                ? 'audio'
                : 'text'
      })
      map.set(connection.toNodeId, list)
    }
    return map
  }, [connections, nodeMap])

  /**
   * 每个节点的参考图顺序预览：与 buildCanvasGenerationContext 的输出完全一致
   * （自身图排第一、上游按连线顺序、@引用过滤），保证"看到的顺序 = 发送的顺序"。
   */
  const orderedReferencesByNode = useMemo(() => {
    const map = new Map<
      string,
      Array<{ nodeId: string; title: string; src: string; isSelf: boolean }>
    >()
    const configLikeNodes = nodes.filter(
      (node) => node.type === 'config' || node.type === 'image'
    )
    for (const node of configLikeNodes) {
      const built = buildCanvasGenerationContext(
        node.id,
        nodes,
        connections,
        String(node.metadata?.prompt ?? '')
      )
      map.set(
        node.id,
        built.context.images.map((reference, index) => ({
          nodeId: reference.nodeId,
          title: reference.title || `参考图${index + 1}`,
          src: reference.dataUrl || reference.url || '',
          isSelf: reference.nodeId === node.id
        }))
      )
    }
    return map
  }, [nodes, connections])

  /** 把 @[node:id] 标记解析为「标题: 内容」；未知标记移除。 */
  const resolvePromptReferences = useCallback((text: string): string => {
    return text
      .replace(/@\[node:([^\]]+)\]/g, (_match, id: string) => {
        const node = nodesRef.current.find((item) => item.id === id.trim())
        if (!node) return ''
        const nodeContent =
          typeof node.metadata?.content === 'string' ? node.metadata.content.slice(0, 2000) : ''
        return `${node.title}: ${nodeContent}`
      })
      .replace(/[ \t]{2,}/g, ' ')
  }, [])

  const visibleNodes = useMemo(() => {
    const padding = 280
    const left = -viewport.x / viewport.k - padding
    const top = -viewport.y / viewport.k - padding
    const right = left + canvasSize.width / viewport.k + padding * 2
    const bottom = top + canvasSize.height / viewport.k + padding * 2
    return nodes.filter(
      (node) =>
        node.position.x + node.width > left &&
        node.position.x < right &&
        node.position.y + node.height > top &&
        node.position.y < bottom
    )
  }, [canvasSize.height, canvasSize.width, nodes, viewport.k, viewport.x, viewport.y])

  const selectNode = useCallback(
    (event: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>, nodeId: string): Set<string> => {
      const next = new Set(selectedRef.current)
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        if (next.has(nodeId)) next.delete(nodeId)
        else next.add(nodeId)
      } else if (!next.has(nodeId)) {
        next.clear()
        next.add(nodeId)
      }
      setSelectedNodeIds(next)
      return next
    },
    []
  )

  const handleNodeSelectCapture = useCallback(
    (event: React.MouseEvent, nodeId: string): void => {
      if (event.button !== 0) return
      setContextMenu(null)
      setSelectedConnectionId(null)
      pendingSelectionRef.current = selectNode(event, nodeId)
    },
    [selectNode]
  )

  const handleNodeMouseDown = useCallback(
    (event: React.MouseEvent, nodeId: string): void => {
      if (event.button !== 0) return
      event.stopPropagation()
      const selected =
        pendingSelectionRef.current ??
        (selectedRef.current.has(nodeId) ? new Set(selectedRef.current) : selectNode(event, nodeId))
      pendingSelectionRef.current = null
      const dragIds = new Set(selected)
      nodesRef.current.forEach((node) => {
        if (selected.has(node.id) && node.type === 'group') {
          nodesRef.current.forEach((child) => {
            if (child.metadata?.groupId === node.id) dragIds.add(child.id)
          })
        }
      })
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        pendingSnapshot: snapshot(),
        initial: nodesRef.current
          .filter((node) => dragIds.has(node.id))
          .map((node) => ({ id: node.id, x: node.position.x, y: node.position.y }))
      }
      setPanelNodeId(nodeId)
    },
    [selectNode, snapshot]
  )

  const findConnectionTarget = useCallback(
    (
      clientX: number,
      clientY: number,
      current: ConnectionHandle
    ): { nodeId: string | null; isNearNode: boolean } => {
      const world = screenToWorld(clientX, clientY)
      const padding = 32 / Math.max(viewportRef.current.k, 0.05)
      let near = false
      let best: string | null = null
      for (const node of [...nodesRef.current].reverse()) {
        if (node.id === current.nodeId || node.type === 'group') continue
        const inside =
          world.x >= node.position.x &&
          world.x <= node.position.x + node.width &&
          world.y >= node.position.y &&
          world.y <= node.position.y + node.height
        const expanded =
          world.x >= node.position.x - padding &&
          world.x <= node.position.x + node.width + padding &&
          world.y >= node.position.y - padding &&
          world.y <= node.position.y + node.height + padding
        if (!inside && !expanded) continue
        near = true
        if (!normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType))
          continue
        if (inside) {
          best = node.id
          break
        }
        if (!best) best = node.id
      }
      return { nodeId: best, isNearNode: near }
    },
    [screenToWorld]
  )

  const finishNodeDrag = useCallback(
    (clientX: number, clientY: number): void => {
      const drag = dragRef.current
      if (!drag) return
      const currentViewport = viewportRef.current
      const dx = (clientX - drag.startX) / currentViewport.k
      const dy = (clientY - drag.startY) / currentViewport.k
      if (drag.moved) {
        // 对齐参考项目：拖拽期间暂停历史，仅在确实移动后提交拖拽前快照。
        pushHistory(drag.pendingSnapshot)
        const movedIds = new Set(drag.initial.map((item) => item.id))
        setNodes((current) => {
          const moved = current.map((node) => {
            const initial = drag.initial.find((item) => item.id === node.id)
            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node
          })
          const group = findGroupDropTarget(movedIds, moved)
          if (group) return snapNodesIntoGroup(movedIds, moved, group)
          return moved.map((node) => {
            if (!movedIds.has(node.id) || node.type === 'group') return node
            const groupId = findContainingGroupId(node, moved)
            return node.metadata?.groupId === groupId
              ? node
              : { ...node, metadata: { ...node.metadata, groupId } }
          })
        })
      }
      dragRef.current = null
      setDropTargetGroupId(null)
    },
    [pushHistory]
  )

  useEffect(() => {
    // 高报告率鼠标（1000Hz）下每个 mousemove 都全量重建节点数组会掉帧：
    // 拖拽移动按 rAF 合帧，每帧最多提交一次
    let dragFrame = 0
    let dragEvent: MouseEvent | null = null
    const flushDragFrame = (): void => {
      dragFrame = 0
      const event = dragEvent
      dragEvent = null
      if (!event) return
      const drag = dragRef.current
      if (!drag) return
      const dx = (event.clientX - drag.startX) / viewportRef.current.k
      const dy = (event.clientY - drag.startY) / viewportRef.current.k
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
      const movedIds = new Set(drag.initial.map((item) => item.id))
      const preview = nodesRef.current.map((node) => {
        const initial = drag.initial.find((item) => item.id === node.id)
        return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node
      })
      setDropTargetGroupId(findGroupDropTarget(movedIds, preview)?.id ?? null)
      setNodes(preview)
    }
    const onMouseMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (drag) {
        dragEvent = event
        if (!dragFrame) dragFrame = requestAnimationFrame(flushDragFrame)
        return
      }
      const current = connectingRef.current
      if (current) {
        setMouseWorld(screenToWorld(event.clientX, event.clientY))
        setConnectionTargetNodeId(
          findConnectionTarget(event.clientX, event.clientY, current).nodeId
        )
      }
    }
    const onMouseUp = (event: MouseEvent): void => {
      if (dragFrame) {
        cancelAnimationFrame(dragFrame)
        dragFrame = 0
        dragEvent = null
      }
      if (dragRef.current) finishNodeDrag(event.clientX, event.clientY)
      const current = connectingRef.current
      if (!current) return
      const drop = findConnectionTarget(event.clientX, event.clientY, current)
      if (drop.nodeId) {
        const normalized = normalizeConnection(
          current.nodeId,
          drop.nodeId,
          nodesRef.current,
          current.handleType
        )
        if (
          normalized &&
          !connectionsRef.current.some(
            (item) =>
              item.fromNodeId === normalized.fromNodeId && item.toNodeId === normalized.toNodeId
          )
        ) {
          pushHistory()
          setConnections((items) => [
            ...items,
            { id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...normalized }
          ])
        }
        setConnecting(null)
        setConnectionTargetNodeId(null)
      } else if (!drop.isNearNode) {
        setPendingConnectionCreate({
          connection: current,
          position: screenToWorld(event.clientX, event.clientY)
        })
        setConnecting(null)
      } else {
        setConnecting(null)
        setConnectionTargetNodeId(null)
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (dragFrame) cancelAnimationFrame(dragFrame)
    }
  }, [findConnectionTarget, finishNodeDrag, pushHistory, screenToWorld])

  const handleCanvasMouseDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      const world = screenToWorld(event.clientX, event.clientY)
      const next: SelectionBox = {
        startWorldX: world.x,
        startWorldY: world.y,
        currentWorldX: world.x,
        currentWorldY: world.y,
        additive: event.shiftKey,
        initialSelectedNodeIds: event.shiftKey ? [...selectedRef.current] : []
      }
      selectionRef.current = next
      setSelectionBox(next)
      if (!event.shiftKey) setSelectedNodeIds(new Set())
      setSelectedConnectionId(null)
      setContextMenu(null)
    },
    [screenToWorld, tool]
  )

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const current = selectionRef.current
      if (!current || event.buttons === 0) return
      const world = screenToWorld(event.clientX, event.clientY)
      const left = Math.min(current.startWorldX, world.x)
      const top = Math.min(current.startWorldY, world.y)
      const width = Math.abs(world.x - current.startWorldX)
      const height = Math.abs(world.y - current.startWorldY)
      const nextSelected = new Set(current.additive ? current.initialSelectedNodeIds : [])
      nodesRef.current.forEach((node) => {
        const intersects =
          left < node.position.x + node.width &&
          left + width > node.position.x &&
          top < node.position.y + node.height &&
          top + height > node.position.y
        if (intersects) nextSelected.add(node.id)
      })
      const next = { ...current, currentWorldX: world.x, currentWorldY: world.y }
      selectionRef.current = next
      setSelectionBox(next)
      setSelectedNodeIds(nextSelected)
    }
    const onPointerUp = (): void => {
      selectionRef.current = null
      setSelectionBox(null)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [screenToWorld])

  const deleteSelected = useCallback((): void => {
    if (selectedRef.current.size) {
      pushHistory()
      const ids = selectedRef.current
      setNodes((current) =>
        current
          .filter((node) => !ids.has(node.id))
          .map((node) =>
            node.metadata?.groupId && ids.has(node.metadata.groupId)
              ? { ...node, metadata: { ...node.metadata, groupId: undefined } }
              : node
          )
      )
      setConnections((current) =>
        current.filter(
          (connection) => !ids.has(connection.fromNodeId) && !ids.has(connection.toNodeId)
        )
      )
      setSelectedNodeIds(new Set())
      setSelectedConnectionId(null)
    } else if (selectedConnectionId) {
      pushHistory()
      setConnections((current) =>
        current.filter((connection) => connection.id !== selectedConnectionId)
      )
      setSelectedConnectionId(null)
    }
  }, [pushHistory, selectedConnectionId])

  const clearCanvas = useCallback((): void => {
    pushHistory()
    setNodes([])
    setConnections([])
    setSelectedNodeIds(new Set())
    setSelectedConnectionId(null)
    setClearConfirmOpen(false)
  }, [pushHistory])

  const createNode = useCallback(
    (type: string, position = canvasCenter()): void => {
      pushHistory()
      const node = createNodeData(type, position)
      setNodes((current) => [...current, node])
      setSelectedNodeIds(new Set([node.id]))
      setSelectedConnectionId(null)
      setNodeCreatePosition(null)
      setPanelNodeId(
        type === 'group' || getCanvasExtensionDefinition(type)?.hidePanel ? null : node.id
      )
    },
    [canvasCenter, pushHistory]
  )

  const insertAsset = useCallback(
    (asset: CanvasAsset): void => {
      const type = asset.kind === 'image' ? 'image' : asset.kind === 'video' ? 'video' : 'text'
      const node = createNodeData(type, canvasCenter(), {
        content: asset.content,
        status: 'success',
        sourceAssetId: asset.id
      })
      node.title = asset.title
      pushHistory()
      setNodes((current) => [...current, node])
      setSelectedNodeIds(new Set([node.id]))
      setAssetLibraryState({ open: false, tab: 'assets' })
    },
    [canvasCenter, pushHistory]
  )

  // 提示词库选中：优先填入当前打开面板节点的提示词；无面板时落成文本节点。
  const applyPromptFromLibrary = useCallback(
    (prompt: string): void => {
      const targetId = panelNodeId && selectedRef.current.has(panelNodeId) ? panelNodeId : null
      if (targetId) {
        setNodes((current) =>
          current.map((node) =>
            node.id === targetId
              ? { ...node, metadata: { ...node.metadata, prompt, composerContent: prompt } }
              : node
          )
        )
        return
      }
      insertAsset({
        id: `prompt-${Date.now()}`,
        kind: 'text',
        title: prompt.slice(0, 24) || '提示词',
        content: prompt,
        createdAt: Date.now()
      })
    },
    [insertAsset, panelNodeId]
  )

  const duplicateNode = useCallback(
    (nodeId: string): void => {
      const source = nodesRef.current.find((node) => node.id === nodeId)
      if (!source) return
      pushHistory()
      const copy = {
        ...source,
        id: `${source.type}-${Date.now()}-copy`,
        title: `${source.title} Copy`,
        position: { x: source.position.x + 36, y: source.position.y + 36 },
        metadata: source.metadata ? { ...source.metadata } : undefined
      }
      setNodes((current) => [...current, copy])
      setSelectedNodeIds(new Set([copy.id]))
      setContextMenu(null)
    },
    [pushHistory]
  )

  const updateFontSize = useCallback((nodeId: string, delta: number): void => {
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId) return node
        const fontSize = Math.min(32, Math.max(10, (Number(node.metadata?.fontSize) || 14) + delta))
        return { ...node, metadata: { ...node.metadata, fontSize } }
      })
    )
  }, [])

  const toggleFreeResize = useCallback((nodeId: string): void => {
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? { ...node, metadata: { ...node.metadata, freeResize: !node.metadata?.freeResize } }
          : node
      )
    )
  }, [])

  const downloadNode = useCallback((node: LocalNode): void => {
    const content = node.metadata?.content
    if (typeof content !== 'string' || !content) return
    void resolveDownloadBlob(content)
      .then((blob) =>
        downloadUrl(withImageExtension(node.title || `canvas-${node.type}`, imageFileExtension(blob.type)), blob)
      )
      .catch((reason) =>
        setSaveError(reason instanceof Error ? reason.message : '下载失败，请稍后重试')
      )
  }, [])

  function readBatchImages(node: LocalNode): string[] {
    return Array.isArray(node.metadata?.images)
      ? node.metadata.images.filter((value): value is string => typeof value === 'string')
      : []
  }

  // 设为主图：交换 metadata.content 与 batchIndex，主图即节点对外内容。
  const handleBatchSelect = useCallback(
    (nodeId: string, index: number): void => {
      pushHistory()
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== nodeId) return node
          const primary = readBatchImages(node)[index]
          if (typeof primary !== 'string') return node
          return { ...node, metadata: { ...node.metadata, content: primary, batchIndex: index } }
        })
      )
    },
    [pushHistory]
  )

  const handleBatchDownload = useCallback((node: LocalNode, index: number): void => {
    const images = readBatchImages(node)
    const image = images[index]
    if (!image) return
    // 单张结果不加序号后缀；多张时用序号区分
    const base = images.length > 1 ? `${node.title}-${index + 1}` : node.title
    void resolveDownloadBlob(image)
      .then((blob) => downloadUrl(withImageExtension(base, imageFileExtension(blob.type)), blob))
      .catch((reason) =>
        setSaveError(reason instanceof Error ? reason.message : '下载失败，请稍后重试')
      )
  }, [])

  const addDerivedImage = useCallback(
    async (source: LocalNode, dataUrl: string, title: string, index = 0): Promise<void> => {
      const result = createNodeData(
        'image',
        {
          x: source.position.x + source.width + 96,
          y: source.position.y + index * (source.height + 24) + source.height / 2
        },
        {
          content: dataUrl,
          status: 'success',
          prompt: source.metadata?.prompt,
          mimeType: 'image/png'
        }
      )
      result.title = title
      pushHistory()
      setNodes((current) => [...current, result])
      setConnections((current) => [
        ...current,
        {
          id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          fromNodeId: source.id,
          toNodeId: result.id
        }
      ])
      setSelectedNodeIds(new Set([result.id]))
      setPanelNodeId(null)
    },
    [pushHistory]
  )

  const cropImage = useCallback(
    async (
      source: LocalNode,
      crop: { x: number; y: number; width: number; height: number }
    ): Promise<void> => {
      if (!source.metadata?.content) return
      const dataUrl = await cropDataUrl(source.metadata.content, crop)
      await addDerivedImage(source, dataUrl, `${source.title} 裁剪`)
      setMediaDialog(null)
    },
    [addDerivedImage]
  )

  const splitImage = useCallback(
    async (source: LocalNode, params: { rows: number; columns: number }): Promise<void> => {
      if (!source.metadata?.content) return
      const pieces = await splitDataUrls(source.metadata.content, params)
      for (const [index, piece] of pieces.entries())
        await addDerivedImage(source, piece, `${source.title} ${index + 1}`, index)
      setMediaDialog(null)
    },
    [addDerivedImage]
  )

  const upscaleImage = useCallback(
    async (source: LocalNode, scale: number): Promise<void> => {
      if (!source.metadata?.content) return
      const dataUrl = await upscaleDataUrl(source.metadata.content, scale)
      await addDerivedImage(source, dataUrl, `${source.title} ${scale}x`)
      setMediaDialog(null)
    },
    [addDerivedImage]
  )

  // 对齐参考 maskEditImageNode：先挂载 loading 子节点，编辑成功后回填内容。
  const maskEditImage = useCallback(
    async (source: LocalNode, payload: { prompt: string; maskDataUrl: string; size?: string }): Promise<void> => {
      const content = source.metadata?.content
      if (!project || typeof content !== 'string' || !content) return
      const child = createNodeData(
        'image',
        { x: source.position.x + source.width + 96, y: source.position.y },
        { status: 'loading', prompt: payload.prompt }
      )
      child.title = `${source.title} 局部重绘`
      child.width = source.width
      child.height = source.height
      pushHistory()
      setNodes((current) => [...current, child])
      setConnections((current) => [
        ...current,
        {
          id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          fromNodeId: source.id,
          toNodeId: child.id
        }
      ])
      setSelectedNodeIds(new Set([child.id]))
      setPanelNodeId(null)
      setMediaDialog(null)
      setRunningNodeId(child.id)
      try {
        const result = await editCanvasImage(project.id, {
          prompt: payload.prompt,
          image: content,
          mask: payload.maskDataUrl,
          model: typeof source.metadata?.model === 'string' ? source.metadata.model : undefined,
          // 原图真实尺寸优先：蒙版重绘结果不应比原图降档
          size: payload.size ?? (typeof source.metadata?.size === 'string' ? source.metadata.size : undefined)
        })
        const image = proxyExternalImageUrl(result.images[0])
        if (!image) throw new Error('没有返回编辑结果')
        const dimensions = await readMediaSize(image, 'image')
        const size = fitNodeSize(dimensions.width, dimensions.height, source.width, source.height)
        setNodes((current) =>
          current.map((node) =>
            node.id === child.id
              ? {
                  ...node,
                  width: size.width,
                  height: size.height,
                  metadata: {
                    ...node.metadata,
                    content: image,
                    status: 'success',
                    naturalWidth: dimensions.width,
                    naturalHeight: dimensions.height,
                    mimeType: 'image/png'
                  }
                }
              : node
          )
        )
      } catch (reason) {
        setNodes((current) =>
          current.map((node) =>
            node.id === child.id
              ? {
                  ...node,
                  status: 'error',
                  errorDetails: reason instanceof Error ? reason.message : '局部重绘失败'
                }
              : node
          )
        )
      } finally {
        setRunningNodeId((current) => (current === child.id ? null : current))
      }
    },
    [project, pushHistory]
  )

  // 对齐参考"反推提示词"工具：视觉模型描述图片，结果落成文本节点并连线。
  const reversePromptForNode = useCallback(
    async (source: LocalNode): Promise<void> => {
      const content = source.metadata?.content
      if (!project || typeof content !== 'string' || !content) return
      const child = createNodeData(
        'text',
        { x: source.position.x + source.width + 96, y: source.position.y },
        { status: 'loading' }
      )
      child.title = '反推提示词'
      pushHistory()
      setNodes((current) => [...current, child])
      setConnections((current) => [
        ...current,
        {
          id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          fromNodeId: source.id,
          toNodeId: child.id
        }
      ])
      setSelectedNodeIds(new Set([child.id]))
      setPanelNodeId(null)
      setRunningNodeId(child.id)
      try {
        const result = await reverseCanvasPrompt(project.id, { image: content })
        setNodes((current) =>
          current.map((node) =>
            node.id === child.id
              ? { ...node, metadata: { ...node.metadata, content: result.text, status: 'success' } }
              : node
          )
        )
      } catch (reason) {
        setNodes((current) =>
          current.map((node) =>
            node.id === child.id
              ? {
                  ...node,
                  status: 'error',
                  errorDetails: reason instanceof Error ? reason.message : '反推提示词失败'
                }
              : node
          )
        )
      } finally {
        setRunningNodeId((current) => (current === child.id ? null : current))
      }
    },
    [project, pushHistory]
  )

  const copySelected = useCallback((): void => {
    const ids = selectedRef.current
    if (!ids.size) return
    clipboardRef.current = {
      nodes: cloneNodes(nodesRef.current.filter((node) => ids.has(node.id))),
      connections: cloneConnections(
        connectionsRef.current.filter(
          (connection) => ids.has(connection.fromNodeId) && ids.has(connection.toNodeId)
        )
      )
    }
  }, [])

  const pasteCopied = useCallback((): boolean => {
    const clipboard = clipboardRef.current
    if (!clipboard?.nodes.length) return false
    pushHistory()
    const bounds = nodeBounds(clipboard.nodes)
    const center = canvasCenter()
    const dx = center.x - (bounds.left + bounds.right) / 2
    const dy = center.y - (bounds.top + bounds.bottom) / 2
    const idMap = new Map<string, string>()
    const pasted = clipboard.nodes
      .map((node) => {
        const id = `${node.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        idMap.set(node.id, id)
        return {
          ...node,
          id,
          title: node.title.endsWith(' Copy') ? node.title : `${node.title} Copy`,
          position: { x: node.position.x + dx, y: node.position.y + dy },
          metadata: node.metadata ? { ...node.metadata } : undefined
        }
      })
      .map((node) =>
        node.metadata?.groupId
          ? { ...node, metadata: { ...node.metadata, groupId: idMap.get(node.metadata.groupId) } }
          : node
      )
    const pastedConnections = clipboard.connections.flatMap((connection) => {
      const fromNodeId = idMap.get(connection.fromNodeId)
      const toNodeId = idMap.get(connection.toNodeId)
      return fromNodeId && toNodeId
        ? [
            {
              ...connection,
              id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              fromNodeId,
              toNodeId
            }
          ]
        : []
    })
    setNodes((current) => [...current, ...pasted])
    setConnections((current) => [...current, ...pastedConnections])
    setSelectedNodeIds(new Set(pasted.map((node) => node.id)))
    return true
  }, [canvasCenter, pushHistory])

  // 对齐参考项目：内部剪贴板为空时读取系统剪贴板（图片→图片节点，文本→文本节点）。
  const pasteFromSystemClipboard = useCallback(async (): Promise<void> => {
    try {
      const items =
        typeof navigator.clipboard?.read === 'function' ? await navigator.clipboard.read() : []
      if (!items.length) return
      const center = canvasCenter()
      const created: LocalNode[] = []
      for (const [index, item] of items.entries()) {
        const imageType = item.types.find((type) => type.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          const dataUrl = await fileAsDataUrl(
            new File([blob], 'clipboard-image', { type: imageType })
          )
          const dimensions = await readMediaSize(dataUrl, 'image')
          const ratio = Math.min(
            1,
            640 / Math.max(1, dimensions.width),
            640 / Math.max(1, dimensions.height)
          )
          const node = createNodeData(
            'image',
            { x: center.x + index * 40, y: center.y + index * 40 },
            {
              content: dataUrl,
              status: 'success',
              naturalWidth: dimensions.width,
              naturalHeight: dimensions.height,
              mimeType: imageType
            }
          )
          node.title = '剪贴板图片'
          node.width = Math.max(220, dimensions.width * ratio)
          node.height = Math.max(160, dimensions.height * ratio)
          created.push(node)
          continue
        }
        if (item.types.includes('text/plain')) {
          const text = (await (await item.getType('text/plain')).text()).trim()
          if (!text) continue
          const node = createNodeData(
            'text',
            { x: center.x + index * 40, y: center.y + index * 40 },
            { content: text, status: 'success' }
          )
          node.title = text.slice(0, 32) || '剪贴板文本'
          created.push(node)
        }
      }
      if (!created.length) return
      pushHistory()
      setNodes((current) => [...current, ...created])
      setSelectedNodeIds(new Set(created.map((node) => node.id)))
    } catch {
      // 剪贴板权限不可用或非安全上下文时静默忽略。
    }
  }, [canvasCenter, pushHistory])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (!active) return
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof Element && target.closest('[data-canvas-no-zoom]'))
      )
        return
      const key = event.key.toLowerCase()
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (modifier && key === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (modifier && key === 'a') {
        event.preventDefault()
        setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)))
        return
      }
      if (modifier && key === 'c') {
        // 有文字选区时放行系统复制。
        if ((window.getSelection()?.toString().length ?? 0) > 0) return
        event.preventDefault()
        copySelected()
        return
      }
      if (modifier && key === 'v') {
        event.preventDefault()
        if (pasteCopied()) return
        void pasteFromSystemClipboard()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelected()
        return
      }
      if (event.key === 'Escape') {
        setSelectedNodeIds(new Set())
        setSelectedConnectionId(null)
        setContextMenu(null)
        setConnecting(null)
        setPendingConnectionCreate(null)
        setNodeCreatePosition(null)
        setPanelNodeId(null)
        setMediaDialog(null)
        selectionRef.current = null
        setSelectionBox(null)
      }
    },
    [active, copySelected, deleteSelected, pasteCopied, pasteFromSystemClipboard, redo, undo]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handleFileInput = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = [...(event.target.files ?? [])]
      event.target.value = ''
      if (!files.length) return
      const center = canvasCenter()
      for (const [index, file] of files.entries())
        await insertFile(file, { x: center.x + index * 40, y: center.y + index * 40 })
    },
    [canvasCenter]
  )

  const insertFile = useCallback(
    async (file: File, position: Position): Promise<void> => {
      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')
      // 原图 data URL 会整段进入画布保存载荷：一张 12MB 照片就约 16M 字符，
      // 两张即顶穿 /graph 的 32MB 上限，因此大图先按最长边重编码；
      // 重编码后立即入库为服务端资产——节点只存短路径，拖动/保存才不卡
      const compressed = isImage
        ? await compressImageDataUrl(await fileAsDataUrl(file))
        : await fileAsDataUrl(file)
      const uploaded = isImage && project ? await uploadCanvasAsset(compressed, project.id) : null
      const dataUrl = uploaded ?? compressed
      const type = isImage ? 'image' : isVideo ? 'video' : 'audio'
      const dimensions =
        isImage || isVideo
          ? await readMediaSize(dataUrl, isImage ? 'image' : 'video')
          : { width: 340, height: 120 }
      const maxWidth = type === 'video' ? 420 : 640
      const maxHeight = type === 'audio' ? 120 : type === 'video' ? 420 : 640
      const ratio = Math.min(1, maxWidth / dimensions.width, maxHeight / dimensions.height)
      pushHistory()
      const node = createNodeData(type, position, {
        content: dataUrl,
        status: 'success',
        naturalWidth: dimensions.width,
        naturalHeight: dimensions.height,
        mimeType: file.type,
        bytes: file.size
      })
      node.title = file.name
      node.width = Math.max(type === 'audio' ? 340 : 220, dimensions.width * ratio)
      node.height = Math.max(type === 'audio' ? 120 : 160, dimensions.height * ratio)
      setNodes((current) => [...current, node])
      setSelectedNodeIds(new Set([node.id]))
    },
    [project, pushHistory]
  )

  const replaceMedia = useCallback(
    async (nodeId: string, file?: File): Promise<void> => {
      if (!file) return
      const node = nodesRef.current.find((item) => item.id === nodeId)
      if (!node) return
      const isImage = file.type.startsWith('image/')
      const compressed = isImage
        ? await compressImageDataUrl(await fileAsDataUrl(file))
        : await fileAsDataUrl(file)
      const uploaded = isImage && project ? await uploadCanvasAsset(compressed, project.id) : null
      const dataUrl = uploaded ?? compressed
      const mediaType = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : 'audio'
      const dimensions =
        mediaType === 'audio'
          ? { width: 340, height: 120 }
          : await readMediaSize(dataUrl, mediaType === 'image' ? 'image' : 'video')
      pushHistory()
      setNodes((current) =>
        current.map((item) =>
          item.id === nodeId
            ? {
                ...item,
                type: mediaType,
                title: file.name,
                width: mediaType === 'audio' ? 340 : item.width,
                height: mediaType === 'audio' ? 120 : item.height,
                metadata: {
                  ...item.metadata,
                  content: dataUrl,
                  status: 'success',
                  naturalWidth: dimensions.width,
                  naturalHeight: dimensions.height,
                  mimeType: file.type,
                  bytes: file.size
                }
              }
            : item
        )
      )
      setReplaceMediaNodeId(null)
    },
    [project, pushHistory]
  )

  const handleDropFiles = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const position = screenToWorld(event.clientX, event.clientY)
      for (const [index, file] of [...event.dataTransfer.files].entries())
        void insertFile(file, { x: position.x + index * 40, y: position.y + index * 40 })
    },
    [insertFile, screenToWorld]
  )

  const handleNodeContentChange = useCallback((id: string, content: string): void => {
    setNodes((current) =>
      current.map((node) =>
        node.id === id
          ? { ...node, metadata: { ...node.metadata, content, status: 'success' } }
          : node
      )
    )
  }, [])
  const handleExtensionMetadataChange = useCallback(
    (id: string, patch: Record<string, unknown>): void => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, metadata: { ...node.metadata, ...patch } } : node
        )
      )
    },
    []
  )
  const handleNodeTitleChange = useCallback(
    (id: string, title: string): void => {
      pushHistory()
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, title } : node)))
    },
    [pushHistory]
  )
  const handleResize = useCallback(
    (id: string, width: number, height: number, position?: Position): void => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, width, height, position: position ?? node.position } : node
        )
      )
    },
    []
  )

  const connectStart = useCallback(
    (event: React.MouseEvent, nodeId: string, handleType: 'source' | 'target'): void => {
      event.preventDefault()
      event.stopPropagation()
      pushHistory()
      setConnecting({ nodeId, handleType })
      setConnectionTargetNodeId(null)
      setMouseWorld(screenToWorld(event.clientX, event.clientY))
    },
    [pushHistory, screenToWorld]
  )

  const createConnectedNode = useCallback(
    (type: string): void => {
      if (!pendingConnectionCreate) return
      const node = createNodeData(type, pendingConnectionCreate.position)
      const normalized = normalizeConnection(
        pendingConnectionCreate.connection.nodeId,
        node.id,
        [...nodesRef.current, node],
        pendingConnectionCreate.connection.handleType
      )
      if (!normalized) return
      pushHistory()
      setNodes((current) => [...current, node])
      setConnections((current) => [...current, { id: `conn-${Date.now()}`, ...normalized }])
      setSelectedNodeIds(new Set([node.id]))
      setPendingConnectionCreate(null)
    },
    [pendingConnectionCreate, pushHistory]
  )

  const onCanvasDoubleClick = useCallback(
    (event: React.MouseEvent): void => {
      setNodeCreatePosition(screenToWorld(event.clientX, event.clientY))
    },
    [screenToWorld]
  )

  const changeZoom = useCallback(
    (scale: number): void => {
      const nextScale = Math.min(5, Math.max(0.05, scale))
      setViewport((current) => ({
        x: canvasSize.width / 2 - ((canvasSize.width / 2 - current.x) / current.k) * nextScale,
        y: canvasSize.height / 2 - ((canvasSize.height / 2 - current.y) / current.k) * nextScale,
        k: nextScale
      }))
    },
    [canvasSize.height, canvasSize.width]
  )

  const resetViewport = useCallback((): void => {
    setViewport({ x: canvasSize.width / 2, y: canvasSize.height / 2, k: 1 })
  }, [canvasSize.height, canvasSize.width])

  // 对齐参考 focusNode：450ms easeOutCubic 动画把节点居中，缩放夹在 0.05–1。
  const animateViewportTo = useCallback((target: ViewportTransform): void => {
    if (viewportAnimationRef.current !== null) cancelAnimationFrame(viewportAnimationRef.current)
    const start = { ...viewportRef.current }
    const startTime = performance.now()
    const duration = 450
    const step = (time: number): void => {
      const progress = Math.min(1, (time - startTime) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      setViewport({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        k: start.k + (target.k - start.k) * eased
      })
      viewportAnimationRef.current = progress < 1 ? requestAnimationFrame(step) : null
    }
    viewportAnimationRef.current = requestAnimationFrame(step)
  }, [])

  const focusNode = useCallback(
    (nodeId: string): void => {
      const node = nodesRef.current.find((item) => item.id === nodeId)
      if (!node || !canvasSize.width || !canvasSize.height) return
      const scale = Math.max(
        0.05,
        Math.min(1, (canvasSize.width * 0.6) / node.width, (canvasSize.height * 0.6) / node.height)
      )
      animateViewportTo({
        x: canvasSize.width / 2 - (node.position.x + node.width / 2) * scale,
        y: canvasSize.height / 2 - (node.position.y + node.height / 2) * scale,
        k: scale
      })
    },
    [animateViewportTo, canvasSize.height, canvasSize.width]
  )

  const exportProject = useCallback((): void => {
    if (!project) return
    const payload = {
      ...project,
      nodes,
      connections,
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.k },
      settings
    }
    downloadJson(`${project.title || 'canvas'}.json`, payload)
  }, [connections, nodes, project, settings, viewport])

  const exportSelected = useCallback((): void => {
    if (!project || !selectedNodeIds.size) return
    const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id))
    const selectedEdges = connections.filter(
      (connection) =>
        selectedNodeIds.has(connection.fromNodeId) && selectedNodeIds.has(connection.toNodeId)
    )
    const payload = {
      title: `${project.title} - 选中内容`,
      description: project.description,
      nodes: selectedNodes.map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        x: node.position.x,
        y: node.position.y,
        width: node.width,
        height: node.height,
        metadata: node.metadata
      })),
      connections: selectedEdges,
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.k },
      settings
    }
    downloadJson(`${project.title || 'canvas'}-selection.json`, payload)
  }, [connections, nodes, project, selectedNodeIds, settings, viewport])

  const downloadSelectedBatch = useCallback(async (): Promise<void> => {
    if (!project || !selectedNodeIds.size || batchDownloading) return
    setBatchDownloading(true)
    setSaveError(null)
    const files: Array<{ filename: string; data: Uint8Array }> = []
    const failures: string[] = []
    const usedNames = new Set<string>()
    try {
      const { items, emptyNodeTitles } = collectBatchDownloadItemsWithEmptyNodes(
        nodes.filter((node) => selectedNodeIds.has(node.id))
      )
      for (const item of items) {
        try {
          const blob =
            item.kind === 'media'
              ? await resolveDownloadBlob(item.content)
              : new Blob([item.content], {
                  type: item.extension === '.json' ? 'application/json' : 'text/plain;charset=utf-8'
                })
          const extension =
            item.kind === 'media' ? mediaFileExtension(blob.type, item.mediaType) : item.extension
          const filename = uniqueBatchFilename(`${item.baseName}${extension}`, usedNames)
          files.push({ filename, data: new Uint8Array(await blob.arrayBuffer()) })
        } catch (reason) {
          failures.push(
            `${item.baseName}: ${reason instanceof Error ? reason.message : '读取失败'}`
          )
        }
      }
      if (!files.length) {
        const details = [
          ...failures,
          ...(emptyNodeTitles.length ? [`无有效内容节点：${emptyNodeTitles.join('、')}`] : [])
        ]
        setSaveError(
          details.length ? `没有可下载的文件：${details.join('；')}` : '选中的节点没有可下载内容'
        )
        return
      }
      const archive = buildZipBlob(files)
      downloadUrl(`${project.title || 'canvas'}-selected.zip`, archive)
      const emptySummary = emptyNodeTitles.length
        ? `，${emptyNodeTitles.length} 个节点无有效内容：${emptyNodeTitles.join('、')}`
        : ''
      const failureSummary = failures.length
        ? `，${failures.length} 个文件失败：${failures.join('；')}`
        : ''
      setSaveError(`已打包 ${files.length} 个文件${failureSummary}${emptySummary}`)
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : '批量下载失败，请稍后重试')
    } finally {
      setBatchDownloading(false)
    }
  }, [batchDownloading, nodes, project, selectedNodeIds])

  const duplicateProject = useCallback(async (): Promise<void> => {
    if (!project) return
    const created = await createCanvasProject({
      title: `${project.title} 副本`,
      description: project.description
    })
    await saveCanvasGraphBody(
      created.id,
      JSON.stringify(graphPayload(cloneNodes(nodes), cloneConnections(connections), viewport, settings))
    )
    setProjects((current) => [created, ...current])
    await loadProject(created.id)
  }, [connections, loadProject, nodes, project, settings, viewport])

  const importProject = useCallback(
    async (file?: File): Promise<void> => {
      if (!file) return
      try {
        const raw = JSON.parse(await file.text()) as Partial<CanvasProject> & {
          nodes?: Array<Partial<LocalNode> & { x?: number; y?: number }>
        }
        const created = await createCanvasProject({
          title: raw.title || '导入画布',
          description: raw.description
        })
        const importedNodes: LocalNode[] = (raw.nodes ?? []).map((node, index) => {
          const candidate = (node as { position?: { x?: unknown; y?: unknown } }).position
          return {
            id: typeof node.id === 'string' ? node.id : `imported-${Date.now()}-${index}`,
            type: node.type ?? 'text',
            title: node.title ?? '未命名节点',
            position: {
              x: typeof candidate?.x === 'number' ? candidate.x : (node.x ?? 80),
              y: typeof candidate?.y === 'number' ? candidate.y : (node.y ?? 80)
            },
            width: node.width ?? 340,
            height: node.height ?? 240,
            metadata: node.metadata
          }
        })
        const importedConnections = (raw.connections ?? []).map((connection) => ({
          id: connection.id,
          fromNodeId: connection.fromNodeId,
          toNodeId: connection.toNodeId
        }))
        const importedViewport = raw.viewport
          ? { x: raw.viewport.x ?? 0, y: raw.viewport.y ?? 0, k: raw.viewport.zoom ?? 1 }
          : DEFAULT_VIEWPORT
        const importedSettings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
        pushHistory()
        setProjects((current) => [created, ...current])
        setProject(created)
        setNodes(importedNodes)
        setConnections(importedConnections)
        setViewport(importedViewport)
        setSettings(importedSettings)
        setSelectedNodeIds(new Set())
      } catch {
        setError('画布 JSON 导入失败')
      }
    },
    [pushHistory]
  )

  const createProject = useCallback(async (): Promise<void> => {
    const created = await createCanvasProject({ title: `画布 ${projects.length + 1}` })
    setProjects((current) => [created, ...current])
    restoreProject(created)
  }, [projects.length, restoreProject])

  const deleteProject = useCallback(async (): Promise<void> => {
    if (!project) return
    await deleteCanvasProject(project.id)
    const remaining = projects.filter((item) => item.id !== project.id)
    setProjects(remaining)
    if (remaining[0]) await loadProject(remaining[0].id)
    else {
      const created = await createCanvasProject({ title: '未命名画布' })
      setProjects([created])
      restoreProject(created)
    }
  }, [loadProject, project, projects, restoreProject])

  const renameProject = useCallback(
    async (title: string): Promise<void> => {
      if (!project) return
      const renamed = await renameCanvasProject(project.id, title)
      setProject((current) =>
        current ? { ...current, title: renamed.title, updatedAt: renamed.updatedAt } : current
      )
      setProjects((current) =>
        current.map((item) =>
          item.id === project.id
            ? { ...item, title: renamed.title, updatedAt: renamed.updatedAt }
            : item
        )
      )
    },
    [project]
  )

  const updateSettings = useCallback((patch: Partial<CanvasProjectSettings>): void => {
    setSettings((current) => ({ ...current, ...patch }))
  }, [])

  const updateNodePrompt = useCallback((nodeId: string, prompt: string): void => {
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? { ...node, metadata: { ...node.metadata, prompt, composerContent: prompt } }
          : node
      )
    )
  }, [])

  const updateNodeMode = useCallback((nodeId: string, mode: string): void => {
    const generationMode =
      mode === 'image' || mode === 'video' || mode === 'audio' || mode === 'text' ? mode : 'text'
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId ? { ...node, metadata: { ...node.metadata, generationMode } } : node
      )
    )
  }, [])

  const stopGeneration = useCallback((nodeId: string): void => {
    generationControllersRef.current.get(nodeId)?.abort()
    generationControllersRef.current.delete(nodeId)
    setRunningNodeId((current) => (current === nodeId ? null : current))
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? { ...node, metadata: { ...node.metadata, status: 'idle', errorDetails: undefined } }
          : node
      )
    )
  }, [])

  const generateNode = useCallback(
    async (nodeId: string, prompt: string, mode: string): Promise<void> => {
      const source = nodesRef.current.find((node) => node.id === nodeId)
      if (!source || !project) return
      const generationMode =
        mode === 'image' || mode === 'video' || mode === 'audio' || mode === 'text' ? mode : 'text'

      // 资源上下文统一按「直接上游 / 配置节点转发 / @[node:id] 精确引用」构建，
      // 避免把视频、音频和图片混成一段不可消费的字符串。
      const storedPrompt = prompt.trim()
      const builtContext = buildCanvasGenerationContext(
        nodeId,
        nodesRef.current,
        connectionsRef.current,
        storedPrompt
      )
      const effectivePrompt = builtContext.prompt
      if (!effectivePrompt) return

      generationControllersRef.current.get(nodeId)?.abort()
      const controller = new AbortController()
      generationControllersRef.current.set(nodeId, controller)
      setRunningNodeId(nodeId)
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                metadata: {
                  ...node.metadata,
                  prompt: storedPrompt,
                  composerContent: storedPrompt,
                  generationMode,
                  status: 'loading',
                  errorDetails: undefined
                }
              }
            : node
        )
      )

      try {
        const meta = source.metadata ?? {}
        const sizeValue =
          typeof meta.size === 'string' && meta.size !== 'auto' ? meta.size : undefined
        const requestContext =
          generationMode === 'image'
            ? withHydratedImageReferences(
                builtContext.context,
                await Promise.all(
                  builtContext.context.images.map((reference) =>
                    imageContentAsDataUrl(reference.dataUrl || reference.url || '')
                  )
                )
              )
            : builtContext.context
        const imageReferences = requestContext.images
          .map((reference) => reference.dataUrl)
          .filter((value): value is string => Boolean(value?.startsWith('data:image/')))
        const result =
          generationMode === 'image'
            ? await generateCanvasImage(
                project.id,
                {
                  nodeId,
                  prompt: effectivePrompt,
                  context: builtContext.contextText,
                  resourceContext: requestContext,
                  references: imageReferences,
                  model: typeof meta.model === 'string' ? meta.model : undefined,
                  providerId: typeof meta.providerId === 'string' ? meta.providerId : undefined,
                  size: sizeValue,
                  quality: typeof meta.quality === 'string' ? meta.quality : undefined,
                  background: typeof meta.background === 'string' ? meta.background : undefined,
                  count:
                    Number(meta.count) > 0 ? Math.min(4, Math.floor(Number(meta.count))) : undefined
                },
                { signal: controller.signal }
              )
            : generationMode === 'audio' || generationMode === 'video'
              ? await generateCanvasMedia(
                  project.id,
                  {
                    mode: generationMode,
                    prompt: effectivePrompt,
                    context: builtContext.contextText,
                    resourceContext: requestContext,
                    model: typeof meta.model === 'string' ? meta.model : undefined,
                    providerId: typeof meta.providerId === 'string' ? meta.providerId : undefined,
                    voice: typeof meta.voice === 'string' ? meta.voice : undefined,
                    format: typeof meta.format === 'string' ? meta.format : undefined,
                    speed: Number(meta.speed) > 0 ? Number(meta.speed) : undefined,
                    size: generationMode === 'video' ? sizeValue : undefined,
                    seconds:
                      generationMode === 'video' && Number(meta.seconds) > 0
                        ? Number(meta.seconds)
                        : undefined,
                    generateAudio:
                      typeof meta.generateAudio === 'boolean' ? meta.generateAudio : undefined,
                    watermark: typeof meta.watermark === 'boolean' ? meta.watermark : undefined
                  },
                  { signal: controller.signal }
                )
              : await generateCanvasText(
                  project.id,
                  {
                    nodeId,
                    prompt: effectivePrompt,
                    mode: generationMode,
                    context: builtContext.contextText,
                    resourceContext: requestContext
                  },
                  { signal: controller.signal }
                )
        if (controller.signal.aborted) return
        const images =
          generationMode === 'image' && 'images' in result && Array.isArray(result.images)
            ? result.images
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .map(proxyExternalImageUrl)
            : []
        if (images.length > 0) {
          // 对齐参考批量堆叠：多图结果落进单个节点的 images 批次，主图 + 可展开网格。
          pushHistory()
          const firstDimensions = await readMediaSize(images[0], 'image')
          const size = fitNodeSize(firstDimensions.width, firstDimensions.height, 420, 420)
          const batchNode = createNodeData(
            'image',
            { x: source.position.x + source.width + 96, y: source.position.y },
            {
              content: images[0],
              status: 'success',
              prompt,
              generationMode,
              images,
              batchIndex: 0,
              naturalWidth: firstDimensions.width,
              naturalHeight: firstDimensions.height,
              mimeType: 'image/png'
            }
          )
          batchNode.title = `${source.title} ${images.length} 张`
          batchNode.width = size.width
          batchNode.height = size.height
          setNodes((current) => [...current, batchNode])
          setConnections((current) => [
            ...current,
            {
              id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              fromNodeId: nodeId,
              toNodeId: batchNode.id
            }
          ])
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    metadata: {
                      ...node.metadata,
                      status: 'success',
                      prompt,
                      composerContent: prompt,
                      generationMode
                    }
                  }
                : node
            )
          )
          setSelectedNodeIds(new Set([batchNode.id]))
          setPanelNodeId(batchNode.id)
          return
        }
        if (
          (generationMode === 'audio' || generationMode === 'video') &&
          'outputs' in result &&
          Array.isArray(result.outputs) &&
          result.outputs.length > 0
        ) {
          for (const [index, output] of result.outputs.entries()) {
            const resultNode = createNodeData(
              generationMode,
              {
                x: source.position.x + source.width + 96,
                y: source.position.y + index * (source.height + 24) + source.height / 2
              },
              {
                content: output.url,
                status: 'success',
                prompt,
                generationMode,
                mimeType: output.mimeType
              }
            )
            resultNode.title = `${source.title} ${index + 1}`
            setNodes((current) => [...current, resultNode])
            setConnections((current) => [
              ...current,
              {
                id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                fromNodeId: nodeId,
                toNodeId: resultNode.id
              }
            ])
          }
          setSelectedNodeIds(new Set())
          return
        }
        const text = 'text' in result && typeof result.text === 'string' ? result.text.trim() : ''
        const sourceHasContent =
          typeof source.metadata?.content === 'string' && source.metadata.content.trim().length > 0
        if (source.type === 'text' && !sourceHasContent) {
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    metadata: {
                      ...node.metadata,
                      content: text,
                      status: 'success',
                      prompt,
                      composerContent: prompt,
                      generationMode
                    }
                  }
                : node
            )
          )
        } else {
          pushHistory()
          const resultNode = createNodeData(
            'text',
            {
              x: source.position.x + source.width + 96 + 170,
              y: source.position.y + source.height / 2
            },
            { content: text, prompt, composerContent: prompt, generationMode, status: 'success' }
          )
          resultNode.title = text.slice(0, 32) || 'Agent 结果'
          setNodes((current) => [...current, resultNode])
          setConnections((current) => [
            ...current,
            {
              id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              fromNodeId: nodeId,
              toNodeId: resultNode.id
            }
          ])
          setSelectedNodeIds(new Set([resultNode.id]))
          setPanelNodeId(resultNode.id)
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          const errorDetails = reason instanceof Error ? reason.message : '画布 Agent 生成失败'
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId
                ? { ...node, metadata: { ...node.metadata, status: 'error', errorDetails } }
                : node
            )
          )
        }
      } finally {
        generationControllersRef.current.delete(nodeId)
        setRunningNodeId((current) => (current === nodeId ? null : current))
      }
    },
    [addDerivedImage, project, pushHistory, resolvePromptReferences]
  )

  const generateImageFromText = useCallback(
    (node: LocalNode): void => {
      const prompt = String(node.metadata?.content ?? node.metadata?.prompt ?? '').trim()
      if (!prompt) {
        setPanelNodeId(node.id)
        return
      }
      void generateNode(node.id, prompt, 'image')
    },
    [generateNode]
  )

  if (loading)
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        正在加载画布…
      </div>
    )
  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-subtle">
        <p>{error}</p>
        <Button onClick={() => void refresh()}>重试</Button>
      </div>
    )
  if (!project) return <div className="p-6 text-sm text-subtle">没有可用画布。</div>

  return (
    <div
      className="flex h-full min-h-0 overflow-hidden"
      style={{ background: theme.canvas.background, color: theme.node.text }}
    >
      {sidePanelOpen && (
        <aside
          className="flex w-[280px] shrink-0 flex-col border-r p-4"
          style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
        >
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p
                className="text-[11px] font-semibold tracking-[0.18em] uppercase"
                style={{ color: theme.node.muted }}
              >
                画布项目
              </p>
              <p className="mt-1 text-xs opacity-50">{projects.length} 个项目</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title="新建画布"
              onClick={() => void createProject()}
            >
              <FilePlus2 className="size-4" />
            </Button>
          </div>
          <div className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
            {projects.map((item) => (
              <button
                key={item.id}
                type="button"
                className="w-full rounded-xl border px-3 py-2 text-left transition"
                style={{
                  background: item.id === project.id ? theme.toolbar.activeBg : 'transparent',
                  borderColor: item.id === project.id ? theme.node.stroke : 'transparent',
                  color: theme.node.text
                }}
                onClick={() => void loadProject(item.id)}
              >
                <span className="block truncate text-sm font-medium">{item.title}</span>
                <span className="mt-1 block text-[11px] opacity-50">
                  {new Date(item.updatedAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 border-t pt-3" style={{ borderColor: theme.toolbar.border }}>
            <p
              className="mb-2 text-[11px] font-semibold tracking-[0.18em] uppercase"
              style={{ color: theme.node.muted }}
            >
              当前节点
            </p>
            <div className="thin-scrollbar max-h-48 space-y-1 overflow-y-auto">
              {nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => {
                    setSelectedNodeIds(new Set([node.id]))
                    focusNode(node.id)
                  }}
                >
                  <FolderOpen className="size-3.5 shrink-0 opacity-50" />
                  <span className="truncate">{node.title}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>
      )}
      <section className="relative min-w-0 flex-1 overflow-hidden">
        <CanvasTopBar
          theme={theme}
          title={project.title}
          canUndo={historyState.canUndo}
          canRedo={historyState.canRedo}
          sidePanelOpen={sidePanelOpen}
          onToggleSidePanel={() => setSidePanelOpen((value) => !value)}
          onBack={() => onClose?.()}
          onCreateProject={() => void createProject()}
          onDeleteProject={() => void deleteProject()}
          onDuplicateProject={() => void duplicateProject()}
          onExportProject={exportProject}
          onExportSelected={selectedNodeIds.size ? exportSelected : undefined}
          onImportFiles={() => fileInputRef.current?.click()}
          onUndo={undo}
          onRedo={redo}
          onRenameProject={(title) => void renameProject(title)}
          onToggleAgent={() => setAgentPanelOpen((value) => !value)}
          agentOpen={agentPanelOpen}
        />
        {saveError && (
          <div className="pointer-events-auto absolute top-16 left-1/2 z-50 w-[min(680px,90%)] -translate-x-1/2">
            <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-600 shadow-lg backdrop-blur dark:text-red-300">
              <span className="flex-1 leading-relaxed">{saveError}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setSaveError(null)}
              >
                关闭
              </Button>
            </div>
          </div>
        )}
        <InfiniteCanvas
          containerRef={canvasRef}
          viewport={viewport}
          tool={tool}
          theme={theme}
          backgroundMode={settings.backgroundMode}
          onViewportChange={setViewport}
          hotkeysEnabled={active}
          onCanvasMouseDown={handleCanvasMouseDown}
          onCanvasDeselect={() => {
            setSelectedNodeIds(new Set())
            setSelectedConnectionId(null)
          }}
          onCanvasDoubleClick={onCanvasDoubleClick}
          onContextMenu={(event) => {
            event.preventDefault()
            if (!(event.target as HTMLElement).closest('[data-node-id]')) setContextMenu(null)
          }}
          onDropFiles={handleDropFiles}
        >
          <svg
            className="pointer-events-none absolute top-0 left-0 h-[10000px] w-[10000px] overflow-visible"
            style={{ zIndex: 0 }}
          >
            {connections.map((connection) => {
              const from = nodeMap.get(connection.fromNodeId)
              const to = nodeMap.get(connection.toNodeId)
              if (!from || !to) return null
              return (
                <ConnectionPath
                  key={connection.id}
                  connection={connection}
                  from={from}
                  to={to}
                  active={selectedConnectionId === connection.id}
                  onSelect={() => {
                    setSelectedConnectionId(connection.id)
                    setSelectedNodeIds(new Set())
                  }}
                  onContextMenu={(event) => {
                    setSelectedConnectionId(connection.id)
                    setSelectedNodeIds(new Set())
                    setContextMenu({
                      type: 'connection',
                      x: event.clientX,
                      y: event.clientY,
                      connectionId: connection.id
                    })
                  }}
                />
              )
            })}
            {connecting && (
              <ActiveConnectionPath
                node={nodeMap.get(connecting.nodeId)}
                handle={connecting}
                mouseWorld={mouseWorld}
                target={connectionTargetNodeId ? nodeMap.get(connectionTargetNodeId) : undefined}
              />
            )}
          </svg>
          {visibleNodes.map((node) => (
            <CanvasNode
              key={node.id}
              data={node}
              theme={theme}
              scale={viewport.k}
              isSelected={selectedNodeIds.has(node.id)}
              isRelated={false}
              isFocusRelated={selectedNodeIds.has(node.id)}
              isConnectionTarget={connectionTargetNodeId === node.id}
              isConnecting={Boolean(connecting)}
              showPanel={panelNodeId === node.id && selectedNodeIds.has(node.id)}
              showImageInfo={settings.showImageInfo}
              extensionInput={connections
                .filter((connection) => connection.toNodeId === node.id)
                .map((connection) => nodeMap.get(connection.fromNodeId)?.metadata?.content)
                .filter((value): value is string => typeof value === 'string')
                .join('\n')}
              groupChildCount={groupChildCount.get(node.id) ?? 0}
              isGroupDropTarget={dropTargetGroupId === node.id}
              renderPanel={(panelNode) => (
                <CanvasNodePanel
                  node={panelNode}
                  theme={theme}
                  isRunning={runningNodeId === panelNode.id}
                  onPromptChange={updateNodePrompt}
                  onModeChange={updateNodeMode}
                  onGenerate={(id, prompt, mode) => void generateNode(id, prompt, mode)}
                  onStop={stopGeneration}
                  onClose={() => setPanelNodeId(null)}
                  onConfigChange={handleExtensionMetadataChange}
                  upstreamSummary={upstreamSummaries.get(panelNode.id)}
                  mentionReferences={upstreamMentions.get(panelNode.id)}
                  orderedReferences={orderedReferencesByNode.get(panelNode.id) ?? []}
                  onOpenPromptLibrary={() => setAssetLibraryState({ open: true, tab: 'prompts' })}
                />
              )}
              onMouseDown={handleNodeMouseDown}
              onSelectCapture={handleNodeSelectCapture}
              onHoverStart={setHoveredNodeId}
              onHoverEnd={(id) => setHoveredNodeId((current) => (current === id ? null : id))}
              onConnectStart={connectStart}
              onResizeStart={pushHistory}
              onResize={handleResize}
              onResizeEnd={() => undefined}
              onContentChange={handleNodeContentChange}
              onExtensionMetadataChange={handleExtensionMetadataChange}
              onTitleChange={handleNodeTitleChange}
              onGenerateImage={generateImageFromText}
              onViewImage={(item) => {
                if (item.metadata?.content)
                  window.open(item.metadata.content, '_blank', 'noopener,noreferrer')
              }}
              onDownloadImage={downloadNode}
              onBatchSelect={handleBatchSelect}
              onBatchDownload={handleBatchDownload}
              onContextMenu={(event, nodeId) => {
                event.preventDefault()
                event.stopPropagation()
                setSelectedNodeIds(new Set([nodeId]))
                setPanelNodeId(nodeId)
                setContextMenu({ type: 'node', x: event.clientX, y: event.clientY, nodeId })
              }}
            />
          ))}
          {selectionBox && (
            <svg
              className="pointer-events-none absolute z-[100] overflow-visible"
              style={{
                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY)
              }}
            >
              <rect
                width="100%"
                height="100%"
                fill={theme.canvas.selectionFill}
                stroke={theme.canvas.selectionStroke}
                strokeOpacity={0.55}
                strokeWidth={1 / viewport.k}
                strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`}
              />
            </svg>
          )}
          {pendingConnectionCreate && (
            <ConnectionCreateMenu
              theme={theme}
              pending={pendingConnectionCreate}
              onCreate={createConnectedNode}
              onClose={() => setPendingConnectionCreate(null)}
            />
          )}
          {nodeCreatePosition && (
            <NodeCreateMenu
              theme={theme}
              position={nodeCreatePosition}
              onCreate={(type) => createNode(type, nodeCreatePosition)}
              onClose={() => setNodeCreatePosition(null)}
            />
          )}
        </InfiniteCanvas>
        {(() => {
          const toolbarNode = hoveredNodeId
            ? nodeMap.get(hoveredNodeId)
            : selectedNodeIds.size === 1
              ? nodeMap.get([...selectedNodeIds][0])
              : undefined
          if (!toolbarNode || selectionBox || runningNodeId === toolbarNode.id) return null
          const toolbarLeft =
            viewport.x + toolbarNode.position.x * viewport.k + (toolbarNode.width * viewport.k) / 2
          const toolbarTop = viewport.y + toolbarNode.position.y * viewport.k - 42
          return (
            <div
              className="pointer-events-auto absolute z-[75] flex -translate-x-1/2 items-center gap-0.5 rounded-xl border p-1 shadow-xl backdrop-blur"
              style={{
                left: toolbarLeft,
                top: Math.max(66, toolbarTop),
                background: theme.toolbar.panel,
                borderColor: theme.toolbar.border
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                title="编辑 / 打开面板"
                className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                style={{ color: theme.toolbar.item }}
                onClick={() => {
                  setSelectedNodeIds(new Set([toolbarNode.id]))
                  setPanelNodeId(toolbarNode.id)
                }}
              >
                <FolderOpen className="size-3.5" />
              </button>
              {toolbarNode.type === 'text' && (
                <button
                  type="button"
                  title="从文本生成"
                  className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                  style={{ color: theme.toolbar.item }}
                  onClick={() => generateImageFromText(toolbarNode)}
                >
                  <ImageIcon className="size-3.5" />
                </button>
              )}
              {toolbarNode.type === 'text' && (
                <>
                  <button
                    type="button"
                    title="减小字号"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => updateFontSize(toolbarNode.id, -2)}
                  >
                    <Minus className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="增大字号"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => updateFontSize(toolbarNode.id, 2)}
                  >
                    <Plus className="size-3.5" />
                  </button>
                </>
              )}
              {(toolbarNode.type === 'image' ||
                toolbarNode.type === 'video' ||
                toolbarNode.type === 'audio') && (
                <>
                  <button
                    type="button"
                    title="替换媒体"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => {
                      setReplaceMediaNodeId(toolbarNode.id)
                      requestAnimationFrame(() => replaceMediaInputRef.current?.click())
                    }}
                  >
                    <FileUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="下载媒体"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => downloadNode(toolbarNode)}
                  >
                    <Download className="size-3.5" />
                  </button>
                </>
              )}
              {toolbarNode.type === 'image' && toolbarNode.metadata?.content && (
                <>
                  <button
                    type="button"
                    title="裁剪"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => setMediaDialog({ type: 'crop', nodeId: toolbarNode.id })}
                  >
                    <Crop className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="拆分"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => setMediaDialog({ type: 'split', nodeId: toolbarNode.id })}
                  >
                    <Grid2x2 className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="放大"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => setMediaDialog({ type: 'upscale', nodeId: toolbarNode.id })}
                  >
                    <Maximize2 className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="蒙版编辑（局部重绘）"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => setMediaDialog({ type: 'mask', nodeId: toolbarNode.id })}
                  >
                    <Brush className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="反推提示词"
                    className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => void reversePromptForNode(toolbarNode)}
                  >
                    <ScanText className="size-3.5" />
                  </button>
                </>
              )}
              {toolbarNode.type === 'image' && (
                <button
                  type="button"
                  title="切换自由缩放"
                  className={cn(
                    'grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10',
                    toolbarNode.metadata?.freeResize && 'bg-black/10 dark:bg-white/10'
                  )}
                  style={{ color: theme.toolbar.item }}
                  onClick={() => toggleFreeResize(toolbarNode.id)}
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              )}
              {(toolbarNode.type === 'markdown:doc' ||
                toolbarNode.type === 'svg:vector' ||
                toolbarNode.type === 'html:render') && (
                <button
                  type="button"
                  title={toolbarNode.metadata?.editing ? '预览' : '编辑'}
                  className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                  style={{ color: theme.toolbar.item }}
                  onClick={() =>
                    handleExtensionMetadataChange(toolbarNode.id, {
                      editing: !toolbarNode.metadata?.editing
                    })
                  }
                >
                  {toolbarNode.metadata?.editing ? '👁' : '✎'}
                </button>
              )}
              {toolbarNode.metadata?.content && (
                <button
                  type="button"
                  title="存入资产"
                  className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                  style={{ color: theme.toolbar.item }}
                  onClick={() => {
                    saveCanvasAsset({
                      kind:
                        toolbarNode.type === 'image'
                          ? 'image'
                          : toolbarNode.type === 'video'
                            ? 'video'
                            : 'text',
                      title: toolbarNode.title,
                      content: String(toolbarNode.metadata?.content ?? '')
                    })
                    setAssetLibraryState({ open: true, tab: 'assets' })
                  }}
                >
                  <BookmarkPlus className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                title="复制"
                className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                style={{ color: theme.toolbar.item }}
                onClick={() => duplicateNode(toolbarNode.id)}
              >
                <Copy className="size-3.5" />
              </button>
              <button
                type="button"
                title="删除"
                className="grid size-7 place-items-center rounded-lg text-red-500 transition hover:bg-red-500/10"
                onClick={() => {
                  setSelectedNodeIds(new Set([toolbarNode.id]))
                  deleteSelected()
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )
        })()}
        <CanvasToolbar
          theme={theme}
          selectedCount={selectedNodeIds.size}
          canvasTool={tool}
          canUndo={historyState.canUndo}
          canRedo={historyState.canRedo}
          settings={settings}
          onCanvasToolChange={setTool}
          onUndo={undo}
          onRedo={redo}
          onAddText={() => createNode('text')}
          onAddImage={() => createNode('image')}
          onAddVideo={() => createNode('video')}
          onAddAudio={() => createNode('audio')}
          onAddConfig={() => createNode('config')}
          onAddGroup={() => createNode('group')}
          onAddExtensionNode={(type) => createNode(type)}
          onUpload={() => fileInputRef.current?.click()}
          onDelete={deleteSelected}
          onClear={() => setClearConfirmOpen(true)}
          onSettingsChange={updateSettings}
          onOpenMediaConfig={() => setMediaConfigOpen(true)}
          onOpenMediaLogs={() => setMediaLogsOpen(true)}
          onBatchDownload={() => void downloadSelectedBatch()}
          batchDownloading={batchDownloading}
        />
        {mediaConfigOpen && (
          <MediaConfigDialog
            theme={theme}
            onClose={() => setMediaConfigOpen(false)}
          />
        )}
        {mediaLogsOpen && <MediaLogPanel theme={theme} onClose={() => setMediaLogsOpen(false)} />}
        {miniMapOpen && (
          <Minimap
            theme={theme}
            nodes={nodes}
            viewport={viewport}
            viewportSize={canvasSize}
            onViewportChange={setViewport}
          />
        )}
        <CanvasZoomControls
          theme={theme}
          scale={viewport.k}
          onScaleChange={changeZoom}
          onReset={resetViewport}
          isMiniMapOpen={miniMapOpen}
          onToggleMiniMap={() => setMiniMapOpen((value) => !value)}
        />
        {contextMenu && (
          <CanvasContextMenu
            theme={theme}
            menu={contextMenu}
            onClose={() => setContextMenu(null)}
            onDuplicate={() => contextMenu.type === 'node' && duplicateNode(contextMenu.nodeId)}
            onDelete={deleteSelected}
          />
        )}
        <button
          type="button"
          className="absolute top-16 right-24 z-40 grid size-8 place-items-center rounded-lg border opacity-60 transition hover:opacity-100"
          style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
          title="我的资产 / 提示词库"
          onClick={() => setAssetLibraryState({ open: true, tab: 'assets' })}
        >
          <BookOpen className="size-4" />
        </button>
        {assetLibraryState.open && (
          <CanvasAssetLibrary
            theme={theme}
            nodes={nodes}
            initialTab={assetLibraryState.tab}
            onInsert={insertAsset}
            onUsePrompt={applyPromptFromLibrary}
            onClose={() => setAssetLibraryState((current) => ({ ...current, open: false }))}
          />
        )}
        {mediaDialog &&
          nodeMap.get(mediaDialog.nodeId)?.metadata?.content &&
          mediaDialog.type === 'crop' && (
            <CropDialog
              theme={theme}
              source={nodeMap.get(mediaDialog.nodeId)!.metadata!.content as string}
              onClose={() => setMediaDialog(null)}
              onConfirm={(crop) => void cropImage(nodeMap.get(mediaDialog.nodeId)!, crop)}
            />
          )}
        {mediaDialog &&
          nodeMap.get(mediaDialog.nodeId)?.metadata?.content &&
          mediaDialog.type === 'split' && (
            <SplitDialog
              theme={theme}
              source={nodeMap.get(mediaDialog.nodeId)!.metadata!.content as string}
              onClose={() => setMediaDialog(null)}
              onConfirm={(params) => void splitImage(nodeMap.get(mediaDialog.nodeId)!, params)}
            />
          )}
        {mediaDialog &&
          nodeMap.get(mediaDialog.nodeId)?.metadata?.content &&
          mediaDialog.type === 'upscale' && (
            <UpscaleDialog
              theme={theme}
              source={nodeMap.get(mediaDialog.nodeId)!.metadata!.content as string}
              onClose={() => setMediaDialog(null)}
              onConfirm={(scale) => void upscaleImage(nodeMap.get(mediaDialog.nodeId)!, scale)}
            />
          )}
        {mediaDialog &&
          nodeMap.get(mediaDialog.nodeId)?.metadata?.content &&
          mediaDialog.type === 'mask' && (
            <MaskEditDialog
              theme={theme}
              source={nodeMap.get(mediaDialog.nodeId)!.metadata!.content as string}
              onClose={() => setMediaDialog(null)}
              onConfirm={(payload) => void maskEditImage(nodeMap.get(mediaDialog.nodeId)!, payload)}
            />
          )}
        {clearConfirmOpen && (
          <div
            className="fixed inset-0 z-[100] grid place-items-center bg-black/25 p-4"
            onClick={() => setClearConfirmOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded-2xl border p-5 shadow-2xl"
              style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="text-base font-semibold">清空画布？</h2>
              <p className="mt-2 text-sm opacity-60">所有节点和连线都会被删除。</p>
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setClearConfirmOpen(false)}>
                  取消
                </Button>
                <Button variant="destructive" onClick={clearCanvas}>
                  <Trash2 className="size-4" />
                  清空
                </Button>
              </div>
            </div>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept="image/*,video/*,audio/*,.mp3,.wav"
          onChange={(event) => void handleFileInput(event)}
        />
        <input
          ref={jsonInputRef}
          type="file"
          className="hidden"
          accept="application/json,.json"
          onChange={(event) => void importProject(event.target.files?.[0])}
        />
        <input
          ref={replaceMediaInputRef}
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*,.mp3,.wav"
          onChange={(event) => void replaceMedia(replaceMediaNodeId ?? '', event.target.files?.[0])}
        />
        <button
          type="button"
          className="absolute top-16 right-4 z-40 grid size-8 place-items-center rounded-lg border opacity-60 transition hover:opacity-100"
          style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
          title="导入 JSON"
          onClick={() => jsonInputRef.current?.click()}
        >
          <FileUp className="size-4" />
        </button>
        <button
          type="button"
          className="absolute top-16 right-14 z-40 grid size-8 place-items-center rounded-lg border opacity-60 transition hover:opacity-100"
          style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
          title="刷新"
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-4" />
        </button>
      </section>
      {agentPanelOpen && (
        <CanvasAgentPanel
          theme={theme}
          projectId={project.id}
          projectTitle={project.title}
          selectedNodeIds={[...selectedNodeIds]}
          nodeCount={nodes.length}
          onRefresh={() => void loadProject(project.id)}
          onClose={() => setAgentPanelOpen(false)}
        />
      )}
    </div>
  )
}

export function InfiniteCanvasNavigationContribution(props: Record<string, unknown>): ReactElement {
  const onNavigate =
    typeof props.onNavigate === 'function'
      ? (props.onNavigate as (view: string) => void)
      : undefined
  const active = props.currentView === 'plugin:infinite-canvas'
  return (
    <Button
      variant="ghost"
      size="icon"
      title="无限画布"
      aria-label="无限画布"
      aria-current={active ? 'page' : undefined}
      className={cn('size-9', active ? 'text-text' : 'text-subtle hover:bg-accent hover:text-text')}
      onClick={() => onNavigate?.('plugin:infinite-canvas')}
    >
      <MoreHorizontal className="size-4" />
    </Button>
  )
}
