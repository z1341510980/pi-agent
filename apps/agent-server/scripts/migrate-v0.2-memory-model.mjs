#!/usr/bin/env node
/**
 * v0.2 数据迁移 CLI：将 v0.1 错位数据归位到正确的实体表
 *
 * 迁移内容：
 * 1. type=inner 且无对抗方的冲突 → 角色弧光
 * 2. 补填 chapter_ending_hook 镜像（从 novel_hooks 回填）
 *
 * 用法：node scripts/migrate-v0.2-memory-model.mjs <projectId> [--dry-run]
 *
 * 数据库路径（与 database.plugin.ts 保持一致）：
 *   - 默认：~/.pi/wenlang-agent.db
 *   - 可用 PI_DATA_DIR 覆盖数据目录，或 PI_DB_PATH 直接指定数据库文件
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

const projectId = process.argv[2]
const dryRun = process.argv.includes('--dry-run')

if (!projectId) {
  console.error('用法：node scripts/migrate-v0.2-memory-model.mjs <projectId> [--dry-run]')
  process.exit(1)
}

// 数据库路径：与 database.plugin.ts 一致（PI_DATA_DIR 覆盖数据目录）
const dataDir = process.env.PI_DATA_DIR ?? join(homedir(), '.pi')
const dbPath = process.env.PI_DB_PATH ?? join(dataDir, 'wenlang-agent.db')
console.log(`数据库路径：${dbPath}`)

// dry-run 模式以只读方式打开，物理上无法写入
const db = new Database(dbPath, dryRun ? { readonly: true } : {})

console.log(`项目 ID：${projectId}`)
console.log(`模式：${dryRun ? 'DRY RUN（只读，不写入）' : '执行（写入）'}`)
console.log('---')

// 迁移1：type=inner 且无对抗方的冲突 → 角色弧光
// 对抗方判定：inner 冲突本就是角色内心状态，participants 数量决定是否有对抗方
//   - 1 个参与者：即该角色自身，无对抗方 → 转弧光
//   - 0 个参与者：无法判定角色 → 跳过（需人工处理）
//   - 2+ 个参与者：存在对抗方 → 保留为冲突
const innerConflicts = db.prepare(
  "SELECT * FROM novel_conflicts WHERE project_id = ? AND type = 'inner'"
).all(projectId)

console.log(`\n[迁移1] 发现 ${innerConflicts.length} 条 type=inner 的冲突`)

const arcPlans = []
for (const c of innerConflicts) {
  let participants = []
  try { participants = JSON.parse(c.participants) } catch {}
  if (!Array.isArray(participants)) participants = []
  const participantCount = participants.length
  const hasOpposingParty = participantCount >= 2

  console.log(`  - ${c.id}: ${String(c.description || '').slice(0, 60)}`)
  console.log(`    participants: ${JSON.stringify(participants)}`)

  if (hasOpposingParty) {
    console.log(`    → 有对抗方（${participantCount} 个参与者），保留为冲突`)
    continue
  }

  // 无对抗方 → 转角色弧光，从 participants 提取 characterId
  const characterId = participantCount === 1 && typeof participants[0] === 'string' ? participants[0] : null
  if (!characterId) {
    console.log(`    ⚠️ 无法自动提取 characterId（participants 为空或格式不对），跳过（需人工处理）`)
    continue
  }

  // 推断 arcType（简单启发式，需人工确认）
  const arcType = c.description.includes('认知') || c.description.includes('信念') ? 'shift' : 'growth'
  const stage = arcType === 'shift' ? 'disruption' : 'resistance'

  const chapterSpans = JSON.parse(c.chapter_spans || '[]')
  const chapterNumber = chapterSpans[0]?.[0] ?? 1

  console.log(`    → 转为角色弧光：characterId=${characterId}, arcType=${arcType}, stage=${stage}, chapterNumber=${chapterNumber}`)

  arcPlans.push({
    conflictId: c.id,
    characterId,
    arcType,
    stage,
    chapterNumber,
    description: c.description,
  })
}

// 迁移2：补填 chapter_ending_hook 镜像（从 novel_hooks 回填，每章取第一条）
const hooksByChapter = {}
const hooks = db.prepare('SELECT * FROM novel_hooks WHERE project_id = ?').all(projectId)
for (const h of hooks) {
  if (!hooksByChapter[h.chapter_number]) hooksByChapter[h.chapter_number] = h
}
console.log(`\n[迁移2] 发现 ${hooks.length} 条钩子实体，补填 chapter_ending_hook 镜像`)

const hookPlans = []
for (const [chNum, hook] of Object.entries(hooksByChapter)) {
  console.log(`  - 第${chNum}章：${hook.hook_type}`)
  hookPlans.push({ chapterNumber: Number(chNum), hookType: hook.hook_type })
}

// 执行写入（dry-run 模式下不写入任何数据）
if (dryRun) {
  console.log('\n---')
  console.log('DRY RUN 完成，未写入任何数据')
  console.log(`  计划创建弧光：${arcPlans.length} 条`)
  console.log(`  计划补填钩子镜像：${hookPlans.length} 章`)
} else {
  const insertArc = db.prepare(`
    INSERT INTO novel_character_arcs (id, project_id, character_id, arc_type, current_stage, stage_history, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  `)
  const updateChapterHook = db.prepare(
    'UPDATE novel_chapters SET chapter_ending_hook = ? WHERE project_id = ? AND chapter_number = ?'
  )

  // 单事务保证原子性：全部成功或全部回滚
  const tx = db.transaction(() => {
    for (const p of arcPlans) {
      const arcId = randomUUID()
      insertArc.run(
        arcId,
        projectId,
        p.characterId,
        p.arcType,
        p.stage,
        JSON.stringify([{ stage: p.stage, triggerEvent: p.description, description: p.description, chapterNumber: p.chapterNumber, changedAt: Math.floor(Date.now() / 1000) }]),
        p.description,
      )
      console.log(`  ✓ 已创建弧光 ${arcId}（来自冲突 ${p.conflictId}）`)
    }
    for (const p of hookPlans) {
      const res = updateChapterHook.run(p.hookType, projectId, p.chapterNumber)
      console.log(`  ✓ 第${p.chapterNumber}章 chapter_ending_hook 已更新为 ${p.hookType}（影响 ${res.changes} 行）`)
    }
  })
  tx()

  console.log('\n---')
  console.log(`迁移完成：创建弧光 ${arcPlans.length} 条，补填钩子镜像 ${hookPlans.length} 章`)
}

db.close()
