/**
 * CanvasVideoTaskStore：画布视频异步任务队列（infinite_canvas_video_tasks 表，迁移 020）。
 *
 * 提交视频生成时立即落一行 running 任务（上游 task_id / 协议 / 节点关联 / 参数回显），
 * 后台 worker 与手动 refresh 路由共用「轮询一次 → 状态落库 → 成品本地化」流程
 * （组装见 index.ts 的 pollVideoTaskRow）。行是唯一持久状态：服务重启后 running
 * 任务留在表内，靠 worker / refresh 恢复，无需内存态。
 *
 * 与 CanvasAssetStore / MediaProviderStore 同款模式：better-sqlite3 同步语句 +
 * 预编译，DB 由构造注入；params 列以 JSON 字符串存储，读写边界在此转换。
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { VideoTaskProtocol } from './media/adapter.js'

/** 本地任务状态：上游 queued/in_progress 归一为 running，终态 success/failed，超预算 timeout。 */
export type VideoTaskStatus = 'running' | 'success' | 'failed' | 'timeout'

export interface CanvasVideoTaskCreateInput {
  projectId: string
  nodeId?: string
  providerId: string
  /** 上游任务 ID（提交响应解析所得）。 */
  taskId: string
  protocol: VideoTaskProtocol
  model?: string
  /** 参数回显（duration/resolution/refImages 数量等），JSON 落库。 */
  params?: Record<string, unknown>
}

export type CanvasVideoTaskPatch = Partial<{
  status: VideoTaskStatus
  progress: string | null
  resultPath: string | null
  error: string | null
}>

export interface CanvasVideoTaskRecord {
  id: string
  projectId: string
  nodeId: string | null
  providerId: string
  taskId: string
  protocol: VideoTaskProtocol
  model: string | null
  params: Record<string, unknown>
  status: VideoTaskStatus
  progress: string | null
  resultPath: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

interface VideoTaskDbRow {
  id: string
  project_id: string
  node_id: string | null
  provider_id: string
  task_id: string
  protocol: string
  model: string | null
  params: string
  status: string
  progress: string | null
  result_path: string | null
  error: string | null
  created_at: number
  updated_at: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** params 列 JSON 反序列化；损坏或非对象数据回退空对象。 */
function parseParams(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function rowToTask(row: VideoTaskDbRow): CanvasVideoTaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    providerId: row.provider_id,
    taskId: row.task_id,
    protocol: row.protocol as VideoTaskProtocol,
    model: row.model,
    params: parseParams(row.params),
    status: row.status as VideoTaskStatus,
    progress: row.progress,
    resultPath: row.result_path,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 项目任务列表条数上限（工作区轮询只关心最近任务）。 */
const VIDEO_TASK_LIST_LIMIT = 100

export class CanvasVideoTaskStore {
  private readonly stmtInsert: Database.Statement
  private readonly stmtGet: Database.Statement
  private readonly stmtListByProject: Database.Statement
  private readonly stmtListRunning: Database.Statement
  private readonly stmtMarkTimeout: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT INTO infinite_canvas_video_tasks (
         id, project_id, node_id, provider_id, task_id, protocol, model, params,
         status, progress, result_path, error, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?)`
    )
    this.stmtGet = db.prepare('SELECT * FROM infinite_canvas_video_tasks WHERE id = ?')
    this.stmtListByProject = db.prepare(
      `SELECT * FROM infinite_canvas_video_tasks WHERE project_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ${VIDEO_TASK_LIST_LIMIT}`
    )
    this.stmtListRunning = db.prepare(
      'SELECT * FROM infinite_canvas_video_tasks WHERE status = ? ORDER BY created_at, rowid'
    )
    this.stmtMarkTimeout = db.prepare(
      `UPDATE infinite_canvas_video_tasks SET status = 'timeout', updated_at = ?
       WHERE status = 'running' AND created_at <= ?`
    )
  }

  /** 新建 running 任务行；id/时间戳服务端生成。 */
  create(input: CanvasVideoTaskCreateInput): CanvasVideoTaskRecord {
    const id = randomUUID()
    const now = Date.now()
    this.stmtInsert.run(
      id,
      input.projectId,
      input.nodeId ?? null,
      input.providerId,
      input.taskId,
      input.protocol,
      input.model ?? null,
      JSON.stringify(input.params ?? {}),
      now,
      now
    )
    return this.get(id)!
  }

  get(id: string): CanvasVideoTaskRecord | undefined {
    const row = this.stmtGet.get(id) as VideoTaskDbRow | undefined
    return row ? rowToTask(row) : undefined
  }

  /** 项目任务列表：created_at 倒序，封顶 100 条。 */
  listByProject(projectId: string): CanvasVideoTaskRecord[] {
    return (this.stmtListByProject.all(projectId) as VideoTaskDbRow[]).map((row) => rowToTask(row))
  }

  /** 项目删除时清理任务行（表无外键级联，与资产清理同一时机、先于项目行删除）。 */
  deleteForProject(projectId: string): void {
    this.db.prepare('DELETE FROM infinite_canvas_video_tasks WHERE project_id = ?').run(projectId)
  }

  /** 全部 running 任务（worker 扫描输入，最旧优先）。 */
  listRunning(): CanvasVideoTaskRecord[] {
    return (this.stmtListRunning.all('running') as VideoTaskDbRow[]).map((row) => rowToTask(row))
  }

  /** 部分更新（status/progress/resultPath/error），updated_at 一并前推。 */
  update(id: string, patch: CanvasVideoTaskPatch): CanvasVideoTaskRecord | undefined {
    const sets: string[] = []
    const args: Record<string, unknown> = { id }
    if (patch.status !== undefined) {
      sets.push('status = @status')
      args.status = patch.status
    }
    if (patch.progress !== undefined) {
      sets.push('progress = @progress')
      args.progress = patch.progress
    }
    if (patch.resultPath !== undefined) {
      sets.push('result_path = @resultPath')
      args.resultPath = patch.resultPath
    }
    if (patch.error !== undefined) {
      sets.push('error = @error')
      args.error = patch.error
    }
    if (sets.length > 0) {
      this.db
        .prepare(
          `UPDATE infinite_canvas_video_tasks SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`
        )
        .run({ ...args, updatedAt: Date.now() })
    }
    return this.get(id)
  }

  /** running 且创建时间早于 now - olderThanMs 的任务批量标 timeout，返回改写行数。 */
  markTimeoutIfStale(olderThanMs: number): number {
    const now = Date.now()
    return this.stmtMarkTimeout.run(now, now - olderThanMs).changes
  }
}

/**
 * 列表/恢复路由的任务视图：内部行 → 桌面端消费形状；
 * resultPath 仅在 success 时携带（failed/running/timeout 没有可用的本地结果）。
 */
export function toVideoTaskApiView(task: CanvasVideoTaskRecord): {
  id: string
  nodeId: string | null
  taskId: string
  status: VideoTaskStatus
  progress: string | null
  error: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  resultPath?: string
} {
  return {
    id: task.id,
    nodeId: task.nodeId,
    taskId: task.taskId,
    status: task.status,
    progress: task.progress,
    error: task.error,
    model: task.model,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.status === 'success' && task.resultPath ? { resultPath: task.resultPath } : {})
  }
}

/**
 * 任务能力类错误：任务行存在但 Provider 已删/停用、adapter 不支持轮询等
 * 不可恢复的本地能力问题 —— refresh 路由按 4xx 可读错误透出（区别于上游
 * 查询/下载失败的 502）。worker 里同样按失败任务记录并跳过。
 */
export class VideoTaskCapabilityError extends Error {}
