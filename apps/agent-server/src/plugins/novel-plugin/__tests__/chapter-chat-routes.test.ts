import { describe, expect, it } from 'vitest'
import { createChapterChatRoutes } from '../routes/chapter-chat-routes.js'
import { createCreationFlowRoutes } from '../routes/creation-flow-routes.js'

describe('chapter chat route ownership', () => {
  it('keeps all chat endpoints in the dedicated chat module', () => {
    const services = {} as any
    const chatPaths = createChapterChatRoutes(services).map((route) => route.path)
    expect(chatPaths).toEqual([
      '/projects/:projectId/chapters/:chapterNumber/chat',
      '/projects/:projectId/chapters/:chapterNumber/chat',
      '/projects/:projectId/chapters/:chapterNumber/chat',
      '/projects/:projectId/chapters/:chapterNumber/chat/persist',
    ])
    expect(createCreationFlowRoutes(services).some((route) => route.path.includes('/chat'))).toBe(false)
  })
})
