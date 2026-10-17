import { describe, expect, it } from 'vitest'
import { RevisionController } from '../core/quality/revision-controller.js'

const failure = { gateId: 'prose-shape', reason: '形态问题' }

describe('RevisionController', () => {
  it('allows bounded attempts and records structured rounds', () => {
    const controller = new RevisionController(2)
    expect(controller.decide([failure])).toMatchObject({ action: 'attempt' })
    controller.record({ round: 1, remainingFailures: [failure], appliedPatches: 2, failedPatches: 0, contentLength: 100 })
    expect(controller.decide([])).toMatchObject({ action: 'passed' })
    expect(controller.snapshot().rounds).toHaveLength(1)
  })

  it('stops after an ineffective patch round', () => {
    const controller = new RevisionController(3)
    controller.record({ round: 1, remainingFailures: [failure], appliedPatches: 0, failedPatches: 1, contentLength: 100 })
    expect(controller.decide([failure])).toMatchObject({ action: 'checkpoint' })
  })

  it('returns a checkpoint decision when the round budget is exhausted', () => {
    const controller = new RevisionController(1)
    controller.record({ round: 1, remainingFailures: [failure], appliedPatches: 1, failedPatches: 0, contentLength: 100 })
    expect(controller.decide([failure])).toMatchObject({ action: 'checkpoint' })
  })
})
