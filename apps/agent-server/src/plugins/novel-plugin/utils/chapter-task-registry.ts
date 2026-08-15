/**
 * 章节任务注册表 - 创作流程共享状态
 *
 * 拆分自原 novel-routes.ts（PR-6），用于跨子路由共享章节任务互斥锁和 abort 控制器。
 * 必须保持模块级单例语义：Node.js ESM 模块缓存确保 Map/Set 在多子路由文件间共享同一实例。
 */

import type { NovelUserMessageEvent } from './sse-emitter.js'
import type { NovelOrchestratorHooks } from '../core/novel-orchestrator.js'

/** 同一章节 ai-arrange 并发锁，key 为 `${projectId}:${chapterNumber}` */
export const aiArrangeLocks = new Map<string, Promise<void>>()

/** 同一章节正文创作互斥锁，create-flow 与 create-discussion 共用。 */
export const chapterCreationLocks = new Set<string>()

/** 章节任务类型 */
export type NovelChapterTaskKind = 'workflow' | 'discussion' | 'discussion-resume' | 'ai-arrange' | 'reverse-arrange' | 're-revise'

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

// ═══════════════════════════════════════════════════════════════
// 插话 flow 注册表（对话化交互形态 §3.1 / §4，批次 1 任务 2）
//
// 插话端点与目标 create-flow 是两条独立 HTTP 连接：端点要向运行中 flow 的
// SSE 通道推 novel:user-message，必须能按 flowKey 找到该 flow 的 emitter。
// orchestrator 是插件级单例、hooks 全局唯一，injected 回调只给 ids（无 flowKey），
// 因此这里同时登记「flowKey → 推送回调」与「messageId → 插话详情」两张表，
// hook 回调里按 messageId / flowKey 反查目标 flow 再推。
// ═══════════════════════════════════════════════════════════════

/** 运行中 flow 的插话事件推送回调（通常是 emitter.userMessage 的包装） */
export type InterjectEventPublisher = (event: NovelUserMessageEvent) => void

/**
 * 群聊插话投递函数（批次 1 任务 3）：discussion runner 启动时把 engine 的
 * enqueueUserMessage 闭包登记进来，插话端点对 kind='discussion' 经此路由。
 * 返回 false 表示引擎已收尾（闭包存活标记失效），端点应回 409 拒绝受理，
 * 避免消息进入无人消费的死队列（SSE 状态永远停在 queued）。
 */
export type InterjectEnqueuer = (msg: { id: string; content: string; createdAt: number }) => boolean

/** flowKey（`${projectId}|${chapterNumber}`，与 orchestrator.runKey 同构）→ 推送回调 */
const interjectFlowPublishers = new Map<string, InterjectEventPublisher>()

/** flowKey → 群聊 engine 插话入队闭包（runner 启动时注册，run 结束注销） */
const interjectEnqueuers = new Map<string, InterjectEnqueuer>()

/** 已受理插话的详情：hooks 回调按 messageId 反查目标 flow 与事件载荷字段 */
interface TrackedInterjectMessage {
  flowKey: string
  flowId: string
  content: string
  targetAgent?: string
}
const trackedInterjectMessages = new Map<string, TrackedInterjectMessage>()

/** create-flow 启动后登记本 flow 的插话事件推送回调；重复登记覆盖旧值。 */
export function registerInterjectFlow(flowKey: string, publish: InterjectEventPublisher): void {
  interjectFlowPublishers.set(flowKey, publish)
}

/**
 * discussion runner 启动后登记本 flow 的插话投递函数（engine.enqueueUserMessage 闭包）。
 * engine 是 runner.run 内的局部实例、注册表不可直达，因此以投递闭包形式暴露。
 */
export function registerInterjectEnqueuer(flowKey: string, enqueue: InterjectEnqueuer): void {
  interjectEnqueuers.set(flowKey, enqueue)
}

/** runner.run 结束（正常/异常）注销投递函数；与 route finally 的注销双保险。 */
export function unregisterInterjectEnqueuer(flowKey: string): void {
  interjectEnqueuers.delete(flowKey)
}

/** 插话端点对 kind='discussion' 的 flow 用此路由入队；未登记（引擎未就绪/已结束）返回 undefined。 */
export function getInterjectEnqueuer(flowKey: string): InterjectEnqueuer | undefined {
  return interjectEnqueuers.get(flowKey)
}

/** create-flow 终态收尾（route finally）注销推送回调，并丢弃仍被追踪的本 flow 插话。 */
export function unregisterInterjectFlow(flowKey: string): void {
  interjectFlowPublishers.delete(flowKey)
  interjectEnqueuers.delete(flowKey)
  for (const [id, info] of trackedInterjectMessages) {
    if (info.flowKey === flowKey) trackedInterjectMessages.delete(id)
  }
}

/**
 * 插话端点受理成功后调用：登记消息详情（供 hooks 反查）并立即向该 flow
 * 推送 status='queued' 事件。flow 已注销（极小竞态窗口）时静默跳过推送，
 * 消息仍在 orchestrator 队列中，由后续 flow 的 drain/dropped 收尾。
 */
export function announceInterjectQueued(info: {
  flowKey: string
  flowId: string
  messageId: string
  content: string
  targetAgent?: string
}): void {
  trackedInterjectMessages.set(info.messageId, {
    flowKey: info.flowKey,
    flowId: info.flowId,
    content: info.content,
    targetAgent: info.targetAgent,
  })
  interjectFlowPublishers.get(info.flowKey)?.({
    flowId: info.flowId,
    messageId: info.messageId,
    content: info.content,
    targetAgent: info.targetAgent,
    status: 'queued',
    flowKey: info.flowKey,
    timestamp: Date.now(),
  })
}

/**
 * 按 messageId 反查目标 flow 的推送回调，推送 injected/dropped 状态事件。
 * 群聊侧（批次 1 任务 3）由 create-discussion 路由把 engine 的
 * onInterjectInjected/onInterjectDropped 回调直接接到本函数（无 agentType 语义）。
 */
export function dispatchInterjectStatus(
  status: 'injected' | 'dropped',
  ids: string[],
  extra?: { agentType?: string },
): void {
  for (const id of ids) {
    const info = trackedInterjectMessages.get(id)
    // 无论能否推送都先移除追踪：injected 已消费、dropped 已收尾，状态不再流转
    if (!info) continue
    trackedInterjectMessages.delete(id)
    interjectFlowPublishers.get(info.flowKey)?.({
      flowId: info.flowId,
      messageId: id,
      content: info.content,
      targetAgent: info.targetAgent,
      status,
      flowKey: info.flowKey,
      agentType: extra?.agentType,
      timestamp: Date.now(),
    })
  }
}

/**
 * orchestrator 单例的插话生命周期 hooks（novel-services 构造时传入第 8 参）：
 * injected/dropped 回调经本注册表按 messageId/flowKey 路由到对应 flow 的 SSE 通道。
 */
export function createInterjectDispatchHooks(): NovelOrchestratorHooks {
  return {
    onInterjectInjected: (ids, agentType) => dispatchInterjectStatus('injected', ids, { agentType }),
    onInterjectDropped: ids => dispatchInterjectStatus('dropped', ids),
  }
}
