import { describe, expect, it, vi } from 'vitest'

describe('creation-flow-commands', () => {
  it('exports a stable command surface for checkpoint, chat, and interject transport', async () => {
    vi.resetModules()
    vi.doMock('@/api/novel-client', () => ({
      submitCheckpointDecision: vi.fn(),
      persistChapterChat: vi.fn(),
      sendFlowMessage: vi.fn(),
    }))
    const { creationFlowCommands } = await import('../creation-flow-commands')
    expect(Object.keys(creationFlowCommands)).toEqual(['submitCheckpoint', 'persistChat', 'sendInterject'])
  })
})
