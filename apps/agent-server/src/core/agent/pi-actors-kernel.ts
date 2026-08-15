/**
 * pi-actors 长任务 Run 内核接入（§9.3.4：能力级接入，非 CLI）
 *
 * @llblab/pi-actors 的 Run 内核（dist/lib/async-runs）是宿主无关的：
 * 只依赖 Node 内置模块与包内模块，导出 startRun / getRunStatus / listRuns /
 * tailRun / cancelRun / killRun 等独立函数。本模块把它们封装为服务端可用的
 * 长任务内核：spawn 本地命令/Recipe → 轮询状态 → 读 Trace/输出 → 取消/终止。
 *
 * 定位（GPT 评审第 3 条边界）：
 * - 承担「后台运行 / 运行状态与资源统计 / steer-cancel-inspect」这类运行时基础设施；
 * - 不承担小说工作流阶段、认知隔离、检查点、领域账本（仍由编排器自持）；
 * - Run 是本地进程执行（非 LLM 会话），适用于导出、脚本化批处理、长构建等作业。
 *
 * 观测接线：spawn 的 Run 会同步写入 RuntimeRunRegistry（source='pi-actors-run'），
 * 从而自动进入 pi-subagents external-runs 可观测桥（§9.3.3）。
 */

import {
  startRun,
  getRunStatus,
  listRuns,
  cancelRun,
  killRun,
  type AsyncRunStatus,
} from '@llblab/pi-actors/dist/lib/async-runs.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeRunRegistry } from './runtime-run-registry.js'

export interface PiActorsRunSpec {
  /** 命令模板：直接命令字符串（如 `node -e "..."`）或包内 Recipe 引用 */
  template: string
  /** Run 名称（Recipe 身份，默认取 runId） */
  name?: string
  /** 命令参数 */
  args?: string[]
  /** 模板值替换 */
  values?: Record<string, unknown>
  /** 工作目录（默认 process.cwd()） */
  cwd?: string
}

export interface PiActorsRunStatus {
  status: AsyncRunStatus
  detail: Record<string, unknown>
}

export interface PiActorsRunHandle {
  readonly runId: string
  /** 读取当前状态（running/done/failed/exited/cancelled/killed） */
  status(): Promise<PiActorsRunStatus>
  /** 读取 stdout.log 输出尾部（Run 输出留痕） */
  stdoutTail(lines?: number): string
  /** 请求取消（graceful） */
  cancel(): Record<string, unknown>
  /** 强制终止（recovery path） */
  kill(): Record<string, unknown>
  /** 轮询等待终态；超时返回 'running' */
  waitForTerminal(options?: { timeoutMs?: number; pollMs?: number }): Promise<AsyncRunStatus>
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 250

export class PiActorsKernel {
  constructor(
    private readonly options: {
      /** 观测注册表：spawn/finish 同步写入（可选） */
      runtimeRuns?: Pick<RuntimeRunRegistry, 'start' | 'finish'>
    } = {},
  ) {}

  spawn(spec: PiActorsRunSpec): PiActorsRunHandle {
    const meta = startRun(
      {
        template: spec.template,
        ...(spec.name ? { name: spec.name } : {}),
        ...(spec.args && spec.args.length > 0 ? { args: spec.args } : {}),
        ...(spec.values ? { values: spec.values } : {}),
      },
      spec.cwd ?? process.cwd(),
    )
    const runId = meta.run
    const stateDir = meta.state_dir
    const runtimeRuns = this.options.runtimeRuns
    runtimeRuns?.start({
      id: runId,
      sessionId: runId,
      source: 'pi-actors-run',
    })

    const handle: PiActorsRunHandle = {
      runId,
      async status(): Promise<PiActorsRunStatus> {
        const detail = getRunStatus(runId)
        const status = (detail.status as AsyncRunStatus) ?? 'running'
        if (status !== 'running') {
          runtimeRuns?.finish(runId, status === 'done' || status === 'exited' ? 'completed' : status === 'cancelled' ? 'stopped' : 'failed')
        }
        return { status, detail }
      },
      stdoutTail(lines = 40): string {
        try {
          const content = readFileSync(join(stateDir, 'stdout.log'), 'utf-8')
          const all = content.split(/\r?\n/).filter(line => line.length > 0)
          return all.slice(-lines).join('\n')
        } catch {
          return ''
        }
      },
      cancel(): Record<string, unknown> {
        return cancelRun(runId)
      },
      kill(): Record<string, unknown> {
        return killRun(runId)
      },
      async waitForTerminal(options = {}): Promise<AsyncRunStatus> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
        const pollMs = options.pollMs ?? DEFAULT_POLL_MS
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const { status } = await handle.status()
          if (status !== 'running') return status
          if (Date.now() >= deadline) return 'running'
          await new Promise((resolve) => setTimeout(resolve, pollMs))
        }
      },
    }
    return handle
  }

  /** 列出内核已知的全部 Run（含已终态） */
  list(statusFilter?: string): Array<Record<string, unknown>> {
    return listRuns(undefined, statusFilter)
  }
}
