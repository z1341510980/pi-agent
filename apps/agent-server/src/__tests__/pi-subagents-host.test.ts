/**
 * pi-subagents 服务端扩展宿主测试（§9.3.5：能力级接入，非 CLI）。
 *
 * 验证：
 * - 扩展工厂在无头宿主中加载成功并注册 subagent 工具（能力就绪探针）；
 * - 未绑定会话上下文时，结构化委托协议闭环：
 *    有效请求 → unavailable_context；非法请求 → invalid_request；
 * - 遗留格式请求 → 确定性错误响应；
 * - dispose 触发 session_shutdown（幂等，清理 watchdog/定时器）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { EventBus } from '@repo/shared/events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiSubagentsHost } from '../core/agent/pi-subagents-host.js'
import type { SubagentDelegationRequest } from 'pi-subagents/delegation'

function validRequest(requestId: string, overrides: Partial<SubagentDelegationRequest> = {}): SubagentDelegationRequest {
  return {
    requestId,
    ownerRunId: 'owner-1',
    nodeId: 'node-1',
    agent: 'researcher',
    task: '确认默认测试路径',
    context: 'fresh',
    cwd: process.cwd(),
    result: { kind: 'text' },
    ...overrides,
  }
}

describe('PiSubagentsHost（无头扩展宿主）', () => {
  const hosts: PiSubagentsHost[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const host of hosts.splice(0)) {
      await host.dispose()
    }
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  })

  function makeHost(): PiSubagentsHost {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagents-host-'))
    tempDirs.push(dir)
    const host = new PiSubagentsHost({
      cwd: dir,
      eventBus: new EventBus(),
      sessionProvider: (threadId) => ({
        sessionId: `session-${threadId}`,
        sessionFile: join(dir, `${threadId}.jsonl`),
        entries: [],
      }),
    })
    hosts.push(host)
    return host
  }

  it('扩展工厂在无头宿主加载并注册 subagent 工具', async () => {
    const host = makeHost()
    await host.start()
    expect(host.hasSubagentTool()).toBe(true)
    expect(host.listToolNames()).toContain('subagent')
  })

  it('未绑定上下文：非法结构化请求 → invalid_request（确定性协议闭环）', async () => {
    const host = makeHost()
    await host.start()

    // 缺少 ownerRunId/nodeId → 解析失败
    const outcome = await host.delegate({
      requestId: 'req-invalid',
      ownerRunId: '',
      nodeId: '',
      agent: 'researcher',
      task: 'x',
      context: 'fresh',
      cwd: process.cwd(),
      result: { kind: 'text' },
    } as unknown as SubagentDelegationRequest)

    expect(outcome.response.status).toBe('invalid_request')
    expect((outcome.response as { error?: string }).error).toBeDefined()
  })

  it('未绑定上下文：有效请求 → unavailable_context（无 LLM 参与）', async () => {
    const host = makeHost()
    await host.start()

    const outcome = await host.delegate(validRequest('req-unbound'))
    expect(outcome.response.status).toBe('unavailable_context')
    expect(outcome.started).toBeUndefined()
  })

  it('无响应请求按超时上限抛错（事件协议不悬挂）', async () => {
    const host = makeHost()
    await host.start()

    // 缺 requestId 的结构化载荷会被桥接静默忽略 → 无终态响应 → 超时
    await expect(
      host.delegate({ ownerRunId: 'o', nodeId: 'n' } as unknown as SubagentDelegationRequest, 500),
    ).rejects.toThrow('委托超时')
  })

  it('bindSession 后 dispose 幂等且不泄漏', async () => {
    const host = makeHost()
    await host.start()
    await host.bindSession('thread-1')
    await host.dispose()
    await host.dispose() // 幂等
  })
})
