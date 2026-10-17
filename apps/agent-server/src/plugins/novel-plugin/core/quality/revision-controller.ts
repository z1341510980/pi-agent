import type { QualityGateFailureItem, RevisionRoundRecord } from '@repo/shared/novel'

export interface RevisionAttemptInput {
  round: number
  remainingFailures: QualityGateFailureItem[]
  appliedPatches: number
  failedPatches: number
  contentLength: number
}

export interface RevisionDecision {
  action: 'attempt' | 'passed' | 'checkpoint'
  reason: string
}

export interface RevisionControllerSnapshot {
  rounds: RevisionRoundRecord[]
  remainingFailures: QualityGateFailureItem[]
  attempts: number
}

/**
 * Pure revision policy used by both create-flow and re-revise.
 * It owns round limits, no-progress detection, and the structured checkpoint reason.
 */
export class RevisionController {
  private readonly records: RevisionRoundRecord[] = []
  private lastAppliedPatches = 1
  private failures: QualityGateFailureItem[] = []

  constructor(private readonly maxRounds: number) {
    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new Error('maxRounds must be a positive integer')
    }
  }

  decide(failedItems: QualityGateFailureItem[], earlyPassIfClean = false): RevisionDecision {
    this.failures = failedItems
    if (failedItems.length === 0 && (earlyPassIfClean || this.records.length > 0)) {
      return { action: 'passed', reason: 'quality gates passed' }
    }
    if (this.records.length >= this.maxRounds) {
      return { action: 'checkpoint', reason: `automatic revision limit exhausted (${this.maxRounds} rounds)` }
    }
    if (this.records.length > 0 && this.lastAppliedPatches === 0) {
      return { action: 'checkpoint', reason: 'revision made no applicable patches' }
    }
    return { action: 'attempt', reason: `revision attempt ${this.records.length + 1} of ${this.maxRounds}` }
  }

  record(input: RevisionAttemptInput): RevisionRoundRecord {
    const record: RevisionRoundRecord = {
      round: input.round,
      appliedPatches: input.appliedPatches,
      failedPatches: input.failedPatches,
      remainingFailures: input.remainingFailures,
      contentLength: input.contentLength,
    }
    this.records.push(record)
    this.lastAppliedPatches = input.appliedPatches
    this.failures = input.remainingFailures
    return record
  }

  snapshot(): RevisionControllerSnapshot {
    return {
      rounds: [...this.records],
      remainingFailures: [...this.failures],
      attempts: this.records.length,
    }
  }
}
