/**
 * pi-subagents 可观测桥测试（§9.3.3）：
 * - RuntimeRunRegistry 起止/终态/列表语义；
 * - createPiSubagentsBridge 把章节任务与运行时运行注册为
 *   pi-subagents 的 background-work / external-runs provider；
 * - dispose 幂等解除注册。
 */
import { describe, expect, it } from 'vitest'
import {
  listBackgroundWorkProviders,
  snapshotBackgroundWork,
} from 'pi-subagents/background-work'
import { snapshotExternalRuns } from 'pi-subagents/external-runs'
import { RuntimeRunRegistry } from '../core/agent/runtime-run-registry.js'
import { createPiSubagentsBridge } from '../core/agent/pi-subagents-bridge.js'

describe('RuntimeRunRegistry', () => {
  it('start/finish/list/listActive 语义', () => {
    const registry = new RuntimeRunRegistry()
    registry.start({ id: 'run-1', sessionId: 's-1', source: 'subagent-dispatch' })
    registry.start({ id: 'run-2', sessionId: 's-2', source: 'novel-task' })

    expect(registry.listActive().map(r => r.id)).toEqual(['run-1', 'run-2'])

    registry.finish('run-1', 'completed')
    expect(registry.listActive().map(r => r.id)).toEqual(['run-2'])
    const done = registry.list().find(r => r.id === 'run-1')!
    expect(done.state).toBe('completed')
    expect(done.completedAt).toBeDefined()

    registry.finish('run-2', 'failed')
    expect(registry.listActive()).toHaveLength(0)
    expect(registry.list()).toHaveLength(2)
  })
})

describe('createPiSubagentsBridge', () => {
  it('把章节任务注册为 background-work provider，可按会话快照', () => {
    const bridge = createPiSubagentsBridge({
      chapterTasks: {
        listActive: () => [
          { id: 'p1:3', chapterKey: 'p1:3' },
          { id: 'p2:7', chapterKey: 'p2:7' },
        ],
      },
    })

    const providers = listBackgroundWorkProviders()
    expect(providers.map(p => p.name)).toContain('novel-chapter-tasks')

    const snapshot = snapshotBackgroundWork('p1:3')
    expect(snapshot.providers).toContain('novel-chapter-tasks')
    expect(snapshot.items).toEqual([
      { provider: 'novel-chapter-tasks', id: 'p1:3', sessionId: 'p1:3' },
    ])

    bridge.dispose()
    expect(listBackgroundWorkProviders().map(p => p.name)).not.toContain('novel-chapter-tasks')
  })

  it('把运行时运行注册为 external-runs provider，含状态转移', () => {
    const runs = new RuntimeRunRegistry()
    runs.start({ id: 'sub-1', sessionId: 'sub-1', source: 'subagent-dispatch' })
    const bridge = createPiSubagentsBridge({ runtimeRuns: runs })

    const observed = snapshotExternalRuns('sub-1')
    expect(observed.map(r => r.id)).toContain('sub-1')
    expect(observed.find(r => r.id === 'sub-1')!.state).toBe('running')

    runs.finish('sub-1', 'completed')
    const after = snapshotExternalRuns('sub-1').find(r => r.id === 'sub-1')!
    expect(after.state).toBe('completed')
    expect(after.completedAt).toBeDefined()

    bridge.dispose()
    expect(snapshotExternalRuns('sub-1')).toHaveLength(0)
  })

  it('依赖缺失时跳过对应 provider，dispose 幂等', () => {
    const bridge = createPiSubagentsBridge({})
    expect(() => bridge.dispose()).not.toThrow()
    bridge.dispose()
  })
})
