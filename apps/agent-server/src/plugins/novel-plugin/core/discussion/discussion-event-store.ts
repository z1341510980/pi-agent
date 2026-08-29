import type Database from 'better-sqlite3'

/**
 * 群聊事件溯源 store（2026-08-28 控制平面重排 T4）。
 *
 * append-only：run 期间发生的每个确定性调度事实（计划提交 / 节点开始完成 /
 * 回合提交 / 降级 / 检查点 / 终态）逐条落 `novel_discussion_events`。
 * 状态 = fold(events)，续跑 = 重放，SSE = tail——三者共用同一份事件流，
 * 取代 failedPhase 三元组与 transcript 反推启发式。
 *
 * 首迭代与 novel_discussion_runs 快照并存：新 run 逐条追加事件，快照行仍按
 * 旧路径写（只读兼容），下迭代再退化 run 行为索引 + 游标。
 */

/** 首版事件类型。新增类型时同步更新 foldDiscussionEvents 的判定。 */
export type DiscussionEventType =
  | 'run_started'
  | 'plan_submitted'
  | 'beat_started'
  | 'beat_completed'
  | 'beat_skipped'
  | 'turn_submitted'
  | 'reaction_enqueued'
  | 'scene_completed'
  | 'weave_started'
  | 'weave_completed'
  | 'review_completed'
  | 'checkpoint_raised'
  | 'checkpoint_resolved'
  | 'agui'
  | 'degraded'
  | 'run_finished'

export interface DiscussionEvent {
  runId: string
  /** run 内单调递增，从 1 开始；续跑/SSE 重连以它为游标。 */
  seq: number
  type: DiscussionEventType
  payload: Record<string, unknown>
  createdAt: number
}

interface DiscussionEventRow {
  run_id: string
  seq: number
  type: string
  payload: string
  created_at: number
}

export class DiscussionEventStore {
  private readonly stmtAppend: Database.Statement
  private readonly stmtLastSeq: Database.Statement
  private readonly stmtList: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtAppend = db.prepare(`
      INSERT INTO novel_discussion_events (run_id, seq, type, payload, created_at)
      VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM novel_discussion_events WHERE run_id = ?), ?, ?, ?)
    `)
    this.stmtLastSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS seq FROM novel_discussion_events WHERE run_id = ?
    `)
    this.stmtList = db.prepare(`
      SELECT run_id, seq, type, payload, created_at
        FROM novel_discussion_events
       WHERE run_id = ? AND seq >= ?
       ORDER BY seq ASC
    `)
  }

  /** 追加一条事件；seq 由数据库侧保证 run 内单调。写入失败向上抛（事件不能静默丢）。 */
  append(runId: string, type: DiscussionEventType, payload: Record<string, unknown> = {}): DiscussionEvent {
    const now = Math.floor(Date.now() / 1000)
    this.stmtAppend.run(runId, runId, type, JSON.stringify(payload), now)
    const seq = (this.stmtLastSeq.get(runId) as { seq: number }).seq
    return { runId, seq, type, payload, createdAt: now * 1000 }
  }

  /** 读取 run 的事件流；fromSeq 默认 1（全量重放），SSE tail 传上次游标 + 1。 */
  list(runId: string, fromSeq = 1): DiscussionEvent[] {
    const rows = this.stmtList.all(runId, fromSeq) as DiscussionEventRow[]
    return rows.map(row => ({
      runId: row.run_id,
      seq: row.seq,
      type: row.type as DiscussionEventType,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at * 1000,
    }))
  }

  lastSeq(runId: string): number {
    return (this.stmtLastSeq.get(runId) as { seq: number }).seq
  }

  /**
   * 查找该项目 + 章节仍在进行（有 run_started、无 run_finished）的群聊 run（T7）。
   * 供"面板重开后再点开始"场景重连事件 tail：POST 收到 409 时前端据此取回
   * runId 转入 tail 观看，而不是报错。返回 undefined 表示没有在跑的 run。
   */
  findActiveRun(projectId: string, chapterNumber: number): { runId: string; cursorSeq: number } | undefined {
    return this.db.prepare(`
      SELECT rs.run_id AS runId,
             (SELECT MAX(seq) FROM novel_discussion_events WHERE run_id = rs.run_id) AS cursorSeq
        FROM novel_discussion_events rs
       WHERE rs.type = 'run_started'
         AND json_extract(rs.payload, '$.projectId') = ?
         AND json_extract(rs.payload, '$.chapterNumber') = ?
         AND NOT EXISTS (
           SELECT 1 FROM novel_discussion_events rf
            WHERE rf.run_id = rs.run_id AND rf.type = 'run_finished'
         )
       ORDER BY rs.created_at DESC, rs.seq DESC
       LIMIT 1
    `).get(projectId, chapterNumber) as { runId: string; cursorSeq: number } | undefined
  }

  /**
   * 孤儿事件流回收（T6）：run 脱离 HTTP 后台执行后，进程退出/崩溃可能留下
   * 永远没有 run_finished 终态的事件流（fold 停在 running）。服务启动时调用：
   * 此刻不可能有在跑的 run，所有缺终态的流一律补 run_finished(error)，
   * phase 信息在事件里，续跑定位不受影响。
   *
   * @returns 被回收的 run 数
   */
  reconcileOrphanRuns(message: string): number {
    const rows = this.db.prepare(`
      SELECT run_id AS runId, type
        FROM novel_discussion_events
       WHERE seq = (SELECT MAX(seq) FROM novel_discussion_events WHERE run_id = novel_discussion_events.run_id)
    `).all() as Array<{ runId: string; type: string }>
    let recovered = 0
    for (const row of rows) {
      if (row.type === 'run_finished') continue
      this.append(row.runId, 'run_finished', { status: 'error', error: message, interrupted: true })
      recovered++
    }
    return recovered
  }
}

/**
 * 从事件流推导断点续跑位置（T5）：取代 run 行三元组读取。
 *
 * - phase：事件里最后的阶段事实（review 决策 > weave > acting）。planning 阶段
 *   的失败没有事件可辨（plan_submitted 缺失或 sceneCount=0），返回 undefined，
 *   与旧口径"planning 不可续跑"一致。
 * - failedSceneId/failedActionBeatId：最后一条 beat_started 的位置。引擎首跑
 *   写入的 failedActionBeatId 正是中断时在拍的节点，语义一致；该节点是否真的
 *   完成，由 completedByScene（beat_completed 定账）决定，不再靠 transcript 反推。
 * - completedByScene：按场景分组的已完成 beatId；续跑直接作为完成集传入引擎，
 *   旧快照（无事件流）仍走引擎的 transcript 反推。
 */
export interface DiscussionResumeInfo {
  phase?: 'acting' | 'chapter_weaving' | 'reviewing'
  failedSceneId?: number
  failedActionBeatId?: string
  completedByScene: Map<number, string[]>
}

export function deriveResumeInfo(events: DiscussionEvent[]): DiscussionResumeInfo {
  const completedByScene = new Map<number, string[]>()
  let phase: DiscussionResumeInfo['phase']
  let lastStarted: { sceneId?: number; beatId: string } | undefined

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>
    switch (event.type) {
      case 'beat_started':
        lastStarted = {
          sceneId: payload.sceneId == null ? undefined : Number(payload.sceneId),
          beatId: String(payload.beatId ?? ''),
        }
        phase = 'acting'
        break
      case 'beat_completed': {
        const sceneId = payload.sceneId == null ? undefined : Number(payload.sceneId)
        const beatId = String(payload.beatId ?? '')
        if (sceneId != null && beatId) {
          const list = completedByScene.get(sceneId) ?? []
          if (!list.includes(beatId)) list.push(beatId)
          completedByScene.set(sceneId, list)
        }
        break
      }
      case 'scene_completed':
        phase = 'acting'
        break
      case 'plan_submitted':
        // 有场景计划的失败发生在 acting/scene_setup；scene_setup 中断时没有
        // beat_started，phase 也归入 acting（resumeSceneActing 同一入口）。
        if (Number(payload.sceneCount ?? 0) > 0) phase = phase ?? 'acting'
        break
      case 'weave_started':
      case 'weave_completed':
        phase = 'chapter_weaving'
        break
      case 'review_completed':
        phase = 'reviewing'
        break
      case 'checkpoint_raised':
        // review 决策检查点之后的中断属于 reviewing；其余检查点不改变阶段判定
        if (payload.type === 'review') phase = 'reviewing'
        break
      default:
        break
    }
  }

  return {
    phase,
    failedSceneId: lastStarted?.sceneId,
    failedActionBeatId: lastStarted?.beatId,
    completedByScene,
  }
}

/**
 * fold 后的 run 状态。字段刻意保持最小：调度推进只需要
 * "哪些节点已定账、当前卡在哪、有没有正文"这些事实，
 * 展示细节仍由快照/前端承载。
 */
export interface DiscussionRunFoldState {
  /** awaiting_user = 有未决检查点（checkpoint_raised 后未见 checkpoint_resolved）。 */
  status: 'idle' | 'running' | 'awaiting_user' | 'completed' | 'cancelled' | 'error'
  planSource?: 'tool' | 'markdown' | 'none'
  sceneCount: number
  scenesWithAccount: number
  beatsCompleted: string[]
  beatsSkipped: string[]
  beatsThin: string[]
  beatsUnreached: string[]
  characterTurnCount: number
  reactionTurnCount: number
  checkpointsRaised: number
  contentAvailable: boolean
  lastError?: string
  /** 已消费的最后一条事件 seq（游标）。 */
  cursorSeq: number
}

/** 纯函数 fold：按事件序重放 run 事实。空事件流返回 idle 初始态。 */
export function foldDiscussionEvents(events: DiscussionEvent[]): DiscussionRunFoldState {
  const state: DiscussionRunFoldState = {
    status: 'idle',
    sceneCount: 0,
    scenesWithAccount: 0,
    beatsCompleted: [],
    beatsSkipped: [],
    beatsThin: [],
    beatsUnreached: [],
    characterTurnCount: 0,
    reactionTurnCount: 0,
    checkpointsRaised: 0,
    contentAvailable: false,
    cursorSeq: 0,
  }
  const seenScenes = new Set<number>()

  for (const event of events) {
    state.cursorSeq = event.seq
    const payload = event.payload as Record<string, unknown>
    switch (event.type) {
      case 'run_started':
        state.status = 'running'
        break
      case 'plan_submitted':
        state.planSource = payload.source as DiscussionRunFoldState['planSource']
        state.sceneCount = Number(payload.sceneCount ?? 0)
        break
      case 'beat_completed': {
        const beatId = String(payload.beatId ?? '')
        if (beatId && !state.beatsCompleted.includes(beatId)) state.beatsCompleted.push(beatId)
        break
      }
      case 'beat_skipped': {
        const beatId = String(payload.beatId ?? '')
        if (beatId && !state.beatsSkipped.includes(beatId)) state.beatsSkipped.push(beatId)
        break
      }
      case 'degraded': {
        const beatId = String(payload.beatId ?? '')
        const kind = String(payload.kind ?? '')
        if (kind === 'thin') {
          if (beatId && !state.beatsThin.includes(beatId)) state.beatsThin.push(beatId)
        } else if (beatId && !state.beatsUnreached.includes(beatId)) {
          state.beatsUnreached.push(beatId)
        }
        break
      }
      case 'scene_completed':
        if (!seenScenes.has(Number(payload.sceneId))) {
          seenScenes.add(Number(payload.sceneId))
          state.scenesWithAccount += 1
        }
        break
      case 'turn_submitted':
        state.characterTurnCount += 1
        if (payload.reaction === true) state.reactionTurnCount += 1
        break
      case 'checkpoint_raised':
        state.checkpointsRaised += 1
        state.status = 'awaiting_user'
        break
      case 'checkpoint_resolved':
        // 只有 run 未终结时才回到 running；终态事件先到的乱序流以终态为准。
        if (state.status === 'awaiting_user') state.status = 'running'
        break
      case 'weave_completed':
      case 'review_completed':
        state.contentAvailable = true
        break
      case 'run_finished': {
        const finalStatus = String(payload.status ?? 'error')
        state.status = finalStatus === 'completed'
          ? 'completed'
          : finalStatus === 'cancelled' ? 'cancelled' : 'error'
        if (payload.error) state.lastError = String(payload.error)
        break
      }
      // plan 无关推进的事件（beat_started / reaction_enqueued / weave_started /
      // checkpoint 内容载荷）不改变 fold 状态，只推进游标。
      default:
        break
    }
  }
  return state
}
