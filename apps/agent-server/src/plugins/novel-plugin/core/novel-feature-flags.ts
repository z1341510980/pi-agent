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
 * - versionChainV2Read：前端版本面板、历史回滚 API 读源切到 content_revisions
 * - versionChainV2Write：新正文只写 V2 版本链（旧表停止 INSERT）
 * - logPayloadExternalized：Agent 日志大文本写入 payload 表（gzip）
 * - sceneCastV2Write：Scene 角色只写 novel_scene_cast（三表停新增）
 * - sceneCastV2Read：ScenePlan 往返读取 cast 表
 *
 * P2 新增（统一方案 §13.1，全部默认关）：
 * - appearanceV2Write：实体出场同时写入 novel_entity_appearances（双写）
 * - appearanceV2Read：读取"章节出场实体"改走 novel_entity_appearances
 * - chapterSpansFrozen：chapter_spans / appear_chapters 旧列冻结（停写），
 *   传入的出场更新转写 novel_entity_appearances（P2 收官）。与 appearanceV2Read 搭配使用。
 *
 * P3 新增（统一方案 §7，全部默认关）：
 * - contextChunksEnabled：shared 上下文按 ContextChunk 构建（T03-2 起消费）；关 = 旧字符串路径
 */
import type { NovelProject } from './types.js'

export type NovelFeatureFlag =
  | 'scenePlanV2Write'
  | 'scenePlanV2DualWrite'
  | 'memoryProposalV2'
  | 'matrixProjectionV2Read'
  | 'legacyNarrativeWriteDisabled'
  | 'versionChainV2Read'
  | 'versionChainV2Write'
  | 'logPayloadExternalized'
  | 'sceneCastV2Write'
  | 'sceneCastV2Read'
  | 'appearanceV2Write'
  | 'appearanceV2Read'
  | 'chapterSpansFrozen'
  | 'contextChunksEnabled'

export const NOVEL_FEATURE_FLAGS: readonly NovelFeatureFlag[] = [
  'scenePlanV2Write',
  'scenePlanV2DualWrite',
  'memoryProposalV2',
  'matrixProjectionV2Read',
  'legacyNarrativeWriteDisabled',
  'versionChainV2Read',
  'versionChainV2Write',
  'logPayloadExternalized',
  'sceneCastV2Write',
  'sceneCastV2Read',
  'appearanceV2Write',
  'appearanceV2Read',
  'chapterSpansFrozen',
  'contextChunksEnabled',
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
