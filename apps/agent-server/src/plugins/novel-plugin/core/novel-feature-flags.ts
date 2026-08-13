/**
 * NovelFeatureFlags：剧情推进模型 V2 的项目级灰度开关（T01）。
 *
 * 对应方案文档 §10 的五个 flag + 2026-08-07 P0/P1 增量新增 5 个 flag（PRD §5）。
 * 统一读取入口，T01 先落最小实现，T02-T05 逐步消费。默认全部关闭；
 * 未配置/缺列/解析失败一律安全返回 false。
 *
 * 存储：novel_projects.feature_flags JSON 列（migration 082），
 * 由 project-store 的 rowToProject 解析为 NovelProject.flags。
 *
 * P0/P1 新增（PRD §5，全部默认关）：
 * - 2026-08-12 逻辑统一：sceneCastV2Write / sceneCastV2Read / scenePlanV2DualWrite 已转正
 *   （Scene Cast 收敛为 novel_scene_cast 单链，旧三表停写）。
 *
 * P2 新增（统一方案 §13.1，全部默认关）：
 * - 2026-08-12 逻辑统一：appearanceV2Write / appearanceV2Read / chapterSpansFrozen 已转正
 *   （appearance 表为唯一出场写面/读面，旧列 chapter_spans / appear_chapters 冻结）。
 *
 * P3 新增（统一方案 §7/§13.1，全部默认关）：
 * - contextSummaryMode：实体档案自动 full/summary 降级（T03-4 生产接线的预留开关）
 * - crossChapterChunkCache：跨章 Chunk 版本哈希复用（§5.6）；关 = chunk 路径仍可用但不走缓存。
 *   按文档要求根据 P0 数据决定是否开启。
 *
 * P2 预留（统一方案 §13.1，默认关）：
 * - 2026-08-12 逻辑统一：memoryOperationLedger 已转正（Memory 操作审计恒开启，
 *   与 StoryEvent 语义账本并存分工：旧表记录故事语义、审计表记录系统执行）。
 *
 * P4 预留（统一方案 §13.1，默认关）：
 * - sceneLevelWriter：Writer 场景级生成灰度（未开工，开关先行预留）
 *
 * 说明：
 * - thinAgentIdentity 不实现为开关——薄身份已直接落在 role-*.md 模板，旧厚身份不存在，
 *   回滚方式为 git revert 模板（见 docs/adr/0008）。
 * - 2026-08-11 移除遗留死开关 memoryProposalV2 / matrixProjectionV2Read（无生产消费点）。
 * - 2026-08-12 逻辑统一：移除已转正的 versionChainV2Read / versionChainV2Write
 *   （版本链已收敛为 V2 不可变链单链，旧表 novel_chapter_versions 停写）；
 *   sceneCastV2Write / sceneCastV2Read / scenePlanV2DualWrite 同批转正移除
 *   （Scene Cast 收敛为 novel_scene_cast 单链）；
 *   contextChunksEnabled 同批转正移除（ContextChunk 为唯一 shared 组装路径，
 *   旧字符串路径已删除，orchestrator 恒走 chunk 组装）；
 *   appearanceV2Write / appearanceV2Read / chapterSpansFrozen 同批转正移除
 *   （appearance 表为唯一出场写面/读面，旧列冻结）；
 *   scenePlanV2Write 同批转正移除（Director/群聊 V2 计划恒写，shadow write 升为主写）；
 *   legacyNarrativeWriteDisabled 同批转正移除（scenes/arranged_entities/sceneId/sceneOrder
 *   停旧写，V2 规范字段由 plan/scene_revision 派生）；
 *   memoryOperationLedger 同批转正移除（Memory 操作审计恒开启）。
 */
import type { NovelProject } from './types.js'

export type NovelFeatureFlag =
  | 'contextSummaryMode'
  | 'crossChapterChunkCache'
  | 'sceneLevelWriter'

export const NOVEL_FEATURE_FLAGS: readonly NovelFeatureFlag[] = [
  'contextSummaryMode',
  'crossChapterChunkCache',
  'sceneLevelWriter',
]

/** 最小依赖接口：只要能按 id 拿到项目即可，避免强耦合 NovelStore */
export interface FeatureFlagProjectSource {
  getProject(id: string): Pick<NovelProject, 'flags'> | undefined
}

/**
 * 查询项目是否启用某 flag。
 *
 * - project 不存在 / flags 未配置 / 值为 undefined → false
 * - 值为布尔 → 原样返回
 * - 值为其他类型（如字符串 'true'）→ false（不做隐式转换，避免口径漂移）
 * - source 未实现 getProject（如旧测试 mock）→ false（flag 默认关语义一致，安全降级）
 */
export function isNovelFeatureEnabled(
  source: FeatureFlagProjectSource,
  projectId: string,
  flag: NovelFeatureFlag,
): boolean {
  if (typeof source.getProject !== 'function') return false
  const project = source.getProject(projectId)
  if (!project?.flags) return false
  const value = project.flags[flag]
  return typeof value === 'boolean' && value
}
