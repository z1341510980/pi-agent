# 小说文风系统重构方案

> 状态：部分实施（数据层、透传、断点快照和版本回滚已落地；独立管理体验与完整审计仍待完成）
> 日期：2026-08-17
> 背景：文风功能经历三轮迭代（基础档案 → 岗位型专家团 → 独立蒸馏专家），
> 数据链路已通但整体逻辑与交互未达预期。本文档先诊断问题，再定义目标模型、
> 交互、数据结构与实施顺序，作为后续重构的唯一依据。

---

## 1. 问题诊断

### 1.1 一个档案承载了三种语义不同的东西

当前 `NovelWritingStyleProfile` 混装了三类内容：

| 内容 | 语义 | 变更频率 | 本质归属 |
|------|------|---------|---------|
| 叙事声音 / 硬软规则 / 补充说明 | 这本书自己的声音 | 极低，定稿前调一次 | 本项目出厂设置 |
| 正反文风样本 | 声音的教学材料 | 低 | 本项目出厂设置 |
| 文风专家（styleExperts） | 从其他作品蒸馏出的可召唤风格能力 | 每次任务都可能切换 | 可复用资产，本质不该绑死在单项目 |

专家作为 profile 的一个 JSON 字段存在，等于把"随身技能包"焊进"出厂设置"。
改一个专家提示词会让整个文风档案版本 +1，也让缓存指纹（chunk-cache 的
styleProfileVersion）全部失效——基线没动，缓存却挂了。

### 1.2 交互路径错位：高频操作和低频配置走同一条深路

用户的两类诉求频率完全不同：

- **"这一段想用 XX 小说的节奏感"**：日常高频，期望 2 次点击内完成
- **"定稿前统一全书声音"**：低频深思熟虑，愿意进设置页慢慢调

现状是两者都走：工作台 → 文风设置弹窗 → 5 个 Tab 的大编辑器 → 改 → 保存。
输入框虽已加召集 Popover，但它只是个只读 checkbox 列表：

- "管理专家"跳回大弹窗，路径断裂（用户原话：功能和弹框是分开的）
- 看不到专家提示词内容，无法在召集时判断该不该选
- 没有"存为项目默认"，临时选择和长期配置之间没有桥
- 任务发出后没有任何反馈表明本次到底带了哪些专家

### 1.3 专家生命周期不完整

- 蒸馏弹窗嵌在编辑器大弹窗里（弹窗套弹窗），产出草稿直接塞进表单状态，
  没有"草稿 → 审阅 → 入库"的独立流程
- 无版本记录：改坏专家提示词后无法回滚到蒸馏原始版
- 无来源详情：卡片只有一行 sourceTitle，看不到蒸馏时间、样本量、原始规则
- 无效果预览：入库前看不到"这个专家会让编译后的提示词变成什么样"

### 1.4 召集与生效链路的剩余缺口

- `styleExpertIds` 已贯通自由聊天、工作流、工作流恢复、群聊和群聊恢复；`undefined` 使用默认专家，空数组只用基线，非空数组只召集指定专家。
- 工作流与群聊快照已保存 `styleExpertIds`，恢复时冻结沿用原选择。
- run_start 与章节聊天 metadata 已记录召集名单，但 `novel_agent_logs` / 通用 agent call metadata 尚未记录专家 ID，完整的逐次 Agent 审计仍未闭合。

---

## 2. 目标概念模型：三层分离

```
第一层  文风基线（Baseline）
        这本书自己的声音。始终生效，低频配置。
        = 叙事声音 + 硬软规则 + 正反样本 + 补充说明

第二层  文风专家库（Expert Library）
        从其他作品蒸馏出的独立风格能力。可增删改、可版本化、可跨项目。
        每个专家 = 名称 + 来源 + 能力摘要 + 提示词(distilled/custom) + 版本

第三层  本轮召集（Session Summon）
        当前任务叠加哪些专家。会话级状态：默认取项目配置，可临时改，可存回。
```

三层职责边界：

- 基线不引用专家；专家不修改基线；召集只是选子集
- 编译提示词 = 基线全文 + 每个被召集专家的独立 block
- **全不选是合法状态**：只用基线，不强制兜底选回全部
- 专家之间是能力叠加关系，不是团队调度关系（无主理人、无共识措辞）
- 多专家冲突时，章节任务、POV、事实一致性优先（编译提示词已含此约束）

---

## 3. 用户场景（交互以此为准）

### 场景 A：写作中途换风格（最高频）

1. 统一会话输入框左下角点「文风 N/M」→ 召集面板
2. 面板顶部即时显示"本次将叠加：冷峻留白 · 悬压推进"
3. 点选/取消专家；hover 专家行看摘要与提示词开头
4. 直接 `/写 N` 或发送消息
5. Agent 气泡 / run_start 系统消息带本次专家徽标，事后可查

### 场景 B：从喜欢的小说蒸馏新专家

1. 专家库 →「蒸馏新专家」（独立工作台，不再嵌在基线编辑器里）
2. 填来源作品、作者、粘贴样本（一期）/ 选项目章节（二期）
3. 蒸馏产出草稿：名称 / 摘要 / 提示词 / 规则，逐字段可改，未确认不入库
4. 可选「预览编译效果」：草稿 + 基线跑一次编译，看注入差量
5. 确认入库 → 专家带 v1、蒸馏时间、样本量进入库中

### 场景 C：调这本书的基础声音（低频）

1. 专家库页右上「基线设置」→ 瘦身后的基线编辑器
2. 只有：基础设定 / 规则说明 / 文风样本 / 提示词预览，无专家 Tab
3. 保存版本 +1；预览页可模拟"叠加某几个专家"后的编译结果

### 场景 D：修订/审校用特定专家视角

1. 召集面板只选目标专家（如反 AI 腔能力）
2. 发起 re-revise 或触发 Reviewer 检查点
3. Reviewer 身份注入该专家提示词

---

## 4. 功能模块设计

### 4.1 专家库管理页（新，替代编辑器 experts Tab）

入口：召集面板右下「管理」/ 工作台原文风入口改造。

```
文风专家库                      [蒸馏新专家] [基线设置]
┌─────────────────────────────────────────────┐
│ ◉ 冷峻留白                    v3 · 默认召集  │
│ 来源：某小说 · 2026-08-15 蒸馏 · 样本 3.2k   │
│ 用动作和环境承载情绪，减少直接解释             │
│ [编辑] [版本] [预览效果] [移出默认] [归档]    │
├─────────────────────────────────────────────┤
│ ○ 悬压推进                    v1 · 手动召集  │
│ ...                                          │
└─────────────────────────────────────────────┘
```

专家详情抽屉（点卡片展开）：

- **基本信息**：名称 / 来源作品 / 作者 / 能力摘要
- **提示词编辑**：生效提示词 = `customPrompt ?? distilledPrompt`；
  展示蒸馏原文（只读）与当前生效版（可编辑），一键「恢复蒸馏版」
- **版本区**：每次保存留痕，可回滚
- **召集配置**：是否进项目默认（isDefault）；二期再拆分 Agent 级开关

### 4.2 蒸馏工作台（独立弹窗，从基线编辑器搬出）

流程：`输入 → 蒸馏 → 审阅草稿 → （可选）编译预览 → 入库`

- 入库时落 `distill_meta`：蒸馏时间、样本字符数、蒸馏模型
- 蒸馏原文（distilledPrompt）入库后不可变，用户改动走 customPrompt
- 样本校验：≥80 字符（已实现），蒸馏边界提示词已含"只提炼机制、不复制内容"

### 4.3 输入框召集面板（重构现有 Popover）

```
┌ 本轮文风召集 ──────────────────┐
│ 本次将叠加：冷峻留白 · 悬压推进  │
├────────────────────────────────┤
│ ◉ 冷峻留白   来源：XX小说 ⓘ    │
│ ○ 旧城肌理   来源：YY小说 ⓘ    │
│ ◉ 悬压推进   来源：ZZ小说 ⓘ    │
├────────────────────────────────┤
│ [恢复默认] [存为项目默认] [管理] │
└────────────────────────────────┘
```

- ⓘ 悬浮：摘要 + 提示词前两行
- 「恢复默认」回到项目默认集合；「存为项目默认」把当前选择写回配置
- 任务运行中面板变只读，提示"已随任务发出/下次任务生效"
- 发送后：本次召集随消息落库 metadata，气泡侧显示专家徽标

### 4.4 基线设置页（原编辑器瘦身）

移除 experts Tab 与蒸馏弹窗后保留四区：基础设定 / 规则与说明 / 文风样本 /
提示词预览。预览页增加"模拟叠加专家"多选，所见即编译结果。

---

## 5. 数据模型

### 5.1 现状

```ts
interface NovelWritingStyleProfile {
  /* 基线字段 ×12 */
  styleExperts?: NovelStyleExpert[]   // JSON 列，随档案版本一起走
}
```

### 5.2 当前：专家独立表已落地，旧 JSON 字段保留兼容

```sql
CREATE TABLE novel_style_experts (
  id               TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  source_title     TEXT NOT NULL,
  source_author    TEXT,
  description      TEXT NOT NULL,
  distilled_prompt TEXT NOT NULL,
  custom_prompt    TEXT,
  metrics_json     TEXT,
  techniques_json  TEXT,
  exclusions_json  TEXT,
  exemplars_json   TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  distill_meta     TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_novel_style_experts_project_order
  ON novel_style_experts(project_id, sort_order, id);
```

- 迁移会把基线档案中的历史 `styleExperts` JSON 回填到 `novel_style_experts`；旧字段暂未删除，用于旧客户端兼容。
- 独立专家的创建、编辑、删除、版本列表与回滚 REST 已落地；`distilledPrompt` 与 `customPrompt` 已分离。
- 专家变更已不再依赖基线版本，但 chunk-cache 指纹是否按专家版本独立参与仍需专项验收。

### 5.3 快照与审计补齐

- `novel_workflow_runs` / `novel_discussion_runs` 增加 `style_expert_ids` 列，
  断点续跑恢复选择
- run_start 系统消息与章节聊天 metadata 已记录本次召集名单；agent_log metadata 尚未补齐

---

## 6. 生效链路（目标全景）

```
召集面板选择
  → styleExpertIds（会话状态）
  → 请求体：chat / create-flow / create-discussion
  → Runner 层透传（chat ✅ / workflow ✅ / discussion ✅ / resume ✅）
  → PromptBuilder.buildAgentIdentity(projectId, agentType, false, styleExpertIds)
  → 专家过滤：enabled=true 且 id ∈ styleExpertIds
  → compileWritingStylePrompt：基线 section + 每专家独立 block
  → Writer / Reviewer / Reviser 身份注入
```

保持不变的边界：Director / Moderator / 角色演员 / Memory 不吃专家；
全不选只用基线；专家 block 标题用"本次召集的独立文风能力"而非"专家团共识"。

---

## 7. 实施路线图

### 阶段一：交互重组（不动数据层，读现有 JSON）

1. 专家库管理页独立（编辑器删 experts Tab 与蒸馏弹窗）
2. 召集面板重构：顶部"本次将叠加"、ⓘ 悬浮、恢复默认 / 存为默认
3. 蒸馏工作台独立弹窗，草稿审阅不直接改表单状态
4. 群聊 DiscussionOptions 透传 styleExpertIds（补断点）
5. run_start 消息 + Agent 气泡带专家徽标

### 阶段二：数据层拆分

1. novel_style_experts 表 + 迁移
2. 专家 CRUD/rollback REST API
3. distilled/custom 提示词分离
4. 快照表存 style_expert_ids，续跑恢复
5. chunk-cache 指纹与基线解耦

### 阶段三：蒸馏与资产增强

1. 样本来源支持选项目章节 / 参考分析文本
2. 蒸馏草稿编译预览（差量展示）
3. 专家版本历史
4. 专家跨项目导入导出（JSON 文件）

### 阶段四：审计

1. agent_log 展示专家参与
2. 章节版本记录"该版由哪些专家参与"
3. 召集历史时间线

---

## 8. 当前实现状态对照

| 项 | 状态 |
|----|------|
| 独立蒸馏型专家模型（name/sourceTitle/description/prompt） | ✅ |
| styleExpertIds 贯通 chat / create-flow | ✅ |
| 群聊接收字段并透传到正文工种成员 | ✅ |
| 蒸馏 API（distill 端点 + 边界提示词） | ✅（交互待重组） |
| 输入框召集 Popover | ✅ 基础版（待按 4.3 重构） |
| 专家库独立管理页 | 部分：可独立打开专家管理模式，但仍复用基线编辑器容器 |
| distilled/custom 提示词分离与回滚 | ✅ |
| 专家独立表 + CRUD API | ✅（旧 profile JSON 保留兼容） |
| 快照保存专家选择 / 续跑恢复 | ✅ |
| 召集反馈（徽标/日志/时间线） | 部分：run_start 与聊天 metadata 已有；Agent 调用日志未记录专家 ID |
| 变更专家不失效基线缓存指纹 | 部分：数据版本已拆分，缓存命中行为仍需专项验收 |
