import { describe, expect, it } from 'vitest'
import {
  applyPersistedCreationEvent,
  createInitialCreationFlowState,
  type PersistedCreationEvent,
} from '../creation-flow-reducer'

function event(seq: number, payload: Record<string, unknown>): PersistedCreationEvent {
  return { seq, type: 'agui', payload }
}

describe('creation-flow lifecycle reducer', () => {
  it('replays persisted events once and ignores duplicate or stale sequence numbers', () => {
    const first = applyPersistedCreationEvent(
      createInitialCreationFlowState(),
      event(2, {
        type: 'CUSTOM',
        name: 'novel:progress',
        value: { type: 'phase_change', phase: 'writing', data: { message: '写作中' }, timestamp: 2 },
      }),
    )
    const duplicate = applyPersistedCreationEvent(first, event(2, {
      type: 'CUSTOM',
      name: 'novel:progress',
      value: { type: 'phase_change', phase: 'reviewing', data: { message: '错误重放' }, timestamp: 3 },
    }))
    const stale = applyPersistedCreationEvent(duplicate, event(1, {
      type: 'CUSTOM',
      name: 'novel:progress',
      value: { type: 'phase_change', phase: 'directing', data: { message: '旧事件' }, timestamp: 1 },
    }))

    expect(first.cursorSeq).toBe(2)
    expect(duplicate).toBe(first)
    expect(stale).toBe(first)
    expect(first.phase).toBe('writing')
    expect(first.progressMessage).toBe('写作中')
  })

  it('folds terminal run_finished into an explicit non-running state', () => {
    const state = applyPersistedCreationEvent(
      createInitialCreationFlowState(),
      event(4, { type: 'run_finished', payload: { status: 'completed', content: '正文' } }),
    )
    expect(state.cursorSeq).toBe(4)
    expect(state.isRunning).toBe(false)
    expect(state.phase).toBe('completed')
    expect(state.chapterContent).toBe('正文')
  })
})
