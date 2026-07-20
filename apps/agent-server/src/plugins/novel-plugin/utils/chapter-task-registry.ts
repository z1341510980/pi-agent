/**
 * 章节任务注册表 - 创作流程共享状态
 *
 * 拆分自原 novel-routes.ts（PR-6），用于跨子路由共享章节任务互斥锁和 abort 控制器。
 * 必须保持模块级单例语义：Node.js ESM 模块缓存确保 Map/Set 在多子路由文件间共享同一实例。
 */

/** 同一章节 ai-arrange 并发锁，key 为 `${projectId}:${chapterNumber}` */
export const aiArrangeLocks = new Map<string, Promise<void>>()

/** 同一章节正文创作互斥锁，create-flow 与 create-discussion 共用。 */
export const chapterCreationLocks = new Set<string>()

/** 章节任务类型 */
export type NovelChapterTaskKind = 'workflow' | 'discussion' | 'discussion-resume' | 'ai-arrange' | 'reverse-arrange'

/** 运行中的章节任务 */
export interface ActiveNovelChapterTask {
  kind: NovelChapterTaskKind
  controller: AbortController
  startedAt: number
  /**
   * 任务完成 Promise：在 orchestrator finally 块执行完毕后 resolve。
   *
   * 用于 `cancel-active-flow` 路由 await，确保取消请求返回时
   * 后端已真正停止 LLM 并清理锁，避免前端再次启动时收到 409。
   *
   * 语义参考 PI SDK `session.abort()` 内部 `await agent.waitForIdle()`：
   * abort 是异步的，需要等待 LLM 自己关闭。
   */
  donePromise: Promise<void>
  resolveDone: () => void
}

/**
 * 运行中章节任务表：用于把前端"停止"传递到后端 LLM 调用。
 *
 * key 为 `${projectId}:${chapterNumber}`，与 chapterCreationLocks 同 key。
 */
export const activeNovelChapterTasks = new Map<string, ActiveNovelChapterTask>()

/**
 * 注册一个新的章节任务，返回包含 AbortController 的任务对象。
 * 调用方应在启动 LLM 流前调用，在流结束（正常或异常）后必须调用 finishNovelChapterTask 清理。
 */
export function registerNovelChapterTask(
  lockKey: string,
  kind: NovelChapterTaskKind,
): ActiveNovelChapterTask {
  let resolveDone!: () => void
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const task: ActiveNovelChapterTask = {
    kind,
    controller: new AbortController(),
    startedAt: Date.now(),
    donePromise,
    resolveDone,
  }
  activeNovelChapterTasks.set(lockKey, task)
  return task
}

/**
 * 完成章节任务：从注册表中移除，并 resolve donePromise。
 * 仅当传入的 task 与注册表中的同一实例匹配时才移除，避免竞态条件下误删后续任务。
 */
export function finishNovelChapterTask(
  lockKey: string,
  task: ActiveNovelChapterTask,
): void {
  if (activeNovelChapterTasks.get(lockKey) === task) {
    activeNovelChapterTasks.delete(lockKey)
  }
  // 通知 cancel-active-flow 路由：orchestrator 已完成
  task.resolveDone()
}
