import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  AnyCanvasNodeType,
  CanvasBackgroundMode,
  CanvasConnection,
  CanvasNode,
  CanvasProject,
  CanvasProjectSettings,
  CreateNodeInput,
  UpsertNodeInput
} from './types.js'

type ProjectRow = {
  id: string
  title: string
  description: string
  viewport_json: string
  settings_json: string | null
  created_at: number
  updated_at: number
}

type NodeRow = {
  id: string
  project_id: string
  type: AnyCanvasNodeType
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  metadata_json: string
  created_at: number
  updated_at: number
}

type ConnectionRow = {
  id: string
  project_id: string
  from_node_id: string
  to_node_id: string
  created_at: number
}

const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 }
const DEFAULT_SETTINGS: CanvasProjectSettings = { backgroundMode: 'lines', showImageInfo: false }

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function settingsFromRow(row: Pick<ProjectRow, 'settings_json'>): CanvasProjectSettings {
  const raw = row.settings_json
    ? parseJson<Partial<CanvasProjectSettings>>(row.settings_json, {})
    : {}
  const backgroundMode: CanvasBackgroundMode =
    raw.backgroundMode === 'dots' ||
    raw.backgroundMode === 'blank' ||
    raw.backgroundMode === 'lines'
      ? raw.backgroundMode
      : DEFAULT_SETTINGS.backgroundMode
  return { backgroundMode, showImageInfo: Boolean(raw.showImageInfo) }
}

function nodeFromRow(row: NodeRow): CanvasNode {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    content: row.content,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function connectionFromRow(row: ConnectionRow): CanvasConnection {
  return {
    id: row.id,
    projectId: row.project_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    createdAt: row.created_at
  }
}

export class InfiniteCanvasStore {
  constructor(private readonly db: Database.Database) {}

  listProjects(): Array<Omit<CanvasProject, 'nodes' | 'connections'>> {
    const rows = this.db
      .prepare('SELECT * FROM infinite_canvas_projects ORDER BY updated_at DESC')
      .all() as ProjectRow[]
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      viewport: parseJson(row.viewport_json, DEFAULT_VIEWPORT),
      settings: settingsFromRow(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  getProject(id: string): CanvasProject | undefined {
    const row = this.db.prepare('SELECT * FROM infinite_canvas_projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    if (!row) return undefined
    const nodes = this.db
      .prepare('SELECT * FROM infinite_canvas_nodes WHERE project_id = ? ORDER BY created_at')
      .all(id) as NodeRow[]
    const connections = this.db
      .prepare('SELECT * FROM infinite_canvas_connections WHERE project_id = ? ORDER BY created_at')
      .all(id) as ConnectionRow[]
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      viewport: parseJson(row.viewport_json, DEFAULT_VIEWPORT),
      settings: settingsFromRow(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodes: nodes.map(nodeFromRow),
      connections: connections.map(connectionFromRow)
    }
  }

  createProject(input: { title?: string; description?: string }): CanvasProject {
    const now = Date.now()
    const project: CanvasProject = {
      id: randomUUID(),
      title: input.title?.trim() || '未命名画布',
      description: input.description?.trim() || '',
      viewport: { ...DEFAULT_VIEWPORT },
      settings: { ...DEFAULT_SETTINGS },
      createdAt: now,
      updatedAt: now,
      nodes: [],
      connections: []
    }
    this.db
      .prepare(
        `INSERT INTO infinite_canvas_projects
      (id, title, description, viewport_json, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.id,
        project.title,
        project.description,
        JSON.stringify(project.viewport),
        JSON.stringify(project.settings),
        now,
        now
      )
    return project
  }

  updateProject(
    id: string,
    patch: {
      title?: string
      description?: string
      viewport?: CanvasProject['viewport']
      settings?: Partial<CanvasProjectSettings>
    }
  ): CanvasProject | undefined {
    const existing = this.getProject(id)
    if (!existing) return undefined
    const updatedAt = Date.now()
    const title = patch.title === undefined ? existing.title : patch.title.trim() || existing.title
    const description = patch.description === undefined ? existing.description : patch.description
    const viewportInput =
      patch.viewport && typeof patch.viewport === 'object' ? patch.viewport : undefined
    const viewport = viewportInput
      ? {
          x: Number.isFinite(viewportInput.x) ? viewportInput.x : existing.viewport.x,
          y: Number.isFinite(viewportInput.y) ? viewportInput.y : existing.viewport.y,
          zoom: Number.isFinite(viewportInput.zoom)
            ? Math.min(5, Math.max(0.1, viewportInput.zoom))
            : existing.viewport.zoom
        }
      : existing.viewport
    const settings: CanvasProjectSettings = {
      backgroundMode:
        patch.settings?.backgroundMode === 'dots' ||
        patch.settings?.backgroundMode === 'lines' ||
        patch.settings?.backgroundMode === 'blank'
          ? patch.settings.backgroundMode
          : existing.settings.backgroundMode,
      showImageInfo:
        patch.settings?.showImageInfo === undefined
          ? existing.settings.showImageInfo
          : Boolean(patch.settings.showImageInfo)
    }
    this.db
      .prepare(
        `UPDATE infinite_canvas_projects
      SET title = ?, description = ?, viewport_json = ?, settings_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(title, description, JSON.stringify(viewport), JSON.stringify(settings), updatedAt, id)
    return this.getProject(id)
  }

  /**
   * 整图同步：以客户端会话内的最新状态为准，一次性替换项目的节点与连线，
   * 并更新视口与项目设置。桌面端本地优先编辑、400ms 防抖后调用本方法持久化。
   */
  replaceGraph(
    id: string,
    payload: {
      nodes: UpsertNodeInput[]
      connections: Array<Pick<CanvasConnection, 'id' | 'fromNodeId' | 'toNodeId'>>
      viewport?: CanvasProject['viewport']
      settings?: Partial<CanvasProjectSettings>
    }
  ): CanvasProject | undefined {
    const existing = this.getProject(id)
    if (!existing) return undefined
    const now = Date.now()
    const seenIds = new Set<string>()
    const nodes = payload.nodes
      .filter((node) => node && typeof node.id === 'string' && node.id.length > 0)
      .filter((node) => (seenIds.has(node.id) ? false : (seenIds.add(node.id), true)))
      .map((node) => ({
        id: node.id,
        type: node.type,
        title:
          typeof node.title === 'string' && node.title.trim()
            ? node.title.trim()
            : this.defaultTitle(node.type),
        content:
          typeof node.content === 'string' && node.content.length > 0
            ? node.content.slice(0, 2_000_000)
            : node.metadata && typeof node.metadata.content === 'string'
              ? node.metadata.content.slice(0, 2_000_000)
              : '',
        x: Number.isFinite(node.x) ? Number(node.x) : 80,
        y: Number.isFinite(node.y) ? Number(node.y) : 80,
        width: Number.isFinite(node.width) ? Math.max(40, Number(node.width)) : 340,
        height: Number.isFinite(node.height) ? Math.max(40, Number(node.height)) : 240,
        metadata: node.metadata && typeof node.metadata === 'object' ? node.metadata : {}
      }))
    const nodeIdSet = new Set(nodes.map((node) => node.id))
    const connections = payload.connections.filter(
      (connection) =>
        connection &&
        typeof connection.id === 'string' &&
        connection.id.length > 0 &&
        nodeIdSet.has(connection.fromNodeId) &&
        nodeIdSet.has(connection.toNodeId) &&
        connection.fromNodeId !== connection.toNodeId
    )
    const sync = this.db.transaction(() => {
      this.db.prepare('DELETE FROM infinite_canvas_connections WHERE project_id = ?').run(id)
      this.db.prepare('DELETE FROM infinite_canvas_nodes WHERE project_id = ?').run(id)
      const insertNode = this.db.prepare(
        `INSERT INTO infinite_canvas_nodes
        (id, project_id, type, title, content, x, y, width, height, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const node of nodes) {
        insertNode.run(
          node.id,
          id,
          node.type,
          node.title,
          node.content,
          node.x,
          node.y,
          node.width,
          node.height,
          JSON.stringify(node.metadata),
          now,
          now
        )
      }
      const insertConnection = this.db.prepare(
        'INSERT OR IGNORE INTO infinite_canvas_connections (id, project_id, from_node_id, to_node_id, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const connection of connections) {
        insertConnection.run(connection.id, id, connection.fromNodeId, connection.toNodeId, now)
      }
    })
    sync()
    return this.updateProject(id, { viewport: payload.viewport, settings: payload.settings })
  }

  deleteProject(id: string): boolean {
    return this.db.prepare('DELETE FROM infinite_canvas_projects WHERE id = ?').run(id).changes > 0
  }

  createNode(projectId: string, input: CreateNodeInput): CanvasNode | undefined {
    if (!this.projectExists(projectId)) return undefined
    const now = Date.now()
    const node: CanvasNode = {
      id: randomUUID(),
      projectId,
      type: input.type,
      title: input.title?.trim() || this.defaultTitle(input.type),
      content: input.content ?? '',
      x: Number.isFinite(input.x) ? Number(input.x) : 80,
      y: Number.isFinite(input.y) ? Number(input.y) : 80,
      width: Number.isFinite(input.width) ? Number(input.width) : 280,
      height: Number.isFinite(input.height) ? Number(input.height) : 180,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now
    }
    this.db
      .prepare(
        `INSERT INTO infinite_canvas_nodes
      (id, project_id, type, title, content, x, y, width, height, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        node.id,
        node.projectId,
        node.type,
        node.title,
        node.content,
        node.x,
        node.y,
        node.width,
        node.height,
        JSON.stringify(node.metadata),
        now,
        now
      )
    this.touchProject(projectId)
    return node
  }

  updateNode(
    id: string,
    patch: Partial<Omit<CanvasNode, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>
  ): CanvasNode | undefined {
    const existing = this.getNode(id)
    if (!existing) return undefined
    const updatedAt = Date.now()
    // 路由层为未提供的字段传显式 undefined，逐字段回退而不是整体展开，
    // 避免部分更新把已有值覆盖成 undefined（绑定 NULL 触发 NOT NULL 约束）。
    const next: CanvasNode = {
      ...existing,
      type: patch.type ?? existing.type,
      title: patch.title === undefined ? existing.title : patch.title.trim() || existing.title,
      content: patch.content ?? existing.content,
      x: Number.isFinite(patch.x) ? (patch.x as number) : existing.x,
      y: Number.isFinite(patch.y) ? (patch.y as number) : existing.y,
      width: Number.isFinite(patch.width) ? (patch.width as number) : existing.width,
      height: Number.isFinite(patch.height) ? (patch.height as number) : existing.height,
      metadata: patch.metadata ?? existing.metadata,
      updatedAt
    }
    this.db
      .prepare(
        `UPDATE infinite_canvas_nodes SET type = ?, title = ?, content = ?, x = ?, y = ?, width = ?, height = ?, metadata_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.type,
        next.title,
        next.content,
        next.x,
        next.y,
        next.width,
        next.height,
        JSON.stringify(next.metadata),
        updatedAt,
        id
      )
    this.touchProject(existing.projectId)
    return next
  }

  deleteNode(id: string): boolean {
    const node = this.getNode(id)
    if (!node) return false
    this.db.prepare('DELETE FROM infinite_canvas_nodes WHERE id = ?').run(id)
    this.touchProject(node.projectId)
    return true
  }

  createConnection(
    projectId: string,
    fromNodeId: string,
    toNodeId: string
  ): CanvasConnection | undefined {
    if (fromNodeId === toNodeId || !this.projectExists(projectId)) return undefined
    const validNodes = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM infinite_canvas_nodes WHERE project_id = ? AND id IN (?, ?)'
      )
      .get(projectId, fromNodeId, toNodeId) as { count: number }
    if (validNodes.count !== 2) return undefined
    const existing = this.db
      .prepare(
        'SELECT * FROM infinite_canvas_connections WHERE project_id = ? AND from_node_id = ? AND to_node_id = ?'
      )
      .get(projectId, fromNodeId, toNodeId) as ConnectionRow | undefined
    if (existing) return connectionFromRow(existing)
    const connection: CanvasConnection = {
      id: randomUUID(),
      projectId,
      fromNodeId,
      toNodeId,
      createdAt: Date.now()
    }
    this.db
      .prepare(
        'INSERT INTO infinite_canvas_connections (id, project_id, from_node_id, to_node_id, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(connection.id, projectId, fromNodeId, toNodeId, connection.createdAt)
    this.touchProject(projectId)
    return connection
  }

  deleteConnection(id: string): boolean {
    const connection = this.db
      .prepare('SELECT project_id FROM infinite_canvas_connections WHERE id = ?')
      .get(id) as { project_id: string } | undefined
    if (!connection) return false
    this.db.prepare('DELETE FROM infinite_canvas_connections WHERE id = ?').run(id)
    this.touchProject(connection.project_id)
    return true
  }

  private getNode(id: string): CanvasNode | undefined {
    const row = this.db.prepare('SELECT * FROM infinite_canvas_nodes WHERE id = ?').get(id) as
      | NodeRow
      | undefined
    return row ? nodeFromRow(row) : undefined
  }

  private projectExists(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM infinite_canvas_projects WHERE id = ?').get(id))
  }

  private touchProject(id: string): void {
    this.db
      .prepare('UPDATE infinite_canvas_projects SET updated_at = ? WHERE id = ?')
      .run(Date.now(), id)
  }

  private defaultTitle(type: AnyCanvasNodeType): string {
    const titles: Record<string, string> = {
      image: '图片',
      text: '文本',
      config: '生成配置',
      video: '视频',
      audio: '音频',
      group: '分组',
      prompt: 'Prompt',
      file: '文件引用',
      agent: 'Agent 结果'
    }
    return titles[type] ?? '节点'
  }
}
