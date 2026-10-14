import type Database from 'better-sqlite3'
import { RunEventStore, type RunEvent } from './run-event-store.js'

/**
 * 章节工作流（create-flow）事件溯源 store。
 *
 * ## 为什么需要
 *
 * create-flow 原先跑在单次 HTTP/SSE 请求里：`reply.raw.once('close')` 一触发就
 * `controller.abort()`，于是刷新页面、切路由、渲染进程重载、代理掐连接、
 * 后端重启都会让整章作废。实测数据（`novel_workflow_runs` 20 条）里
 * **6 条 error 中有 5 条是「服务重启导致创作流程中断」**，另有 5 条 cancelled
 * 是关服时 pending 检查点被 `dispose()` 强制 reject 的结果 —— 只有 9 条跑完。
 *
 * 改造方式与群聊（`discussion-event-store.ts`）同构：POST 只受理并返回
 * `202 + runId`，执行转入后台任务；进度与结果镜像进本事件流，
 * 前端用 `GET .../workflow-runs/:runId/events?from=<cursor>` 消费，
 * 断线重连只是重新 tail，run 本身不受影响。
 *
 * 事件类型刻意保持最小：`run_started` / `agui`（AG-UI 事件原样镜像，
 * 含 TEXT_MESSAGE_*、novel:progress、novel:checkpoint、novel:user-message）
 * / `run_finished`。续跑定位仍由 `novel_workflow_runs` 的阶段边界快照负责，
 * 事件流只承担"进度可见 + 终态可达"。
 */
export type WorkflowEventType =
  | 'run_started'
  /** AG-UI 事件镜像：payload 即原事件对象，前端直接喂 handleEvent。 */
  | 'agui'
  | 'run_finished'

export type WorkflowEvent = RunEvent<WorkflowEventType>

/** `run_finished` 的 payload 形状（前端据此合成 novel:result）。 */
export interface WorkflowRunFinishedPayload {
  status: 'completed' | 'cancelled' | 'error'
  workflowRunId: string
  error?: string
  failedPhase?: string
  content?: string
  canResume?: boolean
  interrupted?: boolean
  [key: string]: unknown
}

export class WorkflowEventStore extends RunEventStore<WorkflowEventType> {
  constructor(db: Database.Database) {
    super(db, {
      table: 'novel_workflow_events',
      startedType: 'run_started',
      finishedType: 'run_finished',
    })
  }
}
