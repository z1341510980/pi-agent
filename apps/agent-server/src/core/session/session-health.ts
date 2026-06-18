import { access, readFile, writeFile } from 'node:fs/promises'

export interface SessionHealth {
  healthy: boolean
  recentErrors: number
  totalChecked: number
  exists: boolean
}

export type SessionEntry = {
  id?: string
  role?: string
  stopReason?: string
  toolCallId?: string
  toolCalls?: Array<{ id?: string }>
  [key: string]: unknown
}

export interface SessionHealthOptions {
  lookback?: number
  errorThreshold?: number
}

const DEFAULT_LOOKBACK = 10
const DEFAULT_ERROR_THRESHOLD = 3

export async function evaluateSessionHealth(
  sessionPath: string,
  options: SessionHealthOptions = {}
): Promise<SessionHealth> {
  const exists = await fileExists(sessionPath)
  if (!exists) {
    return {
      exists: false,
      healthy: true,
      recentErrors: 0,
      totalChecked: 0
    }
  }

  const entries = await readSessionEntries(sessionPath)
  if (!entries) {
    return {
      exists: true,
      healthy: true,
      recentErrors: 0,
      totalChecked: 0
    }
  }

  const lookback = options.lookback ?? DEFAULT_LOOKBACK
  const errorThreshold = options.errorThreshold ?? DEFAULT_ERROR_THRESHOLD
  const assistantEntries = entries.filter((entry) => entry.role === 'assistant').slice(-lookback)
  const recentErrors = assistantEntries.filter((entry) => entry.stopReason === 'error').length

  return {
    exists: true,
    healthy: recentErrors < errorThreshold,
    recentErrors,
    totalChecked: assistantEntries.length
  }
}

export function repairOrphanToolResultEntries(entries: SessionEntry[]): {
  entries: SessionEntry[]
  removed: number
} {
  const knownToolCallIds = new Set<string>()

  for (const entry of entries) {
    if (entry.role !== 'assistant') continue
    for (const toolCall of entry.toolCalls ?? []) {
      if (toolCall.id) {
        knownToolCallIds.add(toolCall.id)
      }
    }
  }

  const repairedEntries = entries.filter((entry) => {
    if (entry.role !== 'tool') return true
    if (!entry.toolCallId) return true
    return knownToolCallIds.has(entry.toolCallId)
  })

  return {
    entries: repairedEntries,
    removed: entries.length - repairedEntries.length
  }
}

export async function repairOrphanToolResultEntriesInFile(
  sessionPath: string
): Promise<{ repaired: boolean; removed: number }> {
  const entries = await readSessionEntries(sessionPath)
  if (!entries) {
    return { repaired: false, removed: 0 }
  }

  const result = repairOrphanToolResultEntries(entries)
  if (result.removed === 0) {
    return { repaired: false, removed: 0 }
  }

  await writeFile(
    sessionPath,
    result.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8'
  )

  return { repaired: true, removed: result.removed }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readSessionEntries(path: string): Promise<SessionEntry[] | null> {
  try {
    const content = await readFile(path, 'utf8')
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length)
    return lines.map((line) => JSON.parse(line) as SessionEntry)
  } catch {
    return null
  }
}
