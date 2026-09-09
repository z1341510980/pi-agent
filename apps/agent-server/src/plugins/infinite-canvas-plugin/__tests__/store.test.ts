import { afterAll, afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { InfiniteCanvasStore } from '../store.js'
import { infiniteCanvasMigrations } from '../migrations.js'

describe('InfiniteCanvasStore', () => {
  const db = new Database(':memory:')

  for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
  const store = new InfiniteCanvasStore(db)

  afterEach(() => {
    db.exec(
      'DELETE FROM infinite_canvas_connections; DELETE FROM infinite_canvas_nodes; DELETE FROM infinite_canvas_projects;'
    )
  })
  afterAll(() => db.close())

  it('creates a project, nodes, and a connection', () => {
    const project = store.createProject({ title: 'Agent 视觉草图' })
    const prompt = store.createNode(project.id, { type: 'prompt', content: '整理这个方案' })!
    const result = store.createNode(project.id, { type: 'agent', content: '待生成结果', x: 420 })!
    const connection = store.createConnection(project.id, prompt.id, result.id)!

    expect(store.getProject(project.id)).toMatchObject({
      title: 'Agent 视觉草图',
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: prompt.id, type: 'prompt' }),
        expect.objectContaining({ id: result.id, type: 'agent' })
      ]),
      connections: [
        expect.objectContaining({ id: connection.id, fromNodeId: prompt.id, toNodeId: result.id })
      ]
    })
  })

  it('touches project timestamps and removes a node with its connections', () => {
    const project = store.createProject({ title: '删除测试' })
    const first = store.createNode(project.id, { type: 'text' })!
    const second = store.createNode(project.id, { type: 'text' })!
    const connection = store.createConnection(project.id, first.id, second.id)!
    expect(store.deleteNode(first.id)).toBe(true)
    expect(store.getProject(project.id)?.connections).toEqual([])
    expect(store.deleteConnection(connection.id)).toBe(false)
  })

  it('rejects invalid self connections and unknown projects', () => {
    const project = store.createProject({ title: '校验测试' })
    const node = store.createNode(project.id, { type: 'text' })!
    expect(store.createConnection(project.id, node.id, node.id)).toBeUndefined()
    expect(store.createNode('missing', { type: 'text' })).toBeUndefined()
  })

  it('keeps existing fields on route-style partial updates with explicit undefined', () => {
    const project = store.createProject({ title: '部分更新测试' })
    const node = store.createNode(project.id, {
      type: 'prompt',
      title: '原始标题',
      content: '原始内容',
      x: 10,
      y: 20
    })!
    // 模拟 routes.ts PATCH /nodes/:nodeId 的构造方式：未提供的字段是显式 undefined
    const updated = store.updateNode(node.id, {
      type: undefined,
      title: '新标题',
      content: undefined,
      x: undefined,
      y: undefined,
      width: undefined,
      height: undefined,
      metadata: undefined
    })
    expect(updated).toMatchObject({
      type: 'prompt',
      title: '新标题',
      content: '原始内容',
      x: 10,
      y: 20,
      width: 280,
      height: 180
    })
    // 非法坐标（NaN）不能把已有位置改成 NULL
    const movedBack = store.updateNode(node.id, { x: Number.NaN })!
    expect(movedBack.x).toBe(10)
    const persisted = store.getProject(project.id)!.nodes[0]
    expect(persisted.content).toBe('原始内容')
    expect(persisted.x).toBe(10)
  })

  it('falls back to the stored viewport when patch viewport is malformed', () => {
    const project = store.createProject({ title: '视口测试' })
    store.updateProject(project.id, { viewport: { x: 5, y: 6, zoom: 1.5 } })
    const broken = store.updateProject(project.id, {
      viewport: { x: Number.NaN, y: undefined as unknown as number, zoom: 99 }
    })!
    expect(broken.viewport).toEqual({ x: 5, y: 6, zoom: 5 })
  })

  it('persists project settings with defaults and partial patches', () => {
    const project = store.createProject({ title: '外观测试' })
    expect(store.getProject(project.id)!.settings).toEqual({
      backgroundMode: 'lines',
      showImageInfo: false
    })
    const updated = store.updateProject(project.id, {
      settings: { backgroundMode: 'dots', showImageInfo: true }
    })!
    expect(updated.settings).toEqual({ backgroundMode: 'dots', showImageInfo: true })
    // 未提供的设置项保持不变
    const kept = store.updateProject(project.id, { settings: { showImageInfo: false } })!
    expect(kept.settings).toEqual({ backgroundMode: 'dots', showImageInfo: false })
  })

  it('replaces the whole graph atomically and drops dangling connections', () => {
    const project = store.createProject({ title: '整图同步' })
    store.createNode(project.id, { type: 'text', title: '旧节点' })
    const graph = store.replaceGraph(project.id, {
      nodes: [
        { id: 'n1', type: 'image', title: '', x: 0, y: 0, width: 340, height: 240, metadata: {} },
        {
          id: 'n2',
          type: 'config',
          title: '配置',
          x: 500,
          y: 0,
          width: 340,
          height: 240,
          metadata: { generationMode: 'image' }
        },
        {
          id: 'n1',
          type: 'text' as never,
          title: '重复 id 占位',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          metadata: {}
        }
      ],
      connections: [
        { id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' },
        { id: 'c2', fromNodeId: 'n1', toNodeId: 'missing' }
      ],
      viewport: { x: 12, y: 34, zoom: 1.25 },
      settings: { backgroundMode: 'blank', showImageInfo: true }
    })!
    expect(graph.nodes.map((node) => node.id)).toEqual(['n1', 'n2'])
    expect(graph.nodes[0].title).toBe('图片')
    expect(graph.connections).toEqual([
      expect.objectContaining({ id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' })
    ])
    expect(graph.viewport).toEqual({ x: 12, y: 34, zoom: 1.25 })
    expect(graph.settings).toEqual({ backgroundMode: 'blank', showImageInfo: true })

    const emptied = store.replaceGraph(project.id, { nodes: [], connections: [] })!
    expect(emptied.nodes).toEqual([])
    expect(emptied.connections).toEqual([])
    expect(store.replaceGraph('missing', { nodes: [], connections: [] })).toBeUndefined()
  })

  it('stores oversized image data URLs without silent truncation', () => {
    const project = store.createProject({ title: '大图' })
    const content = `data:image/jpeg;base64,${'A'.repeat(2_100_000)}`
    const graph = store.replaceGraph(project.id, {
      nodes: [
        {
          id: 'big',
          type: 'image',
          title: '照片.jpg',
          content,
          x: 0,
          y: 0,
          width: 340,
          height: 240,
          metadata: {}
        }
      ],
      connections: []
    })!
    expect(graph.nodes[0].content).toHaveLength(content.length)
  })

  it('keeps extension node types and supplies a safe title', () => {
    const project = store.createProject({ title: '插件节点' })
    const graph = store.replaceGraph(project.id, {
      nodes: [
        {
          id: 'markdown-1',
          type: 'markdown:doc',
          title: '',
          x: 0,
          y: 0,
          width: 360,
          height: 300,
          metadata: { content: '# hello' }
        }
      ],
      connections: []
    })!
    expect(graph.nodes[0]).toMatchObject({ type: 'markdown:doc', title: '节点' })
  })

  it('supports the graph operations used by Canvas Agent', () => {
    const project = store.createProject({ title: 'Agent 操作' })
    const first = store.createNode(project.id, { type: 'text', title: '第一节点' })!
    const second = store.createNode(project.id, { type: 'text', title: '第二节点', x: 400 })!
    const result = store.replaceGraph(project.id, {
      nodes: [
        {
          id: first.id,
          type: 'text',
          title: '更新后',
          x: 20,
          y: 30,
          width: 340,
          height: 240,
          metadata: { content: 'hello' }
        },
        {
          id: second.id,
          type: 'text',
          title: '第二节点',
          x: 400,
          y: 30,
          width: 340,
          height: 240,
          metadata: {}
        }
      ],
      connections: [{ id: 'agent-edge', fromNodeId: first.id, toNodeId: second.id }],
      viewport: { x: 20, y: 30, zoom: 1.2 }
    })!
    expect(result.nodes[0]).toMatchObject({
      id: first.id,
      title: '更新后',
      content: 'hello',
      x: 20,
      y: 30
    })
    expect(result.connections).toEqual([
      expect.objectContaining({ id: 'agent-edge', fromNodeId: first.id, toNodeId: second.id })
    ])
  })
})
