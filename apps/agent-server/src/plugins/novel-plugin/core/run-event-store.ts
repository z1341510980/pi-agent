import type Database from 'better-sqlite3'

/**
 * 通用「后台 run 事件溯源」存储（append-only）。
 *
 * ## 为什么需要
 *
 * 长流程（群聊创作 / 章节工作流）如果跑在 HTTP 请求里，连接一断就没人能看见进度，
 * 只能靠 abort 收场 —— 实测这类"客户端断开即取消"占掉了大量本可完成的运行。
 * 把 run 挪到后台之后，**事件流成为唯一的进度事实源**：
 * 状态 = fold(events)，续跑 = 重放，SSE = tail。三者共用同一份事件流，
 * 前端断线重连只要带上 `?from=<cursorSeq>` 就能补齐缺口，run 本身不受影响。
 *
 * ## 与各领域 store 的关系
 *
 * 本类只承载与领域无关的部分（追加、游标、tail 读取、活跃 run 查询、孤儿回收）。
 * 事件类型枚举与 fold/续跑推导留在各自领域
 * （`discussion/discussion-event-store.ts`、`workflow-event-store.ts`）。
 */
export interface RunEvent<TType extends string = string> {
  runId: string
  /** run 内单调递增，从 1 开始；续跑/SSE 重连以它为游标。 */
  seq: number
  type: TType
  payload: Record<string, unknown>
  createdAt: number
}

export interface RunEventStoreOptions<TType extends string> {
  /** 事件表名；只接受标识符，防止拼接注入。 */
  table: string
  /** 起始事件类型（active run 判定用）。 */
  startedType: TType
  /** 终态事件类型（active run 判定 + 孤儿回收用）。 */
  finishedType: TType
}

interface RunEventRow {
  run_id: string
  seq: number
  type: string
  payload: string
  created_at: number
}

/** 表名进入的是 SQL 文本而非绑定参数，必须先证明它只是一个标识符。 */
function assertIdentifier(table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`非法的 run 事件表名：${table}`)
  }
  return table
}

export class RunEventStore<TType extends string = string> {
  private readonly table: string
  private readonly startedType: TType
  private readonly finishedType: TType
  private readonly stmtAppend: Database.Statement
  private readonly stmtLastSeq: Database.Statement
  private readonly stmtList: Database.Statement
  private readonly stmtFindActive: Database.Statement
  private readonly stmtLastTypes: Database.Statement

  constructor(protected readonly db: Database.Database, options: RunEventStoreOptions<TType>) {
    this.table = assertIdentifier(options.table)
    this.startedType = options.startedType
    this.finishedType = options.finishedType
    this.stmtAppend = db.prepare(`
      INSERT INTO ${this.table} (run_id, seq, type, payload, created_at)
      VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${this.table} WHERE run_id = ?), ?, ?, ?)
    `)
    this.stmtLastSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.table} WHERE run_id = ?
    `)
    this.stmtList = db.prepare(`
      SELECT run_id, seq, type, payload, created_at
        FROM ${this.table}
       WHERE run_id = ? AND seq >= ?
       ORDER BY seq ASC
    `)
    this.stmtFindActive = db.prepare(`
      SELECT rs.run_id AS runId,
             (SELECT MAX(seq) FROM ${this.table} WHERE run_id = rs.run_id) AS cursorSeq
        FROM ${this.table} rs
       WHERE rs.type = ?
         AND json_extract(rs.payload, '$.projectId') = ?
         AND json_extract(rs.payload, '$.chapterNumber') = ?
         AND NOT EXISTS (
           SELECT 1 FROM ${this.table} rf
            WHERE rf.run_id = rs.run_id AND rf.type = ?
         )
       ORDER BY rs.created_at DESC, rs.seq DESC
       LIMIT 1
    `)
    this.stmtLastTypes = db.prepare(`
      SELECT run_id AS runId, type
        FROM ${this.table}
       WHERE seq = (SELECT MAX(seq) FROM ${this.table} WHERE run_id = ${this.table}.run_id)
    `)
  }

  /** 追加一条事件；seq 由数据库侧保证 run 内单调。写入失败向上抛（事件不能静默丢）。 */
  append(runId: string, type: TType, payload: Record<string, unknown> = {}): RunEvent<TType> {
    const now = Math.floor(Date.now() / 1000)
    this.stmtAppend.run(runId, runId, type, JSON.stringify(payload), now)
    const seq = (this.stmtLastSeq.get(runId) as { seq: number }).seq
    return { runId, seq, type, payload, createdAt: now * 1000 }
  }

  /** 读取 run 的事件流；fromSeq 默认 1（全量重放），SSE tail 传上次游标 + 1。 */
  list(runId: string, fromSeq = 1): RunEvent<TType>[] {
    const rows = this.stmtList.all(runId, fromSeq) as RunEventRow[]
    return rows.map(row => ({
      runId: row.run_id,
      seq: row.seq,
      type: row.type as TType,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at * 1000,
    }))
  }

  lastSeq(runId: string): number {
    return (this.stmtLastSeq.get(runId) as { seq: number }).seq
  }

  /**
   * 查找该项目 + 章节仍在进行（有 startedType、无 finishedType）的 run。
   * 供"面板重开后再点开始"场景重连事件 tail：POST 收到 409 时前端据此取回
   * runId 转入 tail 观看，而不是报错。返回 undefined 表示没有在跑的 run。
   */
  findActiveRun(projectId: string, chapterNumber: number): { runId: string; cursorSeq: number } | undefined {
    return this.stmtFindActive.get(
      this.startedType, projectId, chapterNumber, this.finishedType,
    ) as { runId: string; cursorSeq: number } | undefined
  }

  /**
   * 孤儿事件流回收：run 脱离 HTTP 后台执行后，进程退出/崩溃可能留下
   * 永远没有终态的事件流（fold 停在 running，前端 tail 永远轮询）。
   * 服务启动时调用：此刻不可能有在跑的 run，所有缺终态的流一律补终态。
   *
   * @returns 被回收的 run 数
   */
  reconcileOrphanRuns(message: string): number {
    const rows = this.stmtLastTypes.all() as Array<{ runId: string; type: string }>
    let recovered = 0
    for (const row of rows) {
      if (row.type === this.finishedType) continue
      this.append(row.runId, this.finishedType, { status: 'error', error: message, interrupted: true })
      recovered++
    }
    return recovered
  }
}
