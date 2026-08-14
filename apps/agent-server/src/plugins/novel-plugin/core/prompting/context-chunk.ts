/**
 * ContextChunk：Context Chunk 契约（P3 T03-1）
 *
 * 目标（统一方案 §5.2）：把 shared 上下文从"一个大字符串"拆成独立、可标注、可降级的
 * Chunk，为 token 预算降级（T03-7）、角色策略（T03-3）、实体 summary（T03-4）提供基础。
 *
 * 本模块只定义**契约与目录**（不改变生成路径）：
 * - ContextChunk 类型：id / priority / mode / 预估 token / 对应现有 section 构建方法
 * - CHUNK_CATALOG：代码实际 section → chunk 的映射（可观测性 + T03-2 等价拆块的验收基线）
 *
 * 生成路径改造（buildChapterContextShared 按 chunk 输出）在 T03-2「旧 shared 等价拆块」
 * 实施；本模块只保证"目录不漂移"（测试钉死映射）。
 *
 * 2026-08-12 逻辑统一：ContextChunk 为唯一 shared 组装路径（orchestrator 恒走 chunk），
 * 旧字符串路径已删除。
 */

/** Chunk 模式（§5.2）：full=完整注入；summary=摘要注入；on-demand=按需检索；disabled=不注入 */
export type ChunkMode = 'full' | 'summary' | 'on-demand' | 'disabled'
/** Chunk 优先级（§5.2）：required=必选；recommended=推荐；optional=可选 */
export type ChunkPriority = 'required' | 'recommended' | 'optional'
/** Chunk 所在上下文层：semi-shared=章前共享层；semi-suffix=Agent 专属后缀 */
export type ChunkLayer = 'semi-shared' | 'semi-suffix'

export interface ContextChunk {
  /** 稳定 chunk 标识（作为缓存 key 与降级单位） */
  id: string
  /** 中文标题（前端展示 / 审计） */
  title: string
  priority: ChunkPriority
  /** 默认模式（角色策略可覆盖，见 ROLE_CONTEXT_POLICIES） */
  defaultMode: ChunkMode
  layer: ChunkLayer
  /** 现有 prompt-builder 中构建该 section 的方法名（目录不漂移的锚点） */
  builderMethod: string
  /** 预估 token 成本级别：s=小段(<200 tokens)；m=中段(200-800)；l=大段(>800) */
  sizeTier: 's' | 'm' | 'l'
}

/**
 * Chunk 目录：以 buildChapterContextShared / buildChapterContextSuffix 的真实 section
 * 为准（可观测性优先），统一方案 §5.2 的 13 个建议 chunk 作为目标规范，
 * 差异在契约文档 §映射中标注（如 story-state/voice-contrast/entity-edges 为代码实际
 * 存在而方案未单列的 section）。
 */
export const CHUNK_CATALOG: readonly ContextChunk[] = [
  // ── semi-shared：章前共享层（buildChapterContextShared）──
  { id: 'chapter-info', title: '章节信息', priority: 'required', defaultMode: 'full', layer: 'semi-shared', builderMethod: 'formatChapterInfo', sizeTier: 'm' },
  { id: 'chapter-constraints', title: '创作约束', priority: 'required', defaultMode: 'full', layer: 'semi-shared', builderMethod: 'formatConstraints', sizeTier: 'm' },
  { id: 'arranged-entities', title: '本章编排实体', priority: 'required', defaultMode: 'full', layer: 'semi-shared', builderMethod: 'formatArrangedEntities', sizeTier: 'l' },
  { id: 'story-state', title: '全量故事状态', priority: 'recommended', defaultMode: 'full', layer: 'semi-shared', builderMethod: 'formatStoryState', sizeTier: 'l' },
  { id: 'voice-contrast', title: '角色声音对照', priority: 'optional', defaultMode: 'summary', layer: 'semi-shared', builderMethod: 'formatVoiceContrastTable', sizeTier: 'm' },
  { id: 'story-ledger', title: '事件账本承接', priority: 'required', defaultMode: 'summary', layer: 'semi-shared', builderMethod: 'formatStoryLedgerContext', sizeTier: 'l' },
  { id: 'entity-edges', title: '实体关联边', priority: 'recommended', defaultMode: 'full', layer: 'semi-shared', builderMethod: 'formatEdges', sizeTier: 'm' },
  { id: 'info-layers', title: '信息差', priority: 'required', defaultMode: 'summary', layer: 'semi-shared', builderMethod: 'formatInfoLayers', sizeTier: 'm' },
  { id: 'recent-recaps', title: '最近章节摘要', priority: 'recommended', defaultMode: 'summary', layer: 'semi-shared', builderMethod: 'formatRecentSummaries', sizeTier: 'm' },
  { id: 'prev-ending', title: '上一章结尾', priority: 'required', defaultMode: 'full', layer: 'semi-shared', builderMethod: 'formatPreviousChapterEnding', sizeTier: 's' },
  { id: 'sound-anchor', title: '叙事声音锚点', priority: 'optional', defaultMode: 'summary', layer: 'semi-shared', builderMethod: 'formatSoundAnchor', sizeTier: 's' },
  { id: 'next-anchor', title: '下一章开头', priority: 'required', defaultMode: 'full', layer: 'semi-shared', builderMethod: 'formatNextChapterAnchor', sizeTier: 's' },
  { id: 'hooks', title: '未兑现钩子', priority: 'required', defaultMode: 'full', layer: 'semi-shared', builderMethod: 'formatUnfulfilledHooks', sizeTier: 'm' },
  { id: 'style-fingerprint', title: '文风指纹', priority: 'optional', defaultMode: 'summary', layer: 'semi-shared', builderMethod: 'formatStyleFingerprint', sizeTier: 'm' },
  // ── semi-suffix：Agent 专属后缀（buildChapterContextSuffix）──
  { id: 'director-scheme', title: '宏观节奏与反馈回流', priority: 'required', defaultMode: 'full', layer: 'semi-suffix', builderMethod: 'formatMacroRhythm', sizeTier: 'm' },
  { id: 'reviewer-rubric', title: '平台标准与验收', priority: 'required', defaultMode: 'full', layer: 'semi-suffix', builderMethod: 'formatPlatformRubric', sizeTier: 'm' },
  { id: 'writer-instruction', title: '创作指令', priority: 'required', defaultMode: 'full', layer: 'semi-suffix', builderMethod: 'chapter-instruction', sizeTier: 's' },
]

/** Chunk 目录索引：id → chunk */
export const CHUNK_BY_ID: ReadonlyMap<string, ContextChunk> = new Map(
  CHUNK_CATALOG.map((c) => [c.id, c]),
)

/**
 * 角色上下文策略（§5.3 示例的代码化，T03-3 落地）。
 *
 * 语义（安全优先，满足 P3 退出条件"必要事实不丢失"）：
 * - 策略是角色的"关注集"：列出的 chunk 按指定 mode 注入；
 * - **未列出的 chunk 按目录 defaultMode 注入**（不丢信息，仅作目录兜底）；
 * - `disabled` 为显式排除（只有策略显式标注才不注入）；
 * - `summary` / `on-demand` 在 T03-4 / T03-5 落地前由 resolveChunkMode 兜底为 full
 *   （摘要降级依赖实体 summary 能力，未就绪前保持完整注入）。
 */
export const ROLE_CONTEXT_POLICIES: Readonly<Record<string, ReadonlyArray<{ chunkId: string; mode: ChunkMode }>>> = {
  // 决策者：章信息 / 承接 / 前章锚点 / 钩子 / 节奏方案；不创作 → 声音对照禁用
  director: [
    { chunkId: 'chapter-info', mode: 'full' },
    { chunkId: 'story-ledger', mode: 'summary' },
    { chunkId: 'recent-recaps', mode: 'summary' },
    { chunkId: 'prev-ending', mode: 'full' },
    { chunkId: 'next-anchor', mode: 'full' },
    { chunkId: 'hooks', mode: 'full' },
    { chunkId: 'director-scheme', mode: 'full' },
    { chunkId: 'voice-contrast', mode: 'disabled' },
  ],
  // 创作者：章信息 / 约束 / 编排 / 承接 / 信息差 / 前章承接 / 声音 / 文风 / 创作指令
  writer: [
    { chunkId: 'chapter-info', mode: 'full' },
    { chunkId: 'chapter-constraints', mode: 'full' },
    { chunkId: 'arranged-entities', mode: 'full' },
    { chunkId: 'story-ledger', mode: 'summary' },
    { chunkId: 'info-layers', mode: 'summary' },
    { chunkId: 'recent-recaps', mode: 'summary' },
    { chunkId: 'prev-ending', mode: 'full' },
    { chunkId: 'sound-anchor', mode: 'summary' },
    { chunkId: 'style-fingerprint', mode: 'summary' },
    { chunkId: 'writer-instruction', mode: 'full' },
  ],
  // 审稿：编排核对 / 承接 / 质量规则；不创作 → 声音对照禁用
  reviewer: [
    { chunkId: 'chapter-info', mode: 'full' },
    { chunkId: 'arranged-entities', mode: 'summary' },
    { chunkId: 'story-ledger', mode: 'summary' },
    { chunkId: 'reviewer-rubric', mode: 'full' },
    { chunkId: 'voice-contrast', mode: 'disabled' },
  ],
  // 修订：当前章承接 / 前章结尾 / 文风基准
  reviser: [
    { chunkId: 'chapter-info', mode: 'full' },
    { chunkId: 'story-ledger', mode: 'summary' },
    { chunkId: 'prev-ending', mode: 'full' },
    { chunkId: 'style-fingerprint', mode: 'summary' },
  ],
  // 记忆：承接 / 编排 / 钩子；不创作且与文风无关 → 声音/文风类禁用
  memory: [
    { chunkId: 'story-ledger', mode: 'summary' },
    { chunkId: 'arranged-entities', mode: 'summary' },
    { chunkId: 'hooks', mode: 'full' },
    { chunkId: 'next-anchor', mode: 'full' },
    { chunkId: 'voice-contrast', mode: 'disabled' },
    { chunkId: 'sound-anchor', mode: 'disabled' },
    { chunkId: 'style-fingerprint', mode: 'disabled' },
  ],
}

/** 角色类型：覆盖创作链路全部 Agent（未知角色按目录默认兜底） */
export type RoleAgentType = 'director' | 'writer' | 'reviewer' | 'reviser' | 'memory'

/**
 * 解析角色对指定 chunk 的注入模式（T03-3）。
 *
 * 优先级：角色策略显式 mode > 目录 defaultMode。
 * 兜底规则（T03-4/5 前）：summary / on-demand 视为 full（摘要/按需检索能力未落地，
 * 保持完整注入不丢信息）；disabled 为显式排除。
 */
export function resolveChunkMode(
  agentType: string,
  chunkId: string,
): ChunkMode {
  const policy = ROLE_CONTEXT_POLICIES[agentType]?.find((p) => p.chunkId === chunkId)
  if (!policy) return CHUNK_BY_ID.get(chunkId)?.defaultMode ?? 'disabled'
  if (policy.mode === 'summary' || policy.mode === 'on-demand') {
    return 'full' // T03-4/5 落地后改为真实降级
  }
  return policy.mode
}
