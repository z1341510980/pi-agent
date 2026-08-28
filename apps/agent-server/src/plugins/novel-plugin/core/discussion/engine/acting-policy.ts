/**
 * acting 阶段降级策略表
 *
 * ⚠️ 设计动机（2026-08-28 控制平面重排 T2）：
 * 旧路径把"节点失败 / 回合无进展 / actor 不在场 / 节点未完成"四类异常全部交给
 * `interveneForActionBeat()` —— 每类各调一次 Moderator LLM 决策，且严格模式下
 * 场景末尾仍有未完成节点就直接 `throw`，整章 run 变 error。结果是：一次角色回合
 * 抖动能让 30 分钟的运行作废，而 Moderator 的"仲裁"实际只在 continue/abort 之间选，
 * 决策空间小到不值得一次 LLM 往返。
 *
 * 现在这些判定全部是纯代码：每个节点得到一个确定的处置（disposition），
 * 场景累积成 SceneActingReport，run() 末尾统一判断"够不够写"。
 * 只有"全部场景都没有有效演出"才停下来问用户——那是真正需要人介入的场景。
 */

import type { SceneDefinition } from './discussion-types.js'

/** 单个动作节点的最终处置。 */
export type BeatDisposition =
  /** 角色提交了有效回合（有 publicText 且有 consequence 且非 stall） */
  | 'completed'
  /** 角色被调用但回合无效（stall / 无 consequence）——演了但没推进 */
  | 'thin'
  /** 节点没能执行：actor 不在场，或连续失败用尽重试预算 */
  | 'skipped'

/** 一个场景的演出账目。 */
export interface SceneActingReport {
  sceneId: number
  title: string
  /** 按处置分组的 beatId */
  completed: string[]
  thin: string[]
  skipped: string[]
  /** 角色自主 mention 触发的回应回合数（不占 beat 名额） */
  reactionTurns: number
  /** 因预算耗尽从未被执行的 beatId（既非失败也非完成） */
  unreached: string[]
}

export const ACTING_POLICY = {
  /** 单个动作节点的最大尝试次数（含首次）。一次抖动重试，不做无界重试。 */
  MAX_BEAT_ATTEMPTS: 2,
  /**
   * 每场景 reaction 回合预算。
   *
   * mention 从"基本被静态数组挡掉"变成真的执行后，实际调用量会上升，
   * 因此这里比 beat 预算收得更紧：接戏是加戏，不能变成主体。
   */
  MAX_REACTION_TURNS_PER_SCENE: 3,
  /** 同一有向角色边（A→B）在一场中的最大重复次数。 */
  MAX_MENTION_EDGE_REPEATS: 2,
  /** mention 链最大深度。 */
  MAX_MENTION_DEPTH: 3,
} as const

export function createSceneActingReport(scene: SceneDefinition): SceneActingReport {
  return {
    sceneId: scene.sceneId,
    title: scene.title,
    completed: [],
    thin: [],
    skipped: [],
    reactionTurns: 0,
    unreached: [],
  }
}

/** 该场景是否产出了有效演出（至少一个节点 completed）。 */
export function isSceneProductive(report: SceneActingReport): boolean {
  return report.completed.length > 0
}

/** 全章演出汇总，供 Phase 2.5 闸门与诊断共用同一口径。 */
export interface ActingSummary {
  scenesTotal: number
  /** 至少一个节点 completed 的场景数 */
  productiveScenes: number
  /** 完全没有有效演出的场景 */
  barrenSceneIds: number[]
  completedBeats: number
  /** thin + skipped + unreached：正文里需要 Writer 绕开或补写的部分 */
  incompleteBeats: number
  incompleteBeatIds: string[]
  reactionTurns: number
}

export function summarizeActing(reports: SceneActingReport[]): ActingSummary {
  const barrenSceneIds: number[] = []
  const incompleteBeatIds: string[] = []
  let completedBeats = 0
  let reactionTurns = 0

  for (const report of reports) {
    if (!isSceneProductive(report)) barrenSceneIds.push(report.sceneId)
    completedBeats += report.completed.length
    reactionTurns += report.reactionTurns
    incompleteBeatIds.push(...report.thin, ...report.skipped, ...report.unreached)
  }

  return {
    scenesTotal: reports.length,
    productiveScenes: reports.length - barrenSceneIds.length,
    barrenSceneIds,
    completedBeats,
    incompleteBeats: incompleteBeatIds.length,
    incompleteBeatIds,
    reactionTurns,
  }
}

/**
 * 闸门判定：这批演出够不够进 Writer。
 *
 * - `proceed`：有场景产出了有效演出。缺失部分交给质量契约，让 Writer 绕开。
 * - `ask_user`：一个场景都没演成。此时盲写等于让 Writer 凭场景契约编造整章，
 *   与"群聊共创"的前提相悖，必须让用户决定是重试还是改用标准工作流。
 */
export function decideWeaveGate(summary: ActingSummary): 'proceed' | 'ask_user' {
  if (summary.scenesTotal === 0) return 'ask_user'
  return summary.productiveScenes > 0 ? 'proceed' : 'ask_user'
}

/**
 * Writer 质量契约：把"哪些戏没演成"显式告知 Writer。
 *
 * 旧路径只有二选一——要么盲写（Writer 不知道哪里是空的，容易编造），
 * 要么阻断（已有演出全部作废）。契约是第三条路：Writer 知道缺口在哪，
 * 被明确要求绕开而不是填充。
 */
export function buildWriterQualityContract(
  reports: SceneActingReport[],
  scenes: SceneDefinition[],
): string {
  const lines: string[] = []
  for (const report of reports) {
    const gaps = [...report.thin, ...report.skipped, ...report.unreached]
    if (gaps.length === 0) continue
    const scene = scenes.find(item => item.sceneId === report.sceneId)
    const beatDetails = gaps.map(beatId => {
      const beat = scene?.actionBeats?.find(item => item.beatId === beatId)
      return beat ? `${beatId}（${beat.action}）` : beatId
    })
    lines.push(`- 场景${report.sceneId}「${report.title}」未演出的节点：${beatDetails.join('、')}`)
  }
  if (lines.length === 0) return ''
  return [
    '## 演出缺口（硬约束）',
    '以下动作节点没有产生有效的角色演出：',
    ...lines,
    '',
    '处理方式：**绕开这些节点**，不要凭节点描述编造角色的动作、台词或心理。',
    '把已演出的部分写成完整可读的正文，缺口处用叙事过渡跳过或留白，允许本章篇幅因此偏短。',
    '编造未演出的戏比篇幅不足更糟：那会让后续章节建立在不存在的因果上。',
  ].join('\n')
}
