import type { CheckpointData, CreationResult } from '@repo/shared/novel'

export function selectHasPendingCheckpoint(checkpoint: CheckpointData | null): boolean {
  return checkpoint != null
}

export function selectCanResume(result: CreationResult | null): boolean {
  return result?.canResume === true
}

export function selectResultContent(result: CreationResult | null, fallback = ''): string {
  return result?.content ?? fallback
}
