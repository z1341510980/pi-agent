import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  evaluateSessionHealth,
  repairOrphanToolResultEntries,
  repairOrphanToolResultEntriesInFile,
  type SessionEntry
} from '../core/session/session-health.js'

describe('session health', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-session-health-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('missing file is treated as healthy and non-existing', async () => {
    const result = await evaluateSessionHealth(join(dir, 'missing.jsonl'))

    expect(result).toEqual({
      exists: false,
      healthy: true,
      recentErrors: 0,
      totalChecked: 0
    })
  })

  it('marks the session unhealthy when recent assistant errors reach the threshold', async () => {
    const sessionPath = join(dir, 'session.jsonl')
    await writeJsonl(sessionPath, [
      assistantEntry('a1', 'ok'),
      assistantEntry('a2', 'error'),
      assistantEntry('a3', 'error'),
      assistantEntry('a4', 'error')
    ])

    const result = await evaluateSessionHealth(sessionPath, {
      lookback: 10,
      errorThreshold: 3
    })

    expect(result.exists).toBe(true)
    expect(result.healthy).toBe(false)
    expect(result.recentErrors).toBe(3)
    expect(result.totalChecked).toBe(4)
  })

  it('treats malformed JSONL as healthy so valid sessions are not blocked', async () => {
    const sessionPath = join(dir, 'bad.jsonl')
    await writeFile(sessionPath, '{"id":"ok"}\nnot-json\n', 'utf8')

    const result = await evaluateSessionHealth(sessionPath)

    expect(result.exists).toBe(true)
    expect(result.healthy).toBe(true)
    expect(result.recentErrors).toBe(0)
    expect(result.totalChecked).toBe(0)
  })

  it('removes orphan tool result entries without a matching assistant tool call', () => {
    const entries: SessionEntry[] = [
      userEntry('u1'),
      assistantEntry('a1', 'ok', ['tc-1']),
      toolEntry('t1', 'tc-1'),
      toolEntry('t2', 'tc-orphan')
    ]

    const result = repairOrphanToolResultEntries(entries)

    expect(result.removed).toBe(1)
    expect(result.entries.map((entry) => entry.id)).toEqual(['u1', 'a1', 't1'])
  })

  it('rewrites JSONL only when orphan tool results are removed', async () => {
    const sessionPath = join(dir, 'repair.jsonl')
    await writeJsonl(sessionPath, [
      assistantEntry('a1', 'ok', ['tc-1']),
      toolEntry('t1', 'tc-1'),
      toolEntry('t2', 'tc-orphan')
    ])

    const repaired = await repairOrphanToolResultEntriesInFile(sessionPath)
    const contents = await readFile(sessionPath, 'utf8')

    expect(repaired).toEqual({ repaired: true, removed: 1 })
    expect(contents).toContain('"id":"t1"')
    expect(contents).not.toContain('tc-orphan')

    const second = await repairOrphanToolResultEntriesInFile(sessionPath)
    expect(second).toEqual({ repaired: false, removed: 0 })
  })
})

async function writeJsonl(path: string, entries: SessionEntry[]) {
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
}

function userEntry(id: string): SessionEntry {
  return { id, role: 'user', content: 'hello' }
}

function assistantEntry(id: string, stopReason: string, toolCallIds: string[] = []): SessionEntry {
  return {
    id,
    role: 'assistant',
    stopReason,
    toolCalls: toolCallIds.map((toolCallId) => ({
      id: toolCallId,
      type: 'function',
      function: { name: 'read', arguments: '{}' }
    }))
  }
}

function toolEntry(id: string, toolCallId: string): SessionEntry {
  return { id, role: 'tool', toolCallId, content: 'result' }
}
