import {
  findCreationRunStagePath,
  type CreateCreationRunInput,
  type CreationRunCommand,
  type CreationRunStage,
  type CreationRunState,
} from './creation-run-state.js'
import { CreationRunStore, type CreationRunEvent } from './creation-run-store.js'
import {
  CreationRunMetricsStore,
  type CreationRunMetricsInput,
} from './creation-run-metrics-store.js'

export type CreationCheckpointDecision = 'approve' | 'revise' | 'rewrite' | 'reject'

const PHASE_STAGE: Partial<Record<string, CreationRunStage>> = {
  directing: 'planning',
  checkpoint_narrative: 'planning',
  writing: 'writing',
  acting: 'acting',
  arranging: 'arranging',
  reviewing: 'reviewing',
  checkpoint_review: 'reviewing',
  revising: 'revising',
  memory: 'finalizing',
}

/** Application service that translates legacy flow callbacks into the shared run kernel. */
export class CreationRunLifecycle {
  constructor(
    private readonly store: CreationRunStore,
    private readonly metrics?: CreationRunMetricsStore,
  ) {}

  start(input: CreateCreationRunInput, now?: number): CreationRunState {
    const created = this.store.create(input)
    return this.store.dispatch(input.runId, { type: 'start', stage: created.stage }, now ?? created.createdAt)
  }

  observePhase(runId: string, phase: string, now: number = Date.now()): CreationRunState | undefined {
    const target = PHASE_STAGE[phase]
    if (!target) return this.store.get(runId)
    const current = this.store.get(runId)
    if (!current || current.status === 'waiting_input') return current
    if (current.stage === target) return current
    if (target === 'revising' && (current.status === 'running' || current.status === 'revising')) {
      return this.store.dispatch(runId, { type: 'begin_revision', reason: `进入 ${phase} 阶段` }, now)
    }
    return this.moveToStage(runId, target, now)
  }

  awaitCheckpoint(runId: string, checkpointId: string, now?: number): CreationRunState {
    return this.store.dispatch(runId, { type: 'await_input', checkpointId }, now)
  }

  resolveCheckpoint(
    runId: string,
    checkpointId: string,
    decision: CreationCheckpointDecision,
    options: { resumeStage?: CreationRunStage; reason?: string; resumeWithoutRevision?: boolean } = {},
    now: number = Date.now(),
  ): CreationRunState {
    const current = this.store.get(runId)
    if (!current || current.status !== 'waiting_input' || current.checkpointId !== checkpointId) {
      throw new Error(`Stale or unknown checkpoint for creation run: ${checkpointId}`)
    }
    if (decision === 'reject') {
      return this.store.dispatch(runId, { type: 'cancel', reason: options.reason }, now)
    }
    if (options.resumeWithoutRevision) {
      return this.store.dispatch(
        runId,
        { type: 'resume', stage: options.resumeStage ?? current.stage, decision },
        now,
      )
    }
    if (decision === 'revise' || decision === 'rewrite') {
      return this.store.dispatch(
        runId,
        { type: 'begin_revision', reason: options.reason ?? `checkpoint decision: ${decision}` },
        now,
      )
    }
    return this.store.dispatch(
      runId,
      { type: 'resume', stage: options.resumeStage ?? current.stage, decision },
      now,
    )
  }

  finish(
    runId: string,
    result: {
      status: 'completed' | 'cancelled' | 'error'
      error?: string
      metrics?: CreationRunMetricsInput
    },
    now: number = Date.now(),
  ): CreationRunState {
    const current = this.store.get(runId)
    if (!current) throw new Error(`Creation run not found: ${runId}`)
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      const expectedStatus = result.status === 'error' ? 'failed' : result.status
      if (current.status === expectedStatus) return current
      throw new Error(`Creation run already finished as ${current.status}`)
    }
    let state: CreationRunState
    if (result.status === 'cancelled') {
      state = this.store.dispatch(runId, { type: 'cancel', reason: result.error }, now)
    } else if (result.status === 'error') {
      state = this.store.dispatch(runId, { type: 'fail', reason: result.error ?? 'Creation run failed' }, now)
    } else {
      this.moveToStage(runId, 'finalizing', now)
      state = this.store.dispatch(runId, { type: 'complete' }, now)
    }
    if (result.metrics) this.recordMetrics(runId, result.metrics, now)
    return state
  }

  recordMetrics(
    runId: string,
    metrics: CreationRunMetricsInput,
    now: number = Date.now(),
  ): void {
    if (!this.metrics) return
    const state = this.store.get(runId)
    if (!state) throw new Error(`Creation run not found: ${runId}`)
    this.metrics.upsert(
      { runId: state.runId, projectId: state.projectId, chapterNumber: state.chapterNumber },
      metrics,
      now,
    )
  }

  reconcileInterruptedRuns(reason: string, now: number = Date.now()): number {
    return this.store.reconcileInterruptedRuns(reason, now)
  }

  get(runId: string): CreationRunState | undefined {
    return this.store.get(runId)
  }

  events(runId: string, fromSeq = 1): CreationRunEvent[] {
    return this.store.events(runId, fromSeq)
  }

  private moveToStage(runId: string, target: CreationRunStage, now: number): CreationRunState {
    const current = this.store.get(runId)
    if (!current) throw new Error(`Creation run not found: ${runId}`)
    const path = findCreationRunStagePath(current.stage, target)
    if (!path) throw new Error(`No creation run stage path: ${current.stage} -> ${target}`)
    let next = current
    for (const stage of path) {
      next = this.store.dispatch(runId, { type: 'advance', stage }, now)
    }
    return next
  }
}

export type { CreationRunCommand }
