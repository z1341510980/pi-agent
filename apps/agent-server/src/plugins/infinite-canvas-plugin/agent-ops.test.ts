import { afterAll, afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applyCanvasAgentOperations } from './agent-ops.js'
import { infiniteCanvasMigrations } from './migrations.js'
import { InfiniteCanvasStore } from './store.js'

describe('canvas agent operations', () => {
  const db = new Database(':memory:')
  for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
  const store = new InfiniteCanvasStore(db)

  afterEach(() =>
    db.exec(
      'DELETE FROM infinite_canvas_connections; DELETE FROM infinite_canvas_nodes; DELETE FROM infinite_canvas_projects;'
    )
  )
  afterAll(() => db.close())

  it('applies graph mutations, selection, and viewport in order', async () => {
    const project = store.createProject({ title: 'ops' })
    const original = store.createNode(project.id, { type: 'text', title: 'old', content: 'old' })!
    const result = await applyCanvasAgentOperations(store, project.id, [
      { type: 'update_node', id: original.id, metadata: { content: 'new' } },
      { type: 'add_node', id: 'second', nodeType: 'text', title: 'second', x: 400, y: 20 },
      { type: 'connect_nodes', fromNodeId: original.id, toNodeId: 'second' },
      { type: 'select_nodes', ids: ['second', 'missing'] },
      { type: 'set_viewport', viewport: { x: 12, y: 24, zoom: 1.5 } }
    ])
    expect(result?.project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: original.id, content: 'new' }),
        expect.objectContaining({ id: 'second' })
      ])
    )
    expect(result?.project.connections).toEqual([
      expect.objectContaining({ fromNodeId: original.id, toNodeId: 'second' })
    ])
    expect(result?.selectedNodeIds).toEqual(['second'])
    expect(result?.project.viewport).toEqual({ x: 12, y: 24, zoom: 1.5 })
  })

  it('runs text generation and adds image results', async () => {
    const project = store.createProject({ title: 'generation' })
    const source = store.createNode(project.id, {
      type: 'config',
      title: 'config',
      metadata: { prompt: 'a cat' }
    })!
    const result = await applyCanvasAgentOperations(
      store,
      project.id,
      [{ type: 'run_generation', nodeId: source.id, mode: 'image' }],
      {
        generate: async () => ({ images: ['data:image/png;base64,abc'] })
      }
    )
    expect(result?.project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', content: 'data:image/png;base64,abc' })
      ])
    )
  })
})
