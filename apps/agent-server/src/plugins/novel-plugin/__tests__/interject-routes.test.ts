import { describe, expect, it, vi } from 'vitest'
import { createInterjectRoutes } from '../routes/interject-routes.js'
import { activeNovelChapterTasks, finishNovelChapterTask, registerNovelChapterTask } from '../utils/chapter-task-registry.js'

describe('interject routes', () => {
  it('locates the active chapter by exact run ID when no chapter number is supplied', async () => {
    const runId = 'workflow-run-uuid'
    const flowKey = 'project-interject|7|workflow-run-uuid'
    const task = registerNovelChapterTask('project-interject:7', 'workflow', runId)
    const enqueueUserMessage = vi.fn(() => true)
    const add = vi.fn()
    const reply = {
      statusCode: 200,
      payload: undefined as unknown,
      code(statusCode: number) { this.statusCode = statusCode; return this },
      send(payload: unknown) { this.payload = payload; return this },
    }
    const route = createInterjectRoutes({
      orchestrator: { enqueueUserMessage },
      chapterChatStore: { add },
    } as any).find(item => item.method === 'POST')!

    try {
      await route.handler({
        params: { projectId: 'project-interject', flowId: runId },
        body: { content: '继续当前动作' },
        query: {},
        traceId: 'trace-1',
        log: { error: vi.fn() },
      } as any, reply as any)

      expect(enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({ flowKey }))
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-interject', chapterNumber: 7 }))
      expect(reply.statusCode).toBe(201)
    } finally {
      finishNovelChapterTask('project-interject:7', task)
      expect(activeNovelChapterTasks.has('project-interject:7')).toBe(false)
    }
  })
})
