/**
 * 运行时运行注册表：进程内观测记录（§9.3.3 pi-subagents 可观测桥的数据源）。
 *
 * 记录两类真实工作：
 * - Subagent 派遣（AgentManager.dispatchToAgent）；
 * - 其他需要"运行状态与资源统计"暴露给 pi-subagents 观察端的运行。
 *
 * 纯内存、无领域语义：不参与调度/并发/取消决策，只供外部观测。
 */

export type RuntimeRunState = 'running' | 'completed' | 'failed' | 'stopped'

export interface RuntimeRunRecord {
  id: string
  sessionId: string
  source: string
  state: RuntimeRunState
  startedAt?: number
  completedAt?: number
}

export class RuntimeRunRegistry {
  private readonly runs = new Map<string, RuntimeRunRecord>()

  start(input: { id: string; sessionId: string; source: string; startedAt?: number }): void {
    this.runs.set(input.id, {
      id: input.id,
      sessionId: input.sessionId,
      source: input.source,
      state: 'running',
      startedAt: input.startedAt ?? Date.now(),
    })
  }

  finish(id: string, state: Exclude<RuntimeRunState, 'running'>, completedAt?: number): void {
    const run = this.runs.get(id)
    if (!run) return
    run.state = state
    run.completedAt = completedAt ?? Date.now()
  }

  /** 最近完成的运行也保留（供观察端读取退出码/耗时等终态信息） */
  list(): RuntimeRunRecord[] {
    return Array.from(this.runs.values())
  }

  listActive(): RuntimeRunRecord[] {
    return Array.from(this.runs.values()).filter((run) => run.state === 'running')
  }
}
