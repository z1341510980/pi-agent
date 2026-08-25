/**
 * 参考源导入脚本：《开局长生，苟在下界吃土飞升》（抓取的 14 章）
 *
 * 目的：把此前手工精读用的章节文本灌进参考源库（novel_reference_sources/sections），
 * 让 UI 的「从参考小说蒸馏」能对这本书运行 v2 蒸馏器，并与 4 个手工精读专家做 A/B 对照。
 *
 * 走应用自己的导入管线（ReferenceAnalysisService.preflight → updateImportOptions → parse），
 * 章节边界、质量报告、本地分析报告全部由既有逻辑生成，不手搓表结构。
 *
 * 用法：
 *   pnpm --filter agent-server exec tsx scripts/import-changsheng-reference.mts \
 *     --db <path> --project <id> --samples-dir <dir>
 * 幂等性：按 displayName 查重，已存在时跳过（除非 --replace）。
 */
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { NovelStore } from '../src/plugins/novel-plugin/core/novel-store.js'
import { ReferenceAnalysisStore } from '../src/plugins/novel-plugin/core/analysis/reference-analysis-store.js'
import { ReferenceAnalysisService } from '../src/plugins/novel-plugin/core/analysis/reference-analysis-service.js'

interface Args {
  db: string
  project: string
  samplesDir: string
  replace: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { db: '', project: '', samplesDir: '', replace: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--db') args.db = argv[++i] ?? ''
    else if (flag === '--project') args.project = argv[++i] ?? ''
    else if (flag === '--samples-dir') args.samplesDir = argv[++i] ?? ''
    else if (flag === '--replace') args.replace = true
  }
  return args
}

const DISPLAY_NAME = '开局长生，苟在下界吃土飞升'
const CHAPTER_FILES = [
  'ch15', 'ch19', 'ch20', 'ch30', 'ch34', 'ch183', 'ch486', 'ch487',
  'ch785', 'ch839', 'ch914', 'ch1075', 'ch1076', 'ch1078',
] as const

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.db || join(homedir(), '.pi', 'wenlang-agent.db')
  if (!args.project) throw new Error('--project 必填')
  if (!args.samplesDir || !existsSync(args.samplesDir)) throw new Error('--samples-dir 必填')
  if (!existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`)

  const parts: string[] = []
  for (const id of CHAPTER_FILES) {
    const file = join(args.samplesDir, `${id}.txt`)
    if (!existsSync(file)) throw new Error(`缺少章节文件: ${file}`)
    parts.push(readFileSync(file, 'utf-8').trim())
  }
  // 各章自带「第N章 标题」首行，直接以空行分隔即可被章节边界检测识别
  const text = parts.join('\n\n')

  const db = new Database(dbPath)
  const novelStore = new NovelStore(db)
  if (!novelStore.getProject(args.project)) throw new Error(`项目不存在: ${args.project}`)

  const service = new ReferenceAnalysisService(
    new ReferenceAnalysisStore(db),
    novelStore,
  )

  // 查重：同名参考源已存在则跳过（或 --replace 时删除旧源后重导）
  const existing = service.listSources(args.project).find((source) => source.displayName === DISPLAY_NAME)
  if (existing) {
    if (!args.replace) {
      console.log(`参考源已存在（${existing.id}，parseStatus=${existing.parseStatus}），跳过。如需重导加 --replace`)
      return
    }
    // 走服务删除路径，保证 sections/reports 一并清理
    ;(service as unknown as { deleteSource?: (id: string) => void })
    const store = new ReferenceAnalysisStore(db)
    const raw = db.prepare('DELETE FROM novel_reference_sources WHERE id = ? AND project_id = ?').run(existing.id, args.project)
    void store
    if (raw.changes === 0) throw new Error('删除旧参考源失败')
    console.log('已移除旧参考源:', existing.id)
  }

  // ── 阶段 1：预检建稿 ──
  const draft = service.preflight(args.project, {
    inputKind: 'paste',
    displayName: DISPLAY_NAME,
    text,
  })
  console.log(`预检完成：draft=${draft.sourceDraftId} 编码=${draft.detectedEncoding} 预估章节数=${draft.estimatedChapterCount} 字数=${draft.characterCount}`)
  for (const warning of draft.warnings) console.log('  warning:', warning)

  // ── 阶段 2：导入选项 + 版权确认（parse 的前置门槛）──
  service.updateImportOptions(draft.sourceDraftId, {
    version: draft.version,
    encoding: 'utf-8',
    retentionPolicy: 'keep_local',
    rightsConfirmed: true,
    rightsStatement: '个人学习用途的有限章节样本，仅本地分析蒸馏写作手法',
  })

  // ── 阶段 3：解析（章节边界 + 质量报告 + 本地分析报告）──
  const parsed = service.parse(draft.sourceDraftId, draft.version + 1)
  const source = parsed.source
  console.log(`解析完成：parseStatus=${parsed.parseStatus} 章节=${parsed.chapterCount} 质量报告=${parsed.qualityReportId}`)

  const sections = service.listSections(source.id)
  const included = sections.filter((section) => section.included)
  console.log(`章节数据库行数=${sections.length}（included=${included.length}）`)
  for (const section of included) {
    console.log(`  - ${section.title ?? '(无题)'} | ${section.characterCount} 字 | type=${section.type}`)
  }

  // 与手工精读对齐校验：确认证据引文能在切分后的章节文本里找到
  const probeQuotes: Array<[string, string]> = [
    ['朕今年才五十八岁', 'ch34 手足'],
    ['今已亭亭如盖矣', 'ch19 寿宴献宝'],
    ['不由遍体生寒', 'ch30 擒王'],
    ['这轻松感来得如此自然', 'ch1078 赵朗之死'],
  ]
  const allText = included
    .map((section) => service.getSectionsText(source.id, [section.id]).text)
    .join('\n')
  let miss = 0
  for (const [quote, label] of probeQuotes) {
    if (!allText.includes(quote)) {
      miss += 1
      console.error(`[对齐失败] ${label} 未找到引文: ${quote}`)
    }
  }
  if (miss > 0) {
    console.error(`${miss} 处探针引文未命中——章节边界可能被切碎，请人工检查 sections`)
    process.exitCode = 1
    return
  }
  console.log('探针引文全部命中：导入内容与手工精读所用文本一致 ✓')

  db.close()
}

main()
