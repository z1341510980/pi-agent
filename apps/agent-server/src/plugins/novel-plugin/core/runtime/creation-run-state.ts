/** Stable lifecycle states shared by chapter workflow, discussion, and arrange runs. */
export type CreationRunStatus =
  | 'submitted'
  | 'running'
  | 'waiting_input'
  | 'revising'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type CreationRunStage =
  | 'planning'
  | 'writing'
  | 'acting'
  | 'arranging'
  | 'reviewing'
  | 'revising'
  | 'finalizing'

export type CreationRunMode = 'workflow' | 'discussion' | 'arrange' | 'reverse'

export interface CreationRunState {
  runId: string
  projectId: string
  chapterNumber: number
  mode: CreationRunMode
  status: CreationRunStatus
  stage: CreationRunStage
  revision: number
  checkpointId?: string
  error?: string
  createdAt: number
  updatedAt: number
}

export interface CreateCreationRunInput {
  runId: string
  projectId: string
  chapterNumber: number
  mode: CreationRunMode
  initialStage?: CreationRunStage
  createdAt?: number
}

export type CreationRunCommand =
  | { type: 'start'; stage: CreationRunStage }
  | { type: 'advance'; stage: CreationRunStage }
  | { type: 'await_input'; checkpointId: string }
  | { type: 'resume'; stage: CreationRunStage; decision?: 'approve' | 'revise' | 'rewrite' }
  | { type: 'begin_revision'; reason: string }
  | { type: 'complete' }
  | { type: 'fail'; reason: string }
  | { type: 'cancel'; reason?: string }

export interface CreationRunTransitionEvent {
  type: CreationRunCommand['type']
  previousStatus: CreationRunStatus
  previousStage: CreationRunStage
  status: CreationRunStatus
  stage: CreationRunStage
  revision: number
  checkpointId?: string
  error?: string
  createdAt: number
}

export interface CreationRunTransition {
  state: CreationRunState
  event: CreationRunTransitionEvent
}

const TERMINAL_STATUSES = new Set<CreationRunStatus>(['completed', 'failed', 'cancelled'])

const ALLOWED_STAGE_TRANSITIONS: Record<CreationRunStage, ReadonlySet<CreationRunStage>> = {
  planning: new Set(['planning', 'writing', 'acting', 'arranging', 'revising']),
  writing: new Set(['writing', 'acting', 'reviewing', 'revising', 'finalizing']),
  acting: new Set(['acting', 'reviewing', 'revising', 'finalizing']),
  arranging: new Set(['arranging', 'reviewing', 'finalizing']),
  reviewing: new Set(['reviewing', 'revising', 'finalizing', 'planning']),
  revising: new Set(['revising', 'writing', 'reviewing', 'planning', 'finalizing']),
  finalizing: new Set(['finalizing']),
}

export function createCreationRun(input: CreateCreationRunInput): CreationRunState {
  const createdAt = input.createdAt ?? Date.now()
  return {
    runId: input.runId,
    projectId: input.projectId,
    chapterNumber: input.chapterNumber,
    mode: input.mode,
    status: 'submitted',
    stage: input.initialStage ?? (input.mode === 'arrange' || input.mode === 'reverse' ? 'arranging' : 'planning'),
    revision: 0,
    createdAt,
    updatedAt: createdAt,
  }
}

export function findCreationRunStagePath(
  from: CreationRunStage,
  to: CreationRunStage,
): CreationRunStage[] | undefined {
  if (from === to) return []
  const pending: Array<{ stage: CreationRunStage; path: CreationRunStage[] }> = [{ stage: from, path: [] }]
  const visited = new Set<CreationRunStage>([from])
  while (pending.length > 0) {
    const current = pending.shift()!
    for (const next of ALLOWED_STAGE_TRANSITIONS[current.stage]) {
      if (visited.has(next)) continue
      const path = [...current.path, next]
      if (next === to) return path
      visited.add(next)
      pending.push({ stage: next, path })
    }
  }
  return undefined
}

/** Pure lifecycle transition. Persistence and side effects belong to the run service. */
export function transitionCreationRun(
  current: CreationRunState,
  command: CreationRunCommand,
  now: number = Date.now(),
): CreationRunTransition {
  if (TERMINAL_STATUSES.has(current.status)) {
    throw new Error(`Cannot transition terminal creation run: ${current.status}`)
  }

  let next: CreationRunState
  switch (command.type) {
    case 'start':
      requireStatus(current, 'submitted', command.type)
      requireStage(current.stage, command.stage, command.type)
      next = { ...current, status: 'running', stage: command.stage }
      break
    case 'advance':
      if (current.status !== 'running' && current.status !== 'revising') {
        throw invalidTransition(current, command.type)
      }
      requireStage(current.stage, command.stage, command.type)
      next = { ...current, status: 'running', stage: command.stage, checkpointId: undefined }
      break
    case 'await_input':
      requireStatus(current, 'running', command.type)
      if (!command.checkpointId.trim()) throw new Error('checkpointId must not be empty')
      next = { ...current, status: 'waiting_input', checkpointId: command.checkpointId }
      break
    case 'resume':
      requireStatus(current, 'waiting_input', command.type)
      requireStage(current.stage, command.stage, command.type)
      next = { ...current, status: command.stage === 'revising' ? 'revising' : 'running', stage: command.stage, checkpointId: undefined }
      break
    case 'begin_revision':
      if (current.status !== 'running' && current.status !== 'waiting_input' && current.status !== 'revising') {
        throw invalidTransition(current, command.type)
      }
      if (!command.reason.trim()) throw new Error('revision reason must not be empty')
      requireStage(current.stage, 'revising', command.type)
      next = {
        ...current,
        status: 'revising',
        stage: 'revising',
        revision: current.revision + 1,
        checkpointId: undefined,
      }
      break
    case 'complete':
      if (current.status !== 'running' && current.status !== 'revising') {
        throw invalidTransition(current, command.type)
      }
      requireStage(current.stage, 'finalizing', command.type)
      next = { ...current, status: 'completed', stage: 'finalizing', checkpointId: undefined }
      break
    case 'fail':
      if (!command.reason.trim()) throw new Error('failure reason must not be empty')
      next = { ...current, status: 'failed', error: command.reason, checkpointId: undefined }
      break
    case 'cancel':
      next = {
        ...current,
        status: 'cancelled',
        ...(command.reason?.trim() ? { error: command.reason } : {}),
        checkpointId: undefined,
      }
      break
  }

  next.updatedAt = now
  return {
    state: next,
    event: {
      type: command.type,
      previousStatus: current.status,
      previousStage: current.stage,
      status: next.status,
      stage: next.stage,
      revision: next.revision,
      checkpointId: next.checkpointId,
      error: next.error,
      createdAt: now,
    },
  }
}

function requireStatus(
  current: CreationRunState,
  expected: CreationRunStatus,
  command: CreationRunCommand['type'],
): void {
  if (current.status !== expected) throw invalidTransition(current, command)
}

function requireStage(
  currentStage: CreationRunStage,
  nextStage: CreationRunStage,
  command: CreationRunCommand['type'],
): void {
  if (!ALLOWED_STAGE_TRANSITIONS[currentStage].has(nextStage)) {
    throw new Error(`invalid stage transition: ${currentStage} -> ${nextStage} (${command})`)
  }
}

function invalidTransition(current: CreationRunState, command: CreationRunCommand['type']): Error {
  return new Error(`invalid creation run transition: ${current.status}/${current.stage} -> ${command}`)
}
