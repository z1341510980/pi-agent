/**
 * NarrativeMatrixProjection：剧情推进轨道投影（第二轮）。
 *
 * 文档 §9：GET /projects/:id/narrative-matrix 返回 Storyline rows、Scene nodes、
 * Progress links。与实体状态轨道（matrix-aggregation，实体出场）分离展示。
 *
 * 只读投影（V2 数据源）：
 * - Storyline 行 × 章节列；每格是某场景对该故事线的推进（Progress link）
 * - 只读 confirmed 且非 stale 的 progress（stale 计数单独报告，提示待重建）
 * - sceneNodes 从 progress 关联的场景去重构建
 */
import { createHash } from 'node:crypto'
import type { NovelStore } from './novel-store.js'
import type {
  NovelStoryline,
  NovelStorylineProgress,
} from './types.js'

export interface NarrativeMatrixSceneNode {
  sceneRevisionId: string
  sceneId: string
  sceneKey: string
  chapterId: string
  chapterNumber: number | null
  order: number | null
  title: string
}

export interface NarrativeMatrixProgressLink {
  progressId: string
  storylineId: string
  sceneRevisionId: string
  chapterNumber: number | null
  type: NovelStorylineProgress['type']
  primary: boolean
  beforeState: string
  afterState: string
  summary: string
  status: NovelStorylineProgress['status']
  createdAt: number
}

export interface NarrativeMatrixRow {
  storylineId: string
  name: string
  kind: string
  lifecycle: NovelStoryline['lifecycle']
  maturity: NovelStoryline['maturity']
  /** 该故事线在哪些章节被推进（按章序） */
  progresses: NarrativeMatrixProgressLink[]
}

export interface NarrativeMatrixReport {
  projectId: string
  /** 数据来源标识：本投影只读 V2 叙事账本 */
  source: 'v2-ledger'
  /** 当前参与构建的账本事实指纹，可由客户端作为 asOfRevision 回传校验。 */
  sourceRevision: string
  /** 同步读取账本构建投影，当前不存在异步队列积压。 */
  projectionLag: number
  /** 账本包含 stale 事实，或请求的 asOfRevision 与当前事实指纹不一致。 */
  stale: boolean
  generatedAt: number
  rows: NarrativeMatrixRow[]
  sceneNodes: NarrativeMatrixSceneNode[]
  /** 被标记 stale 而排除的 progress 数（中间章重写后待重建） */
  staleCount: number
}

export interface NarrativeMatrixOptions {
  /** 客户端期望读取的源版本；当前实现只保留最新同步投影。 */
  asOfRevision?: string
}

export function buildNarrativeMatrix(
  store: NovelStore,
  projectId: string,
  options: NarrativeMatrixOptions = {},
): NarrativeMatrixReport {
  const storylines = store.listStorylines(projectId)
  const rows: NarrativeMatrixRow[] = []
  const sceneNodeByRevision = new Map<string, NarrativeMatrixSceneNode>()
  const sourceParts: string[] = []
  let staleCount = 0

  for (const storyline of storylines) {
    const all = store.listProgressByStoryline(storyline.id)
    sourceParts.push(JSON.stringify({
      type: 'storyline',
      id: storyline.id,
      name: storyline.name,
      kind: storyline.kind,
      lifecycle: storyline.lifecycle,
      maturity: storyline.maturity,
    }))
    for (const progress of all) {
      sourceParts.push(JSON.stringify({
        type: 'progress',
        id: progress.id,
        sceneRevisionId: progress.sceneRevisionId,
        primary: progress.primary,
        progressType: progress.type,
        beforeState: progress.beforeState,
        afterState: progress.afterState,
        summary: progress.summary,
        status: progress.status,
        createdAt: progress.createdAt,
      }))
    }
    const confirmed = all.filter((p) => p.status === 'confirmed')
    staleCount += all.filter((p) => p.status === 'stale').length

    const progresses: NarrativeMatrixProgressLink[] = confirmed
      .map((progress) => {
        const scene = store.getSceneRevision(progress.sceneRevisionId)
        const sceneIdentity = scene ? store.getSceneByRevision(scene.id) : undefined
        const chapter = scene ? store.getChapterById(scene.chapterId) : undefined
        const chapterNumber = chapter?.chapterNumber ?? null

        if (scene) {
          const key = scene.id
          if (!sceneNodeByRevision.has(key)) {
            sceneNodeByRevision.set(key, {
              sceneRevisionId: scene.id,
              sceneId: scene.sceneId,
              sceneKey: sceneIdentity?.stableKey ?? `scene-${scene.order}`,
              chapterId: scene.chapterId,
              chapterNumber,
              order: scene.order,
              title: scene.title,
            })
          }
        }

        return {
          progressId: progress.id,
          storylineId: storyline.id,
          sceneRevisionId: progress.sceneRevisionId,
          chapterNumber,
          type: progress.type,
          primary: progress.primary,
          beforeState: progress.beforeState,
          afterState: progress.afterState,
          summary: progress.summary,
          status: progress.status,
          createdAt: progress.createdAt,
        }
      })
      .sort((a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0) || a.createdAt - b.createdAt)

    rows.push({
      storylineId: storyline.id,
      name: storyline.name,
      kind: storyline.kind,
      lifecycle: storyline.lifecycle,
      maturity: storyline.maturity,
      progresses,
    })
  }

  const sceneNodes = [...sceneNodeByRevision.values()].sort(
    (a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0) || (a.order ?? 0) - (b.order ?? 0),
  )
  const sourceRevision = createHash('sha256')
    .update(sourceParts.sort().join('|'))
    .digest('hex')
    .slice(0, 16)
  const requestedRevision = options.asOfRevision?.trim() || null

  return {
    projectId,
    source: 'v2-ledger',
    sourceRevision,
    projectionLag: 0,
    stale: staleCount > 0 || (requestedRevision !== null && requestedRevision !== sourceRevision),
    generatedAt: Date.now(),
    rows,
    sceneNodes,
    staleCount,
  }
}
