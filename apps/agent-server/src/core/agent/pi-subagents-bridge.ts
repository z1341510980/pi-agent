/**
 * pi-subagents 可观测桥（§9.3.3 运行时适配试点）
 *
 * pi-subagents（0.49.0，MIT）在服务端暴露两个进程内注册表：
 * - registerBackgroundWorkProvider：声明"本进程正在进行的活跃工作"；
 * - registerExternalRunProvider：声明"其他运行时拥有的运行"的观测记录。
 *
 * 本模块把小说产品运行时的两类真实工作接入这两个注册表：
 * - 章节任务（workflow / discussion / ai-arrange / reverse-arrange / re-revise）
 *   来自 NovelChapterTaskRegistry（并发锁 + 任务态）；
 * - Subagent 派遣运行（AgentManager.dispatchToAgent）来自 RuntimeRunRegistry。
 *
 * 边界：注册表是进程内 Symbol.for 全局；pi-subagents 扩展宿主持有消费端。
 * 我们只做"运行时状态与资源统计"的供给侧接入（GPT 分析第 3 点的可外包部分），
 * 不引入其扩展运行时，也不改变任何调度/并发/领域语义。
 */

import { registerBackgroundWorkProvider, type BackgroundWorkProvider } from 'pi-subagents/background-work'
import { registerExternalRunProvider, type ExternalRunProvider, type ExternalRun } from 'pi-subagents/external-runs'
import type { RuntimeRunRegistry } from './runtime-run-registry.js'

export interface PiSubagentsBridge {
  /** 解除本桥注册的全部 provider（幂等） */
  dispose(): void
}

/** 章节任务供给侧的最小结构（由模块级 activeNovelChapterTasks 适配） */
export interface ChapterTaskBridgeSource {
  listActive(): Array<{ id: string; chapterKey?: string }>
}

export interface PiSubagentsBridgeDeps {
  chapterTasks?: ChapterTaskBridgeSource
  runtimeRuns?: Pick<RuntimeRunRegistry, 'list' | 'listActive'>
}

/** 章节任务 → pi-subagents BackgroundWorkItem（id = 任务 key，sessionId = 章节） */
function chapterTaskProvider(
  chapterTasks: NonNullable<PiSubagentsBridgeDeps['chapterTasks']>,
): BackgroundWorkProvider {
  return {
    name: 'novel-chapter-tasks',
    listActiveWork: () => chapterTasks.listActive().map((task) => ({
      id: task.id,
      sessionId: task.chapterKey ?? task.id,
    })),
  }
}

/** RuntimeRunRegistry → pi-subagents ExternalRun 观测记录 */
function runtimeRunProvider(
  runtimeRuns: NonNullable<PiSubagentsBridgeDeps['runtimeRuns']>,
): ExternalRunProvider {
  return {
    name: 'novel-agent-runtime',
    listExternalRuns: (): ExternalRun[] => runtimeRuns.list().map((run) => ({
      id: run.id,
      sessionId: run.sessionId,
      source: run.source,
      state: run.state,
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    })),
  }
}

/**
 * 注册供给侧 provider（幂等可重复调用：pi-subagents 注册表按 name 覆盖）。
 * 依赖缺失（插件未加载/测试环境）时对应 provider 跳过。
 */
export function createPiSubagentsBridge(deps: PiSubagentsBridgeDeps): PiSubagentsBridge {
  const disposers: Array<() => void> = []
  if (deps.chapterTasks) {
    disposers.push(registerBackgroundWorkProvider(chapterTaskProvider(deps.chapterTasks)))
  }
  if (deps.runtimeRuns) {
    disposers.push(registerExternalRunProvider(runtimeRunProvider(deps.runtimeRuns)))
  }
  return {
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 解除失败不影响其他 provider
        }
      }
    },
  }
}
