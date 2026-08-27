# 方案：参考小说分析完成后自动生成文风基线与专家团

## 目标

- 参考小说分析 run 完成（`awaiting_review`/`completed`）后，前端弹确认框，用户确认后一键生成：
  1. **文风基线**：从分析范围内章节分层取样正向样本（头/中/尾代表性章节），第一条为锚定样本；
  2. **专家团**：按 7 个维度（场景/人物/对话/打斗/情感/冲突/叙事）一维一专家，每维度一次独立 LLM 蒸馏调用，专家按参考源分组。
- 产物一律为**草稿态待审核**（`review_status='draft'`、`enabled=false`），在文风档案面板集中审核启用，符合现有防抄袭/证据校验安全设计。
- 生效路径复用现有 `buildAgentIdentity` → `compileWritingStylePrompt` 注入（writer/reviser/reviewer），不改创作流程。

## 范围

- 内：
  - 新增 `conflict_craft`（冲突构建）蒸馏维度
  - `novel_style_experts` 表新增 `dimension` / `team_key` / `review_status` 列（迁移 119）
  - 分维度蒸馏函数（复用现有蒸馏的证据校验、三重验证、A2/D 降级链）
  - 新路由：单维度蒸馏入库（幂等）+ 基线分层取样入库
  - 前端：分析完成确认框（成本提示 + 维度勾选 + 顺序蒸馏进度）
  - 前端：专家面板与创作召集菜单按参考源分组、维度徽标、草稿徽标
- 外：
  - 不改 reference template 绑定 → 创作流程注入（resolve 死路问题，用户已选"基线+专家团自动就位"方案）
  - 不改现有单专家手动蒸馏路径（`style-distill-launcher.tsx` 与 `/style-distill` 路由保持可用）
  - 不改 `novel_writing_style_profiles` 基线样本上限（5 正 5 反）与注入预算

## 假设

- 蒸馏模型沿用分析 run 的 provider/model 作为确认框默认值，用户可换。
- 7 维顺序由前端循环调用单维度路由实现（每次一个 POST），天然获得逐维进度与断点续传；无需服务端 SSE/后台任务。
- 前端确认框只对"该参考源尚无专家团"的情况自动弹出；重复触发通过幂等跳过兜底。

## 当前行为

- 分析 run 完成于 `reference-analysis-run-worker.ts:448`（`awaiting_review` 产出 spirit/technique/power/pacing profile），之后**无任何自动动作**。
- 基线样本只能手动：`style-distill-launcher.tsx:164` "加入文风基线样本"（按章节顺序截前 5 章）。
- 蒸馏只能手动发起且产出**单个**专家（手法卡内部按 6 维组织：scene/character/dialogue/action/emotion/narrative，无冲突维度）。
- 专家表无维度、无参考源分组键、无草稿态；`listStyleExperts` 返回平铺列表，前端按 `sourceTitle` 文本展示。
- 文风档案已注入主流程（`prompt-builder.ts:942`），档案缺失时仅 `style_baseline_warning`（`novel-orchestrator.ts:513`）。

## 目标行为

1. 分析 run 状态轮询到 `awaiting_review`/`completed`（`reference-run-panel.tsx:119-127`）且该源无既有团队时，弹出确认框：
   - 成本说明："约 7 次模型调用，每次注入约 2.4 万字分层样本"
   - 维度勾选（默认全选 7 维）+ 模型选择（默认 run 的 provider/model）
   - 基线取样说明（分层正向样本，已满 5 条则跳过并提示）
2. 确认后依次执行：
   - `POST /projects/:projectId/writing-style-profile/auto-baseline`：服务端从传入 sectionIds（分析范围）分层挑选 ≤5 章截取正向样本（复用句界截断逻辑），返回 added/anchorIsNew
   - 循环 `POST /reference-sources/:sourceId/style-team-distill/dimension`：每维度一次，蒸馏→校验→入库为草稿专家；同 `(team_key, dimension)` 已存在草稿则跳过（断点续传）；进度 UI 显示 x/7 与已产出专家名
3. 完成后 toast + 跳转引导至文风档案面板审核。
4. 文风档案专家列表按 `team_key` 分组（组头=参考源名），专家卡显示维度徽标与"待审核"徽标，提供启用操作；创作召集菜单（`writing-style-expert-menu.tsx`）同样分组，支持整团队勾选（7 ≤ 8 上限）。

## 实现方向

### 后端

**T1 类型与迁移**：`packages/shared/src/novel/index.ts` 的 `NovelStyleExpert` 增加 `dimension?: string`、`teamKey?: string`、`reviewStatus?: 'draft' | 'approved'`；`novel-migrations.ts` 迁移 119：

```sql
ALTER TABLE novel_style_experts ADD COLUMN dimension TEXT;
ALTER TABLE novel_style_experts ADD COLUMN team_key TEXT;
ALTER TABLE novel_style_experts ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_novel_style_experts_team
  ON novel_style_experts(project_id, team_key);
```

历史行默认 `approved`。`world-store.ts` / repository 行映射补三列（读侧 NULL 容忍）。版本表不加列：这三字段创建时定型不可编辑，rollback 沿用现有"快照缺列保留主表值"模式（`world-store.ts:200-204`）。

**T2 维度聚焦蒸馏**：`style-expert-distiller.ts`
- `StyleCraftDimension` 增加 `'conflict_craft'`；`STYLE_DIMENSIONS`、schema literals、系统提示同步（七个维度，冲突构建：冲突埋设、升级路径、对撞时刻、余波）。
- `distillStyleExpertFromReference` 增加 `options.dimension?: StyleCraftDimension`：系统提示追加"本次只分析 {维度} 维度"，techniques 过滤为该维度，产出为空时返回可判别的空结果（上层跳过该维度）。
- 名字约定：提示词要求专家 name 以维度定位开头（如"对话·"），便于分组 UI 识别。

**T3 路由**（`reference-analysis-routes.ts` / `novel-routes.ts`）：
- `POST /reference-sources/:sourceId/style-team-distill/dimension`：body `{ sectionIds, dimension(enum 7 值), notes?, modelId? }`；等距抽样 + `getSectionsText` + `measureStyleMetrics` + 维度蒸馏；`store.createStyleExpert` 入库（`enabled=false`、`review_status='draft'`、`team_key=sourceId`、`dimension`）；幂等：同 `(projectId, team_key, dimension)` 草稿已存在→返回 `{ skipped: true, expert }`。日志复用现有 `reference-style-distill` 模式。
- `POST /projects/:projectId/writing-style-profile/auto-baseline`：body `{ sourceId, sectionIds }`；分层取样（按章节序取 ~10%/35%/60%/85% + 首章，去重，≤剩余正向样本位）；截断复用现有句界逻辑（提取为共享函数，原 `append-reference-samples` 路由与 `style-distill-launcher` 行为不变）；要求档案已存在（同现有约束）。
- `GET /projects/:projectId/writing-style-experts` 响应自然携带新字段，无需新查询。

### 前端

**T4 确认框与顺序蒸馏**（`reference-run-panel.tsx` + `novel-client.ts`）：
- run 轮询到终态且 `run.includedSectionIds` 有值时组装确认框数据；同源已有团队（`writing-style-experts` 里存在 `teamKey===sourceId`）则不自动弹，改为按钮入口"生成文风基线与专家团"。
- 确认框 → 先 auto-baseline（满 5 条提示跳过）→ 逐维 POST（进度条 x/7）→ 完成 toast + 引导审核。
- `novel-client.ts` 新增两个 API 封装与 `NovelStyleExpertApi` 新字段。

**T5 分组展示**（`writing-style-profile-editor.tsx` + `writing-style-expert-menu.tsx`）：
- 专家列表按 `teamKey ?? sourceTitle` 分组；组头"《来源》· 专家团（n）"；专家卡维度徽标（中文标签映射 7 维）+ 草稿徽标 + 启用开关快捷入口。
- 召集菜单同分组，支持组级全选（注意 `.max(8)` 上限校验提示）。

## 受影响文件

- `packages/shared/src/novel/index.ts`（来源：扫描）：`NovelStyleExpert` 新字段
- `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`（来源：路由图）：迁移 119
- `apps/agent-server/src/plugins/novel-plugin/core/stores/world-store.ts`（来源：扫描）：行映射、`createStyleExpert` 透传新字段、`updateStyleExpert` 允许 reviewStatus 流转
- `apps/agent-server/src/plugins/novel-plugin/infrastructure/sqlite/repositories/*`（来源：扫描，具体文件以 world-store 引用为准）：行读写映射
- `apps/agent-server/src/plugins/novel-plugin/core/prompting/style-expert-distiller.ts`（来源：路由图）：conflict_craft + 维度聚焦
- `apps/agent-server/src/plugins/novel-plugin/core/prompting/writing-style-prompt-factory.ts`（来源：路由图）：reviewer 验收文案补"冲突"维度
- `apps/agent-server/src/plugins/novel-plugin/routes/reference-analysis-routes.ts`（来源：路由图）：维度蒸馏路由
- `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`（来源：路由图）：auto-baseline 路由、句界截断共享化
- `apps/desktop/src/renderer/src/api/novel-client.ts`（来源：扫描）：API 封装
- `apps/desktop/src/renderer/src/components/novel/reference-analysis/reference-run-panel.tsx`（来源：扫描）：确认框 + 顺序蒸馏
- `apps/desktop/src/renderer/src/components/novel/writing-style-profile-editor.tsx`、`writing-style-expert-menu.tsx`（来源：扫描）：分组与徽标
- `apps/agent-server/src/plugins/novel-plugin/__tests__/`（来源：路由图）：新增测试

## 风险

- **7 次顺序 LLM 调用耗时较长**（每次约 1-3 分钟）：前端逐维进度 + 断点续传（幂等跳过已存在维度）缓解；中途关闭页面不阻塞已入库维度。
- **维度产出为空**：某些参考小说可能某维度手法稀疏（如纯日常文无打斗），蒸馏返回空 → 该维度跳过并在结果摘要中说明，不视为失败。
- **专家注入预算**：7 专家 × `perExpertBudget`（5600/7≈800 字符）偏紧，但 `compileWritingStylePrompt` 已有预算裁剪逻辑（verified 优先、样本段最后牺牲），无需改动；单团队召集即 7 个 ≤ 8 上限。
- **迁移 119**：三列均可空/有默认值，幂等安全；`CREATE TABLE IF NOT EXISTS` 旧库不受影响。
- **与既有单专家路径并存**：手动蒸馏的专家无 dimension/teamKey（NULL），分组 UI 以 `sourceTitle` 兜底，不产生回归。

## 测试策略

- 后端（vitest，`apps/agent-server/src/plugins/novel-plugin/__tests__/`）：
  - `style-team-distill.test.ts`：维度聚焦蒸馏（techniques 过滤、conflict_craft schema）、幂等跳过、草稿态字段、空维度跳过
  - `auto-baseline.test.ts`：分层取样位置（头/中/尾）、样本位已满跳过、句界截断、锚定样本标记
  - 迁移 119 升级路径：旧库行默认 approved
- 前端：确认框流转（含成本提示、维度勾选、断点续传）参照现有组件测试模式
- 验证命令：根目录 `pnpm test`

## 路由图影响

- 需要 route-sync：是
- 预期新增/修改条目（`docs/routespec/feature-routes/novel-plugin.md`）：
  - 新增"参考小说 → 文风基线/专家团自动生成"条目：入口 `routes/reference-analysis-routes.ts`（style-team-distill/dimension）、`novel-routes.ts`（auto-baseline）、核心 `core/prompting/style-expert-distiller.ts`、前端 `reference-run-panel.tsx` / `writing-style-profile-editor.tsx`
  - 既有"领域子模块（core/ 分域）"条目 quality/prompting 描述补一句维度蒸馏

## 验收标准

1. 分析 run 完成后出现确认框，展示成本与 7 维勾选；确认后基线样本（分层、≤5、首条锚定）与 7 个草稿专家（含冲突维度）入库，`enabled=false`、`reviewStatus='draft'`、`teamKey=sourceId`、`dimension` 正确。
2. 中途失败重试只补缺失维度，不产生重复专家。
3. 文风档案面板按参考源分组展示专家团，维度徽标与待审核徽标正确；启用后参与 `compileWritingStylePrompt` 注入（既有 `/writing-style-profile/preview` 可验证）。
4. 历史专家（无新字段）分组展示无回归；迁移后旧库可用。
5. `pnpm test` 全绿。

## 任务

- [x] T1：shared 类型 + 迁移 119 + store/repository 映射
  - 文件：`packages/shared/src/novel/index.ts`、`novel-migrations.ts`、`core/stores/world-store.ts`、sqlite repository
  - 改动：`NovelStyleExpert` 加 `dimension/teamKey/reviewStatus`；迁移 119 三列 + 团队索引；行映射读写（NULL 容忍，历史行 approved）
  - 验证：迁移升级测试 + `pnpm test`（novel-plugin 既有套件）
  - 依赖：无
- [x] T2：conflict_craft 维度 + 维度聚焦蒸馏
  - 文件：`core/prompting/style-expert-distiller.ts`、`core/prompting/writing-style-prompt-factory.ts`
  - 改动：7 维集合；`distillStyleExpertFromReference` 加 `options.dimension`（提示聚焦 + techniques 过滤 + 空结果可判别）；reviewer 验收文案补冲突
  - 验证：`style-team-distill.test.ts`（维度过滤、schema、空维度）
  - 依赖：无（与 T1 弱相关，类型可先行）
- [x] T3：后端路由（维度蒸馏 + auto-baseline）
  - 文件：`routes/reference-analysis-routes.ts`、`novel-routes.ts`
  - 改动：`style-team-distill/dimension` 路由（幂等、草稿入库、agent 日志）；`auto-baseline` 路由（分层取样、句界截断共享化）；zod schema；PATCH 专家路由支持 reviewStatus（启用即 approved）
  - 验证：路由级测试（幂等跳过、满位跳过、锚定标记、启用流转）
  - 依赖：T1 + T2
- [x] T4：前端确认框与顺序蒸馏
  - 文件：`reference-run-panel.tsx`（+ `reference-analysis-workspace.tsx` 传 projectId prop）、`api/novel-client.ts`
  - 改动：终态检测 + 团队存在性检查 + 确认框（成本/维度勾选/模型选择）+ auto-baseline 调用 + 逐维蒸馏进度 + 完成引导；API 封装与新字段类型
  - 验证：desktop typecheck + 全量测试 722 通过
  - 依赖：T3
- [x] T5：专家面板与召集菜单分组
  - 文件：`writing-style-profile-editor.tsx`、`writing-style-expert-menu.tsx`
  - 改动：按 `teamKey ?? sourceTitle` 分组、组级操作、维度/草稿徽标、启用快捷入口；召集菜单组级全选（≤8 校验）
  - 验证：desktop typecheck + 全量测试通过
  - 依赖：T1（字段）；与 T4 弱相关
- [x] T6：route-sync 更新路由图
  - 文件：`docs/routespec/feature-routes/novel-plugin.md`
  - 改动：新增"参考小说 → 文风基线与专家团自动生成"条目（覆盖 sufficient）
  - 验证：条目与实际文件一致
  - 依赖：T1-T5 完成

## 任务关系

- 强相关：T1 + T3（store 字段是路由入库的前提，连续实现保持一致）；T2 + T3（蒸馏函数签名与路由调用契约）
- 弱相关：T4 + T5（文件边界清晰，可并行；都消费 T1 字段）
- 独立：T6（收尾）
- 冲突风险：T3 与 T4 都改 `novel-client.ts`/路由契约——T3 先定契约（zod schema 即接口文档），T4 跟随；`novel-routes.ts` 句界截断共享化与既有 `append-reference-samples` 路由同文件，注意回归

## RouteSync

- 需要 route-sync：是
- 预期更新：见"路由图影响"
