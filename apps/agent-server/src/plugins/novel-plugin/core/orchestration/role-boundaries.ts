import type { CreationOptions, CreationResult, FinalizeParams } from '../chapter-finalizer.js'
import type { QualityGateFailureItem, RevisionRoundRecord } from '@repo/shared/novel'
import type { RevisionController } from '../quality/revision-controller.js'

export interface DirectorPlannerInput {
  projectId: string
  chapterNumber: number
  prompt: string
  options: CreationOptions
  overrides?: unknown
}

export interface DirectorPlanner {
  plan(input: DirectorPlannerInput): Promise<string>
}

export interface WriterRunnerInput {
  projectId: string
  chapterNumber: number
  prompt: string
  options: CreationOptions
  overrides?: unknown
}

export interface WriterRunner {
  run(input: WriterRunnerInput): Promise<string>
}

export interface QualityGateInspection {
  failures: QualityGateFailureItem[]
  report: unknown
  clicheHits: unknown[]
}

export interface QualityGate {
  inspect(content: string): QualityGateInspection
}

export interface RevisionControllerFactory {
  create(maxRounds: number): RevisionController
}

export interface MemoryFinalizer {
  finalize(params: FinalizeParams): Promise<CreationResult>
}

export interface NovelRoleBoundaries {
  director: DirectorPlanner
  writer: WriterRunner
  qualityGate: QualityGate
  revisionController: RevisionControllerFactory
  memory: MemoryFinalizer
}

export function createRoleBoundaryNames(): string[] {
  return ['DirectorPlanner', 'WriterRunner', 'QualityGate', 'RevisionController', 'MemoryFinalizer']
}
