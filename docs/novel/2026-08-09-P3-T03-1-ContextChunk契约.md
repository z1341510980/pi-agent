# P3 T03-1：Context Chunk 契约

> 日期：2026-08-09
> 范围：Context Chunk 协议定义 + Chunk 目录（映射现有 prompt-builder section）+ flag
> 来源：统一方案 §5.2 / §5.3 / §11（T03-1）
> 状态：契约已落地（代码 + 测试），生成路径改造在 T03-2

---

## 1. 目标

把 shared 上下文从"一个大字符串"拆成独立、可标注、可降级的 Chunk：

```ts
type ChunkMode = 'full' | 'summary' | 'on-demand' | 'disabled'
type ChunkPriority = 'required' | 'recommended' | 'optional'

interface ContextChunk {
  id: string
  title: string
  priority: ChunkPriority
  defaultMode: ChunkMode
  layer: 'semi-shared' | 'semi-suffix'
  builderMethod: string   // 现有 prompt-builder 构建该 section 的方法名（目录锚点）
  sizeTier: 's' | 'm' | 'l'
}
```

**本任务只定义契约与目录，不改生成路径**——生成行为零变化（flag 默认关），
为 T03-2（等价拆块）、T03-3（角色策略）、T03-7（预算降级）提供地基。

## 2. Chunk 目录（代码真实 section → chunk）

以 `buildChapterContextShared` 的真实 parts.push 为准（可观测性优先），
统一方案 §5.2 的 13 个建议 chunk 为目标规范。映射如下：

| Chunk id | 标题 | 优先级 | 默认模式 | 现有构建方法 | sizeTier |
|---|---|---|---|---|---|
| chapter-info | 章节信息 | required | full | `formatChapterInfo` | m |
| chapter-constraints | 创作约束 | required | full | `formatConstraints` | m |
| arranged-entities | 本章编排实体 | required | full | `formatArrangedEntities` | l |
| story-state | 全量故事状态 | recommended | full | `formatStoryState` | l |
| voice-contrast | 角色声音对照 | optional | summary | `formatVoiceContrastTable` | m |
| story-ledger | 事件账本承接 | required | summary | `formatStoryLedgerContext` | l |
| entity-edges | 实体关联边 | recommended | full | `formatEdges` | m |
| info-layers | 信息差 | required | summary | `formatInfoLayers` | m |
| recent-recaps | 最近章节摘要 | recommended | summary | `formatRecentSummaries` | m |
| prev-ending | 上一章结尾 | required | full | `formatPreviousChapterEnding` | s |
| sound-anchor | 叙事声音锚点 | optional | summary | `formatSoundAnchor` | s |
| next-anchor | 下一章开头 | required | full | `formatNextChapterAnchor` | s |
| style-fingerprint | 文风指纹 | optional | summary | `formatStyleFingerprint` | m |

### 与 §5.2 建议 Chunk 的差异说明

- **代码独有、方案未单列**：`chapter-constraints`（创作约束）、`story-state`（无编排路径的
  全量状态）、`voice-contrast`（角色声音对照）、`entity-edges`（实体关联边）、
  `prev-ending` / `sound-anchor` / `next-anchor`（前后章锚点）——按代码实际 section 纳入目录。
- **hooks 归属修正（T03-2 实测）**：方案标注 hooks 属 suffix 层，但代码实际在 shared 层的
  anchor 中（`formatUnfulfilledHooks`，collectChapterAnchorChunks 第 5 子段）——已按代码归入
  semi-shared 目录（required/full）。
- **方案建议但属 suffix 层**：`narrative-task` / `style-profile` / `quality-rules`
  由 `buildChapterContextSuffix` 构建（Agent 专属层），chunk 化归 T03-2 后半（suffix 拆分）。
- **方案建议的语义子集**：`active-conflicts` / `pending-foreshadows` / `active-clues` 是
  `story-state` 内部段落，T03-4（实体 summary）时按子段落细分。

## 3. 角色策略基线（T03-3 细化）

`ROLE_CONTEXT_POLICIES` 已登记 director/writer/reviewer/reviser/memory 的 chunk 级策略
（结构先行，实际注入策略 T03-3 落地）。策略形式：`{ chunkId, mode }[]`。

## 4. Flag 与回滚

- `contextChunksEnabled`（默认关，NOVEL_FEATURE_FLAGS=14）
- 关 = 完全走旧字符串路径（`buildChapterContextShared` 原样输出），零行为变化
- 开（T03-2 起） = 按 chunk 构建 shared；回滚 = 关 flag 即回旧路径

## 5. 验收与测试

- `novel-context-chunk.test.ts` 4/4：目录结构合法（id 唯一/枚举合法）/
  builderMethod 锚点与 prompt-builder.ts 源码对应（防目录漂移）/
  §5.2 核心 chunk 齐全 / flag 注册且总数 14
- flag 测试更新：NOVEL_FEATURE_FLAGS 13 → 14

## 6. 下一步（T03-2 等价拆块）

1. `buildChapterContextShared` 改造为返回 `ContextChunk[]`（每个 chunk 复用现有
   format 方法，full 模式拼接结果与现字符串**逐字节等价**——等价性作为测试断言）
2. context-preview 按 chunk 展示（现有 section 视图下沉一级）
3. suffix 层 chunk 化（narrative-task / style-profile / quality-rules / hooks）

> 依赖 P0 数据的部分（跨章缓存决策）等采样数据积累后由 T03 末尾统一评估。

---

## 7. T03-2 等价拆块（已完成，2026-08-09）

- **prompt-builder 重构**（单一来源，不漂移）：
  - 新增 `buildChapterContextChunks()`：按 CHUNK_CATALOG 输出 shared 层 chunk 数组
    （full 模式：chapter-info / constraints / arranged-entities / story-state / voice-contrast /
    story-ledger / entity-edges / info-layers + anchor 6 子段）
  - `buildChapterContextShared()` 改为委托 chunks join（`stripEmDash` 后返回），
    **输出与重构前逐字节一致**
  - 新增 `collectChapterAnchorChunks()`（anchor 子段标注 chunkId：recent-recaps /
    prev-ending / sound-anchor / next-anchor / hooks / style-fingerprint），原
    `collectChapterAnchorSections()` 委托它（diff 模式行为不变）
  - **suffix 层 chunk 化**：新增 `buildChapterContextSuffixChunks()`（按 Agent 分支：
    director-scheme / reviewer-rubric / writer-instruction，每分支合并为独立 chunk），
    `buildChapterContextSuffix()` 委托它（join 逐字节等价）
  - **context-preview 下沉**：shared section 携带 `chunks` 明细（chunkId/标题/字符数/预览），
    供前端按 chunk 诊断；diff 模式暂不拆（单块退化，独立优化路径）
- **目录扩展**：+ hooks（shared 层实测修正）+ director-scheme / reviewer-rubric /
  writer-instruction（suffix 层，共 17 chunk）
- **测试**：novel-context-chunk-equivalence.test.ts 6/6——① chunks 拼接 === shared 字符串
  （逐字节等价）② chunk 结构合法 ③ 有编排时 arranged 替代 story-state ④ diff 单块等价
  ⑤ preview 下沉 + 字符守恒（含分隔符）⑥ suffix 三分支 chunk 拼接 === 原字符串
- 全量回归：**1706/1706**
- 剩余（T03-3 起）：角色 Chunk Policy（按角色对 chunk 做注入/降级策略）、
  context-preview 前端面板（可选，后端已就绪）
