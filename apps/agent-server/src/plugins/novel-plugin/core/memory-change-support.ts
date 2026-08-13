import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { NovelStore } from './novel-store.js'
import type { MemoryOperationRecord } from './memory-operation-ledger.js'

export interface MemoryOperationCollector {
  push(op: Omit<MemoryOperationRecord, 'seq'>): void
}

export interface MemoryApplyContext {
  projectId: string
  chapterNumber?: number
  store: NovelStore
  logger: PluginContext['logger']
  audit?: MemoryOperationCollector
}

export function auditOp(): {
  create: (
    targetType: string,
    targetId: string,
    afterJson?: unknown,
    reason?: string
  ) => Omit<MemoryOperationRecord, 'seq'>
  update: (
    targetType: string,
    targetId: string,
    beforeJson: unknown,
    afterJson: unknown,
    reason?: string
  ) => Omit<MemoryOperationRecord, 'seq'>
  link: (
    targetType: string,
    targetId: string,
    relatedType: string,
    relatedId: string,
    reason?: string
  ) => Omit<MemoryOperationRecord, 'seq'>
  unlink: (
    targetType: string,
    targetId: string,
    relatedType: string,
    relatedId: string,
    reason?: string
  ) => Omit<MemoryOperationRecord, 'seq'>
} {
  return {
    create: (targetType, targetId, afterJson, reason) => ({
      operation: 'create',
      targetType,
      targetId,
      afterJson: afterJson !== undefined ? JSON.stringify(afterJson) : null,
      reason
    }),
    update: (targetType, targetId, beforeJson, afterJson, reason) => ({
      operation: 'update',
      targetType,
      targetId,
      beforeJson: beforeJson !== undefined ? JSON.stringify(beforeJson) : null,
      afterJson: afterJson !== undefined ? JSON.stringify(afterJson) : null,
      reason
    }),
    link: (targetType, targetId, relatedType, relatedId, reason) => ({
      operation: 'link',
      targetType,
      targetId,
      relatedType,
      relatedId,
      reason
    }),
    unlink: (targetType, targetId, relatedType, relatedId, reason) => ({
      operation: 'unlink',
      targetType,
      targetId,
      relatedType,
      relatedId,
      reason
    })
  }
}

export function fieldsBefore<T extends object>(entity: T, patch: Partial<T>): Partial<T> {
  const before: Partial<T> = {}
  for (const key of Object.keys(patch) as Array<keyof T>) {
    before[key] = entity[key]
  }
  return before
}

export function fieldsAfter<T extends object>(
  entity: T | undefined,
  patch: Partial<T>
): Partial<T> {
  return entity ? fieldsBefore(entity, patch) : patch
}

export function ensureString(value: unknown, defaultValue: string): string {
  if (typeof value === 'string') return value
  if (value == null) return defaultValue
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function ensureNumber(value: unknown, defaultValue: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return defaultValue
}
