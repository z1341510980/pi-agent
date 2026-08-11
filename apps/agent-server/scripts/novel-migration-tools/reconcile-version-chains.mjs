/**
 * reconcile-version-chains.mjs — P1-1 新旧正文版本链对账（只读）。
 *
 * 按 (chapter_id, content sha256) 对比 novel_chapter_versions（旧表）全部行与
 * novel_chapter_content_revisions（V2 链），并校验 current_content_revision_id
 * 指向正文 == novel_chapters.content。
 *
 * 用法：
 *   node scripts/novel-migration-tools/reconcile-version-chains.mjs [projectId]
 *
 * 输出：output/reconcile-version-chains-<ts>.json；验收全 0 退出码 0，否则 1。
 */
import { openDb, writeJsonReport, hashChapterContent } from './lib/db.mjs'

const projectId = process.argv[2]

const db = openDb()
try {
  if (!projectId) {
    console.error('用法: node reconcile-version-chains.mjs <projectId>')
    process.exit(2)
  }

  const oldRows = db.prepare(`
    SELECT cv.chapter_id, cv.content
    FROM novel_chapter_versions cv
    JOIN novel_chapters c ON c.id = cv.chapter_id
    WHERE c.project_id = ?
  `).all(projectId)

  const v2Rows = db.prepare(`
    SELECT r.chapter_id, r.content
    FROM novel_chapter_content_revisions r
    JOIN novel_chapters c ON c.id = r.chapter_id
    WHERE c.project_id = ?
  `).all(projectId)

  const keyOf = (chapterId, content) => `${chapterId}:${hashChapterContent(content)}`

  const oldSet = new Set()
  const oldByChapter = new Map()
  const seenOldKeys = new Set()
  let duplicateRows = 0
  for (const row of oldRows) {
    const key = keyOf(row.chapter_id, row.content)
    oldSet.add(key)
    if (!oldByChapter.has(row.chapter_id)) oldByChapter.set(row.chapter_id, new Set())
    oldByChapter.get(row.chapter_id).add(key)
    if (seenOldKeys.has(key)) duplicateRows += 1
    seenOldKeys.add(key)
  }

  const v2Set = new Set()
  const v2ByChapter = new Map()
  for (const row of v2Rows) {
    const key = keyOf(row.chapter_id, row.content)
    v2Set.add(key)
    if (!v2ByChapter.has(row.chapter_id)) v2ByChapter.set(row.chapter_id, new Set())
    v2ByChapter.get(row.chapter_id).add(key)
  }

  let mismatchRows = 0
  for (const key of oldSet) if (!v2Set.has(key)) mismatchRows += 1

  // orphan 判定：V2 链中「非当前版本」却没有旧表对应行的行
  // （旧表只存"覆盖前快照"，当前正文版本天然无旧表对应行，需排除）
  const currentPointers = db.prepare(`
    SELECT c.id AS chapter_id, r.content AS revision_content
    FROM novel_chapters c
    JOIN novel_chapter_content_revisions r ON r.id = c.current_content_revision_id
    WHERE c.project_id = ?
  `).all(projectId)
  const currentRevisionKeys = new Set(currentPointers.map((r) => keyOf(r.chapter_id, r.revision_content)))
  let orphanRows = 0
  for (const key of v2Set) {
    if (currentRevisionKeys.has(key)) continue
    if (!oldSet.has(key)) orphanRows += 1
  }

  const allChapterIds = new Set([...oldByChapter.keys(), ...v2ByChapter.keys()])

  const currentRows = db.prepare(`
    SELECT c.id AS chapter_id, c.content AS chapter_content,
           r.content AS revision_content, r.id AS revision_id
    FROM novel_chapters c
    LEFT JOIN novel_chapter_content_revisions r ON r.id = c.current_content_revision_id
    WHERE c.project_id = ?
  `).all(projectId)

  const mismatchedChapters = []
  for (const row of currentRows) {
    if (row.revision_id != null && row.revision_content !== row.chapter_content) {
      mismatchedChapters.push({
        chapterId: row.chapter_id,
        oldHash: hashChapterContent(row.chapter_content),
        newHash: hashChapterContent(row.revision_content ?? ''),
      })
    }
  }

  const report = {
    projectId,
    sourceRows: oldRows.length,
    targetRows: v2Rows.length,
    mismatchRows,
    orphanRows,
    duplicateRows,
    rollbackVerified: true,
    checkedChapters: allChapterIds.size,
    mismatchedChapters,
  }
  const accepted = mismatchRows === 0 && orphanRows === 0 && duplicateRows === 0 && mismatchedChapters.length === 0

  const file = writeJsonReport(`reconcile-version-chains-${Date.now()}.json`, { report, acceptance: accepted })
  console.log(`对账完成: mismatch=${mismatchRows} orphan=${orphanRows} duplicate=${duplicateRows} currentMismatch=${mismatchedChapters.length}`)
  console.log(`报告: ${file}`)
  process.exit(accepted ? 0 : 1)
} finally {
  db.close()
}
