import { describe, expect, it } from 'vitest'
import {
  createCreationRun,
  transitionCreationRun,
  type CreationRunCommand,
  type CreationRunState,
} from '../core/runtime/creation-run-state.js'

const input = {
  runId: 'run-1',
  projectId: 'project-1',
  chapterNumber: 3,
  mode: 'workflow' as const,
  createdAt: 1_700_000_000_000,
}

function apply(state: CreationRunState, command: CreationRunCommand): CreationRunState {
  return transitionCreationRun(state, command, 1_700_000_000_100).state
}

describe('CreationRun state machine', () => {
  it('starts every run in submitted/planning state', () => {
    expect(createCreationRun(input)).toMatchObject({
      runId: 'run-1',
      projectId: 'project-1',
      chapterNumber: 3,
      mode: 'workflow',
      status: 'submitted',
      stage: 'planning',
      revision: 0,
    })
  })

  it('starts arrange runs in the arranging stage', () => {
    expect(createCreationRun({ ...input, mode: 'arrange' })).toMatchObject({
      status: 'submitted',
      stage: 'arranging',
    })
  })

  it('allows a checkpoint to resume into a deliberate next stage', () => {
    let state = createCreationRun(input)
    state = apply(state, { type: 'start', stage: 'planning' })
    state = apply(state, { type: 'await_input', checkpointId: 'cp-1' })
    expect(state).toMatchObject({ status: 'waiting_input', checkpointId: 'cp-1' })

    state = apply(state, { type: 'resume', stage: 'writing' })
    expect(state).toMatchObject({ status: 'running', stage: 'writing', checkpointId: undefined })
  })

  it('records revision count without reopening completed runs', () => {
    let state = createCreationRun(input)
    state = apply(state, { type: 'start', stage: 'planning' })
    state = apply(state, { type: 'advance', stage: 'writing' })
    state = apply(state, { type: 'advance', stage: 'reviewing' })
    state = apply(state, { type: 'begin_revision', reason: '字数偏差' })

    expect(state).toMatchObject({ status: 'revising', stage: 'revising', revision: 1 })

    state = apply(state, { type: 'advance', stage: 'finalizing' })
    state = apply(state, { type: 'complete' })
    expect(state.status).toBe('completed')

    expect(() => transitionCreationRun(state, { type: 'resume', stage: 'writing' }, 1_700_000_000_100))
      .toThrow('completed')
  })

  it('allows cancellation from any non-terminal state and rejects terminal transitions', () => {
    let state = createCreationRun(input)
    state = apply(state, { type: 'cancel', reason: '用户停止' })
    expect(state).toMatchObject({ status: 'cancelled', error: '用户停止' })

    expect(() => transitionCreationRun(state, { type: 'start', stage: 'planning' }, 1_700_000_000_100))
      .toThrow('cancelled')
  })

  it('rejects skipping stages and invalid checkpoint decisions', () => {
    let state = createCreationRun(input)
    state = apply(state, { type: 'start', stage: 'planning' })

    expect(() => transitionCreationRun(state, { type: 'advance', stage: 'finalizing' }, 1_700_000_000_100))
      .toThrow('invalid stage transition')

    expect(() => transitionCreationRun(state, { type: 'await_input', checkpointId: '' }, 1_700_000_000_100))
      .toThrow('checkpointId')
  })
})
