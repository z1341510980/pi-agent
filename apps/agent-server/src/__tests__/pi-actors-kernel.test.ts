/**
 * pi-actors 长任务 Run 内核接入测试（§9.3.4：能力级接入，非 CLI）。
 *
 * 真实 spawn 本地 node 进程：
 * - 短命令跑完 → waitForTerminal 终态 + stdout 输出留痕；
 * - 长驻进程 → cancel 终态；
 * - RuntimeRunRegistry 观测接线：spawn 记 running、终态记 completed/stopped，
 *   并经 pi-subagents external-runs 桥可见。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiActorsKernel } from '../core/agent/pi-actors-kernel.js'
import { RuntimeRunRegistry } from '../core/agent/runtime-run-registry.js'
import { createPiSubagentsBridge } from '../core/agent/pi-subagents-bridge.js'
import { snapshotExternalRuns } from 'pi-subagents/external-runs'

describe('PiActorsKernel（能力级接入）', () => {
  const tempDirs: string[] = []
  const handles: Array<{ kill: () => Record<string, unknown> }> = []

  afterEach(() => {
    for (const handle of handles.splice(0)) {
      try { handle.kill() } catch { /* 已终态 */ }
    }
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  })

  function writeScript(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'pi-actors-kernel-'))
    tempDirs.push(dir)
    const script = join(dir, 'job.js')
    writeFileSync(script, content)
    return script
  }

  it('spawn 短命令 → 终态 + stdout 留痕 + 观测接线', async () => {
    const okScript = writeScript('console.log("pi-actors-ok")')

    const runtimeRuns = new RuntimeRunRegistry()
    const bridge = createPiSubagentsBridge({ runtimeRuns })
    const kernel = new PiActorsKernel({ runtimeRuns })

    const handle = kernel.spawn({ template: `node ${okScript}`, name: 'kernel-ok-test' })
    handles.push(handle)

    // spawn 即进入观测（running）
    expect(runtimeRuns.listActive().map(r => r.id)).toContain(handle.runId)
    expect(snapshotExternalRuns(handle.runId).map(r => r.id)).toContain(handle.runId)

    const final = await handle.waitForTerminal({ timeoutMs: 30_000 })
    expect(['done', 'exited']).toContain(final)
    expect(handle.stdoutTail(20)).toContain('pi-actors-ok')

    // 终态后观测更新为 completed
    const recorded = runtimeRuns.list().find(r => r.id === handle.runId)!
    expect(recorded.state).toBe('completed')
    expect(recorded.completedAt).toBeDefined()

    bridge.dispose()
  })

  it('长驻进程 cancel → 终态（cancelled/killed）且不再 active', async () => {
    const hangScript = writeScript('setInterval(() => {}, 1000)')

    const runtimeRuns = new RuntimeRunRegistry()
    const kernel = new PiActorsKernel({ runtimeRuns })

    const handle = kernel.spawn({ template: `node ${hangScript}`, name: 'kernel-hang-test' })
    handles.push(handle)

    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await handle.status()).status).toBe('running')
    handle.cancel()

    const final = await handle.waitForTerminal({ timeoutMs: 20_000 })
    expect(['cancelled', 'killed', 'exited', 'done']).toContain(final)
    expect(runtimeRuns.listActive().map(r => r.id)).not.toContain(handle.runId)
  })

  it('未接入观测注册表时静默运行（kernel 可独立使用）', async () => {
    const okScript = writeScript('console.log("standalone")')
    const kernel = new PiActorsKernel()
    const handle = kernel.spawn({ template: `node ${okScript}` })
    handles.push(handle)
    const final = await handle.waitForTerminal({ timeoutMs: 30_000 })
    expect(['done', 'exited']).toContain(final)
    expect(handle.stdoutTail(20)).toContain('standalone')
  })
})
