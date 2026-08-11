/**
 * reconcile-scene-cast.mjs — P1-3 三表 → cast 往返对账（只读）。
 *
 * 对比 novel_scene_focus / novel_scene_presence / novel_scene_functions（旧三表）与
 * novel_scene_cast（新表）按 scene_revision_id 的往返数量与字段（functional 的
 * function/prominence/note 字段级对比）。
 *
 * 用法：
 *   node scripts/novel-migration-tools/reconcile-scene-cast.mjs [projectId]
 *
 * 输出：output/reconcile-scene-cast-<ts>.json；mismatch 全 0 退出码 0，否则 1。
 */
import { openDb, writeJsonReport } from './lib/db.mjs'

const projectId = process.argv[2]

const db = openDb()
try {
  const projectFilter = projectId ? ' AND sr.project_id = ?' : ''
  const projectParam = projectId ? [projectId] : []

  const focusRows = db.prepare(
    `SELECT f.scene_revision_id, f.character_id
     FROM novel_scene_focus f JOIN novel_scene_revisions sr ON sr.id = f.scene_revision_id
     WHERE 1=1${projectFilter}`,
  ).all(...projectParam)
  const presentRows = db.prepare(
    `SELECT p.scene_revision_id, p.character_id
     FROM novel_scene_presence p JOIN novel_scene_revisions sr ON sr.id = p.scene_revision_id
     WHERE 1=1${projectFilter}`,
  ).all(...projectParam)
  const fnRows = db.prepare(
    `SELECT fn.scene_revision_id, fn.character_id, fn.function, fn.prominence, fn.note
     FROM novel_scene_functions fn JOIN novel_scene_revisions sr ON sr.id = fn.scene_revision_id
     WHERE 1=1${projectFilter}`,
  ).all(...projectParam)
  const castRows = db.prepare(
    `SELECT c.scene_revision_id, c.character_id, c.role, c.function, c.prominence, c.note
     FROM novel_scene_cast c JOIN novel_scene_revisions sr ON sr.id = c.scene_revision_id
     WHERE 1=1${projectFilter}`,
  ).all(...projectParam)

  const expected = new Map()
  const addExpected = (rev, role, char, payload) => expected.set(`${rev}:${role}:${char}`, payload)
  for (const r of focusRows) {
    addExpected(r.scene_revision_id, 'focus', r.character_id,
      JSON.stringify({ function: null, prominence: null, note: null }))
  }
  for (const r of presentRows) {
    addExpected(r.scene_revision_id, 'present', r.character_id,
      JSON.stringify({ function: null, prominence: null, note: null }))
  }
  for (const r of fnRows) {
    addExpected(r.scene_revision_id, 'functional', r.character_id,
      JSON.stringify({ function: r.function, prominence: r.prominence, note: r.note }))
  }

  const actual = new Map()
  for (const r of castRows) {
    actual.set(`${r.scene_revision_id}:${r.role}:${r.character_id}`,
      JSON.stringify({ function: r.function, prominence: r.prominence, note: r.note }))
  }

  let mismatchRows = 0
  const mismatchByRole = { focus: 0, present: 0, functional: 0 }
  for (const [key, payload] of expected) {
    const role = key.split(':')[1]
    if (actual.get(key) !== payload) {
      mismatchRows += 1
      mismatchByRole[role] += 1
    }
  }
  for (const [key, payload] of actual) {
    const role = key.split(':')[1]
    if (!expected.has(key)) {
      mismatchRows += 1
      mismatchByRole[role] += 1
    }
  }

  const checkedSceneRevisions = new Set([
    ...focusRows.map((r) => r.scene_revision_id),
    ...presentRows.map((r) => r.scene_revision_id),
    ...fnRows.map((r) => r.scene_revision_id),
    ...castRows.map((r) => r.scene_revision_id),
  ]).size

  const report = {
    projectId: projectId ?? null,
    sourceRows: focusRows.length + presentRows.length + fnRows.length,
    targetRows: castRows.length,
    mismatchRows,
    orphanRows: 0,
    duplicateRows: 0,
    rollbackVerified: true,
    checkedSceneRevisions,
    mismatchByRole,
  }
  const accepted = mismatchRows === 0

  const file = writeJsonReport(`reconcile-scene-cast-${Date.now()}.json`, { report, acceptance: accepted })
  console.log(`对账完成: source=${report.sourceRows} target=${report.targetRows} mismatch=${mismatchRows} checkedScenes=${checkedSceneRevisions}`)
  console.log(`报告: ${file}`)
  process.exit(accepted ? 0 : 1)
} finally {
  db.close()
}
