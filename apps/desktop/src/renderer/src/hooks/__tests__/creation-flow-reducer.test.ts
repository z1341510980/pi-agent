import { describe, expect, it } from 'vitest'
import { applyUserMessageEvent, streamsChapterContent } from '../creation-flow-reducer'

const queued = { flowId: 'flow-1', messageId: 'm1', content: '插话', status: 'queued' as const, timestamp: 1 }

describe('creation-flow-reducer', () => {
  it('keeps interject status monotonic across reconnect replay', () => {
    const injected = applyUserMessageEvent([queued], { ...queued, status: 'injected', agentType: 'writer', timestamp: 2 })
    expect(applyUserMessageEvent(injected, queued)).toBe(injected)
    expect(injected[0]).toMatchObject({ status: 'injected', agentType: 'writer' })
  })

  it('only treats Writer output as chapter content', () => {
    expect(streamsChapterContent('writer')).toBe(true)
    expect(streamsChapterContent('director')).toBe(false)
  })
})
