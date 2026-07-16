# 提示词重构影响审查

- **审查日期**：2026-07-16
- **审查对象**：commit `a03c063`「chore: 批量更新项目代码与配置」+ 工作区未提交改动（`positioning_guidance` 注入）
- **影响范围**：`apps/agent-server/src/plugins/novel-plugin/core/prompts/`、`prompt-builder.ts`、`writing-style-prompt-factory.ts`
- **审查目的**：回答四个问题——输入量、缓存命中、逻辑变更、对中间章节重写的影响

---

## 一、改动清单

### 1.1 Prompt 模板精简（commit a03c063，共 -483/+185 行）

| 文件 | 行数变化 | 主要移除内容 |
|------|----------|--------------|
| `chapter-instruction.md` | 88 → 27 行 | 章尾钩子设计（4 种类型）、结尾铁律、创作要求 10 条、节奏目标指导（13 种任务类型）、字数浮动规则、输出规范 |
| `role-director-discussion.md` | 290 → 38 行 | 矛盾冲突理论（4 大类型）、9 种冲突类型写作特征表、高潮设计理论（5 种类型 + 3 档强度）、悬念营造理论、宏观节奏管理 |
| `role-character-actor.md` | -85 行 | 角色演出理论指导 |
| `role-reviewer.md` | ±19 行 | 审稿维度调整 |
| `role-writer.md` / `role-writer-discussion.md` | ±22 行 | 写作约束微调 |
| `role-memory-generator.md` | ±11 行 | 记忆提取 schema 调整 |
| `system-base.md` | ±14 行 | 基础身份模板调整 |

### 1.2 prompt-builder.ts 逻辑改动（commit a03c063）

| 改动点 | 位置 | 影响 |
|--------|------|------|
| Agent 身份从 system prompt 移到 DYNAMIC 层 | `buildSystemPrompt` L226 `void agentType` | 4 个 Agent 的 system prompt 完全相同 |
| 文风档案注入 agentIdentity | `buildAgentIdentity` L329-L333 | writer/reviser/reviewer 身份段追加 `compileWritingStylePrompt` |
| 字数估算逻辑改变 | `computeChapterTargetWords` L185-L190 | `targetWords ≤ 10000` 直接用作单章字数，不再 / 1000 |
| 未兑现钩子截断 | L456-L475 | 只保留上一章 3 个（去重）+ 更早 2 条，避免累积 |
| 叙事债务与 suspenseHooks 去重 | L782-L789 | 同一伏笔不在两处重复展示 |
| 伏笔节点注入 | L1098-L1108 | 伏笔在 SEMI 层显示本章节点（埋设/强化/揭示/回收） |
| Reviewer 注入已批准叙事任务 | L534-L536 | Reviewer 评估时能看到 Director 方案 |
| `formatArrangedEntities` 新增 chapterNumber 参数 | L893 | 用于伏笔节点查询 |

### 1.3 工作区未提交改动

- `prompt-builder.ts` 新增 `positioningGuidance`（6 种定位一句话指导），替代原 chapter-instruction 中详细的定位指导
- 注释更新：明确三层缓存结构（STATIC/SEMI/DYNAMIC）的断点位置

---

## 二、输入量分析（Q1：为什么会输入这么多？）

输入量大来自三层叠加，每一层都不小：

### STATIC 层（system prompt，跨章跨 Agent 共享）
`buildSystemPrompt` [L233-L296](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L233-L296) 依次注入：
- 故事简介 → 全书大纲 → 前卷/当前/下卷卷纲
- 世界规则（双键排序：category + id）
- 风格指南
- 势力/地点/世界要素静态档案

长篇小说的 outline 和 worldRules 本身就大，这是输入量的主要来源。

### SEMI 层（prefixUserMessage，单章内缓存）有三条
- `[0]` sharedContext：章节信息 + 约束（冲突目标/悬念钩子/节奏/伏笔债务）+ 全角色故事状态 + 信息差 + 最近章节摘要 + 未兑现钩子 + 本章规划钩子
- `[1]` suffixContext：各 Agent 专属（Writer 的创作指令 + 锚点、Reviewer 的 Rubric + 已批准任务、Director 的节奏分布）
- `[2]` agentIdentity：Agent 身份 + **新增的文风档案**（a03c063 给 writer/reviser/reviewer 追加了 `compileWritingStylePrompt`，见 [L329-L333](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L329-L333)）

### DYNAMIC 层
任务指令 + 用户检查点指令

### 净效果
虽然 a03c063 精简了 .md 模板（-483 行），但同时新增了：
- 文风档案注入（可能较大）
- 伏笔节点信息
- Reviewer 注入已批准叙事任务

这些新增内容部分抵消了精简收益。净效果取决于文风档案的大小——如果 `NovelWritingStyleProfile` 内容丰富，agentIdentity 会显著变大。

---

## 三、缓存命中分析（Q2：缓存还是一样能够命中吗？）

**改善了一处，另一处有隐患。**

### ✅ 跨 Agent 的 system 缓存改善
a03c063 把 Agent 身份从 system prompt 移出（[L226](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L226) `void agentType`），4 个 Agent 的 system prompt 现在完全相同 → provider 端的 system 缓存块能跨 Agent 命中。

原设计因末尾 agent_type 不同导致整个 system 块 cache miss，这是个实质提升。

### ✅ 单章内 shared 缓存正常
[novel-orchestrator.ts#L701-L723](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts#L701-L723) 用 `run.semiLayerSharedCache` 缓存 sharedContext，同章 Director→Writer→Reviser→Reviewer 之间命中。

### ⚠️ 隐患在 prefixUserMessage 的排列顺序
[novel-orchestrator.ts#L827](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts#L827) 当前是 `[sharedContext, suffixContext, agentIdentity]`。

- suffixContext 各 Agent 不同（Writer 有创作指令、Reviewer 有 Rubric），所以 provider 缓存断点打在 suffix 之后时，agentIdentity 无法跨 Agent 命中——但这是合理的（身份本就各 Agent 不同）。
- **问题在于**：如果 suffix 内容不稳定（例如 Director 实时输出进 suffix、Reviewer 的已批准任务文本变化），suffix 断点也不稳定，连 shared 之后的缓存都可能失效。

### 建议
确认 provider 端的 cache_control breakpoint 打在 sharedContext 之后（而非整个 prefixUserMessage 之后），以确保 shared 部分稳定命中。

---

## 四、逻辑变更分析（Q3：会更改逻辑吗？）

**会，且改动不小。** a03c063 改了多处理论/约束逻辑：

| 改动 | 文件 | 影响 |
|------|------|------|
| chapter-instruction 从 88 行精简到 27 行 | [chapter-instruction.md](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompts/chapter-instruction.md) | 移除章尾钩子设计、结尾铁律、创作要求 10 条、节奏目标指导 13 种、字数浮动规则 |
| role-director-discussion 从 290 行精简到 38 行 | role-director-discussion.md | 移除矛盾冲突理论、9 种冲突类型写作特征、高潮设计理论、悬念营造理论 |
| 新增文风档案注入 agentIdentity | [prompt-builder.ts#L332-L333](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L332-L333) | writer/reviser/reviewer 身份段追加文风档案 |
| 新增伏笔节点注入 | [prompt-builder.ts#L1098-L1108](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L1098-L1108) | 伏笔在 SEMI 层显示本章节点（埋设/强化/揭示/回收） |
| Reviewer 注入已批准叙事任务 | [prompt-builder.ts#L534-L536](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L534-L536) | Reviewer 评估时能看到 Director 方案 |
| 未兑现钩子截断 | [prompt-builder.ts#L456-L475](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L456-L475) | 只保留上一章 3 个 + 更早 2 条，避免累积 |
| 叙事债务与 suspenseHooks 去重 | [prompt-builder.ts#L782-L789](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L782-L789) | 同一伏笔不重复展示 |
| 字数估算逻辑改变 | [prompt-builder.ts#L185-L190](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L185-L190) | targetWords ≤ 10000 直接用作单章字数 |

工作区未提交的改动还新增了 `positioningGuidance`（6 种定位一句话指导），是对原 chapter-instruction 中详细定位指导的极简替代。

---

## 五、对中间章节重写的影响（Q4：移除的东西会影响文章创建逻辑吗？）

**会影响，且中间章节重写是风险最高的场景。**

### 5.1 被移除的关键约束

#### 1. 结尾铁律（原 chapter-instruction）
- 最后一段必须是画面/动作
- 禁止章尾心理分析收尾
- 最后 300 字若是分析必须重写

**Writer 初稿不再有这个约束**。但 [role-reviser.md#L31](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompts/role-reviser.md#L31) 的自检清单保留了"结尾是否止于画面？"，所以 Reviser 修正时会检查，但 Writer 初稿可能产出分析式收尾。

#### 2. 章尾钩子设计指导（4 种钩子类型 + 承接规则）
Writer 不再有钩子设计参考。现在依赖 Director 方案中的 `chapterEndingHook` 字段（通过 suffixNarrativeTask 传递）。如果 Director 方案没写钩子，Writer 可能不抛钩子。

#### 3. 创作要求 10 条
推进剧情/遵守约束/角色一致性/信息控制/伏笔处理/冲突推进/节奏遵循/悬念执行/声音一致/字数达标——Writer 和 Reviser 都不再有这个 checklist。

Reviser 只按审稿报告修问题段落，**审稿报告没指出的违规不会主动检查**。

#### 4. 节奏目标指导（13 种任务类型写法）
被 `positioning_guidance`（6 种定位一句话）+ `writing_theory`（条件注入）替代，覆盖面和详细程度都下降了。

### 5.2 对中间章节重写的具体影响

| 场景 | 风险等级 | 说明 |
|------|----------|------|
| **PostWriteGuard 自动重写（Writer 重写）** | 🔴 高 | Writer 重写时没有结尾铁律、钩子设计、创作要求 10 条。如果 Director 方案不详细，重写后的初稿可能质量下降。但文风档案注入是正面补偿——重写时文风一致性更好。 |
| **Reviser 修订** | 🟡 中 | Reviser 的 [role-reviser.md](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompts/role-reviser.md) 自检清单完整保留（破折号/AI腔/开头/结尾/连接词），所以局部修订的约束没丢。但 Reviser 不再有创作要求 10 条作为全局参考——如果审稿报告遗漏某问题，Reviser 不会主动补充检查。 |
| **手动编辑后再次创作** | 🟢 低 | sharedContext 会重建（约束可能变化），缓存正常失效重建。文风档案注入确保手动编辑后的文风一致性。 |

### 5.3 风险点汇总

1. **Writer 初稿的结尾铁律和钩子设计被移除**——最关键风险
2. **创作要求 10 条 checklist 丢失**——Writer 和 Reviser 都失去全局自检参考
3. **Director 理论指导大幅精简**——Director 方案质量可能下降，间接影响下游 Agent
4. **positioning_guidance 一句话替代详细节奏指导**——覆盖面不足

---

## 六、建议

### 6.1 必须修复（高优先级）

把结尾铁律和钩子设计精简版加回 [chapter-instruction.md](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompts/chapter-instruction.md) 或 [role-writer.md](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompts/role-writer.md)：

```markdown
### 结尾铁律
- 最后一段必须是画面或动作，禁止心理分析/总结/感悟收尾
- 必须留章尾钩子（悬念/反转/情感/行动之一），除非 Director 方案另有指定
```

理由：Reviser 自检清单已覆盖这些，但 Writer 初稿阶段也需要约束以减少 Reviser 的返工量。

### 6.2 建议改进（中优先级）

1. **创作要求 checklist 精简版回归**：在 role-writer.md 保留 5 条核心要求（推进剧情/角色一致/信息控制/伏笔处理/字数达标），避免 Writer 完全失去全局参考。

2. **Director 理论指导保留索引**：role-director-discussion.md 精简到 38 行后，Director 失去冲突/高潮/悬念理论参考。建议保留一句话索引（如"冲突推进参考：情感/利益/性格/观念四类"），让 Director 知道存在这些维度，需要时通过工具查询。

3. **缓存断点验证**：确认 provider 端 cache_control breakpoint 打在 sharedContext 之后，避免 suffix 不稳定导致 shared 缓存失效。

### 6.3 可观察（低优先级）

1. **字数估算逻辑变更**：`targetWords ≤ 10000` 直接用作单章字数——如果用户把 targetWords 设为 5000（以为是全书字数），单章会要求 5000 字。建议在 UI 层提示字段含义，或在 `computeChapterTargetWords` 加日志。

2. **文风档案大小监控**：新增的 `compileWritingStylePrompt` 会增大 agentIdentity，建议在日志中记录文风档案长度，监控对总输入量的影响。

---

## 七、结论

本次重构在**缓存命中率上有实质改善**（跨 Agent system 缓存），在**输入量上净效果不确定**（精简 vs 新增文风档案抵消），但在**创作约束完整性上有明显退步**——特别是 Writer 初稿的结尾铁律、钩子设计、创作要求 checklist 被移除，对中间章节重写场景风险最高。

建议优先执行 6.1（结尾铁律 + 钩子设计回归），再评估 6.2 的改进项。
