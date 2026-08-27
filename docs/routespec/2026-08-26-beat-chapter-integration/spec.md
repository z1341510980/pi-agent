# 方案：节拍-章节一体化视图（第四档）

## 目标
把卷级节拍与章节在 UI 与数据层打通：
1. 大纲树章节行内嵌节拍徽标，就地编辑，支持单章节拍生成/重生成（语义 A：只动该章）
2. 创作面板露出本章节拍约束（启动横幅 + SSE 进度卡片）
3. 一并修复两处数据正确性缺陷（发布未确认节拍、删章不重排节拍）

## 范围
- 内：
  - 后端：`CHAPTER_RENUMBER_FIELDS` 补 `novel_beat_plans.chapter_number`；发布事务接线 `confirmBeatForChapter`；单章生成 API（generator 方法 + store upsert + route）；SSE `chapter_context` 事件补 `beatConstraint`
  - 前端：节拍数据提升为共享数据源；大纲树 `ChapterRow` 徽标 + 行内编辑 + 单章生成入口；创作面板启动横幅；SSE 进度卡渲染节拍块
- 外（明确不做）：
  - 独立卷视图对齐面板、章节工作区头部展示
  - 章纲生成器 / ai-arrange 消费节拍
  - beat→taskType 代码级校验映射
  - 移除侧栏「节拍表」分组（保留作为按卷生成与整卷总览入口）
  - 整卷按卷生成流程不变（含 published 保护语义）

## 假设
- 单章生成语义已确认为 A：外科手术式，仅产出/替换该章一行情拍；与后续节拍结构冲突时由用户自行决定是否整卷重排（UI 文案提示）。
- 单章生成同样受卷纲质量门约束（≥50 字），与整卷生成一致。
- 前端节拍共享数据源放入 `novel-data-store`（沿用 upsertVolume/upsertChapter 的既有模式）。
- 戏剧功能标签/配色常量从 `beat-plan-group.tsx` 抽到共享模块供大纲树复用。

## 当前行为
- 节拍只在 `buildChapterConstraints`（novel-engine.ts:201-213）以文本约束进入 Director/Writer 提示词，前端创作链路完全不可见。
- `confirmBeatForChapter` 无生产调用点，节拍状态永远 `planned`。
- 删章重排清单（chapter-renumber.ts:147-186）不含 `novel_beat_plans`，删章后节拍章号错位。
- 单章查询 API `GET .../chapters/:n/beat-plan` 已存在但前端零调用；无单章生成 API。
- 节拍 UI 仅侧栏独立分组（beat-plan-group.tsx），与大纲树章节无交互；SSE `chapter_context` 卡片（use-novel-creation-flow.ts:492-521）不渲染节拍。

## 目标行为
- 发布章节成功 → 同事务内对应节拍 `status='confirmed'`（幂等）。
- 删除第 N 章 → 该章节拍行删除，其后所有节拍章号 -1，唯一索引不冲突。
- `POST /projects/:projectId/chapters/:chapterNumber/beat-plan/generate` → 校验章节存在且未发布、定位所属卷并过卷纲质量门 → LLM 产出单个 beat（十种枚举）→ upsert 该章一行（已有行更新字段并重置 `planned`，无则插入），其余行不动；published 章 409。
- 大纲树章节行：有节拍显示彩色戏剧功能标签（confirmed 加「已发布」角标）；无节拍的未发布章显示灰色占位，提供「生成本章节拍」；点击标签就地展开编辑表单（复用现有字段集），保存走既有 PATCH。
- 打开创作流程（manual/ai-arrange 入口）→ 面板顶部横幅显示本章节拍约束（无节拍提示先生成）；Director 阶段 `chapter_context` 进度卡片新增「卷级节拍约束」区块。

## 实现方向
### T1 数据正确性（后端）
- `chapter-renumber.ts` 字段清单追加 `{ table: 'novel_beat_plans', column: 'chapter_number', kind: 'scalar', nullable: false }`（被删章节拍 DELETE，其余整体 -1）。
- `novel-store.ts#publishReviewedChapter` 事务内、`updateChapter(id,{status:'published'})` 成功后调用 `this.beatPlans.confirmBeatForChapter(chapter.projectId, chapter.chapterNumber)`。
- 测试：删中间章后连续 planned 节拍整体左移且无唯一索引冲突；发布后节拍变 confirmed。

### T2 单章生成 API（后端）
- `BeatPlanStore` 新增 `upsertChapterPlan(projectId, volumeNumber, input)`：按 `(project_id, chapter_number)` 定位，有则 UPDATE 五字段并重置 `status='planned'`，无则 INSERT。
- `VolumeBeatPlanner` 新增 `generateForChapter({ projectId, chapterNumber, instruction?, modelId?, signal? })`：
  - 校验：章节存在 / 未发布（409 语义交 route 映射）/ 定位所属卷（volumeId 优先，回退 volume 号）/ 卷纲 ≥50 字。
  - 上下文（轻量版 buildContext）：全书大纲与卷纲摘要、本章 outline+narrativeTask、本卷前后各 2 个既有节拍、活跃冲突/伏笔各 ≤5 条。
  - 输出协议：`{ "beat": { chapterNumber, dramaticFunction, emotionalDebt, payoff, arcPosition, summary } }`；校验 chapterNumber 必须等于目标章、dramaticFunction 十选一；解析失败不落库。
  - 缓存 scope：`novel:${projectId}:beat-ch:${chapterNumber}`；agent log 复用 `recordCall`（operation:'generate_chapter'）。
- `beat-plan-routes.ts` 新增 `POST /projects/:projectId/chapters/:chapterNumber/beat-plan/generate`，body `{ instruction?, modelId? }`，错误映射复用 `mapBeatPlanError`。

### T3 SSE 露出（后端一行 + 前端渲染）
- `novel-orchestrator.ts` director 首次 `emitProgress('phase_change', kind:'chapter_context')` 的 detail 增加 `beatConstraint: constraints.beatConstraint ?? null`。
- `use-novel-creation-flow.ts` chapter_context 分支渲染「### 卷级节拍约束」（功能/债务/爽点/走向四行），无则不加。

### T4 共享数据层 + 大纲树融合（前端）
- `novel-client.ts`：`generateChapterBeatPlan(projectId, chapterNumber, input?)`。
- 数据源：`novel-data-store` 增加 `beatPlans: NovelBeatPlan[]` + `setBeatPlans/upsertBeatPlan`；项目数据加载处一并拉取 `listBeatPlans`；`BeatPlanGroup` 改读共享源（去掉本地 useState 副本），保存/生成后写回 store。
- 抽共享模块 `sidebar/beat-labels.ts`：`BEAT_FUNCTION_LABELS` / `BEAT_FUNCTION_ACCENTS` / `BEAT_STATUS_LABELS`。
- `outline-tree.tsx#ChapterRow`：章号旁渲染节拍标签；点击展开行内编辑面板（编辑表单抽为共享组件 `BeatEditForm`，beat-plan-group 与 ChapterRow 共用）；未发布无节拍显示占位 + 「生成本章节拍」按钮（调 T2 API）；published 章只读。生成成功后 upsert 写回 store 并提示「如与后续节拍结构冲突建议整卷重排」。

### T5 创作面板横幅
- 打开 create-flow（manual / ai-arrange 两入口）时用 `getChapterBeatPlan` 取本章节拍，在流程控制区上方渲染横幅：`本章节拍：{功能}｜{核心走向}`；无节拍显示「未规划节拍，可在侧栏章节行生成」。
- 挂载点在 `novel-workspace.tsx` / `novel-conversation-panel.tsx` 中按现有 creationMode 流转确定，exec-plan 时落地。

## 受影响文件
- `apps/agent-server/src/plugins/novel-plugin/core/chapters/chapter-renumber.ts`（扫描）：补重排字段
- `apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts`（扫描）：publishReviewedChapter 接线确认
- `apps/agent-server/src/plugins/novel-plugin/core/stores/beat-plan-store.ts`（扫描）：upsertChapterPlan
- `apps/agent-server/src/plugins/novel-plugin/core/chapters/beat-plan-generator.ts`（扫描）：generateForChapter
- `apps/agent-server/src/plugins/novel-plugin/routes/beat-plan-routes.ts`（扫描）：新路由
- `apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`（扫描）：chapter_context detail
- `apps/desktop/src/renderer/src/api/novel-client.ts`（扫描）：API 函数
- `apps/desktop/src/renderer/src/stores/novel-data-store.ts`（扫描）：beats 共享源
- `apps/desktop/src/renderer/src/components/novel/outline-tree.tsx`（扫描）：ChapterRow 融合
- `apps/desktop/src/renderer/src/components/novel/sidebar/beat-plan-group.tsx`（扫描）：抽共享组件、切数据源
- `apps/desktop/src/renderer/src/components/novel/sidebar/beat-labels.ts`（新建）：标签常量
- `apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts`（扫描）：chapter_context 渲染
- `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx` / `novel-conversation-panel.tsx`（不确定）：横幅挂载点
- 测试：`__tests__/beat-plan.test.ts`（重排/发布/单章 upsert）、`__tests__/beat-plan-routes 相关`（route 校验）、`outline-tree.test.tsx`（徽标渲染）

## 风险
- **唯一索引 vs 批量左移**：`UPDATE ... SET chapter_number = chapter_number - 1 WHERE > ?` 在 `UNIQUE(project_id, chapter_number)` 上若 SQLite 降序扫描会瞬态撞索引。缓解：先写回归测试（连续多行 planned 节拍删中间章）；若命中，改两段式平移（先 +OFFSET 移出区间再回落）。
- **prompt cache**：单章生成使用独立 cache scope，避免污染整卷缓存前缀。
- **双数据源漂移**：BeatPlanGroup 与大纲树必须共用同一 store，否则编辑不同步——T4 明确单一写入路径（store action）。
- **ChapterRow 高度**：行内编辑展开需保持侧栏滚动行为正常，折叠默认收起。

## 测试策略
- 后端 vitest：`beat-plan.test.ts` 扩展（重排左移、发布确认幂等、upsert 幂等、单章解析校验、published 拒绝）；route 层校验 body schema 与错误码映射。
- 前端 vitest：outline-tree 徽标/占位/编辑展开；BeatEditForm 保存回调。
- 手动验证：生成整卷节拍 → 大纲树看徽标 → 行内改一档 → 单章重生成该章 → 发一章看 confirmed → 删一章看整体左移 → 启动 create-flow 看横幅与进度卡。

## 路由图影响
- 需要 route-sync：是
- 预期新增/修改条目（novel-plugin.md）：
  - 「REST 子路由」补充：单章节拍生成路由 `POST .../chapters/:n/beat-plan/generate`
  - 「领域子模块」或新增条目：节拍-章节一体化（大纲树徽标、共享数据源、创作面板露出、发布确认接线、重排覆盖 novel_beat_plans）
  - 更新 front matter last-updated

## 验收标准
1. 发布章节后其节拍 `confirmed`，侧栏徽标呈现「已发布」。
2. 删除中间章后被删章节拍消失、后续节拍章号 -1，无错位残留。
3. 大纲树章节行显示节拍徽标；点击就地编辑可保存并全局同步（分组视图同刷）。
4. 单章生成只替换该章一行；published 章 409；其余节拍不受影响。
5. create-flow 启动前横幅展示本章节拍；Director 阶段进度卡出现「卷级节拍约束」区块。
6. lint / typecheck / 相关测试全绿。

## 任务
- [x] T1：数据正确性修复（重排字段 + 发布确认接线 + 回归测试）
  - 文件：chapter-renumber.ts、novel-store.ts、__tests__/beat-plan.test.ts
  - 改动：见实现方向 T1
  - 验证：vitest beat-plan.test.ts 全绿（含新增回归用例）
  - 依赖：无
- [x] T2：单章生成 API（store upsert + generator + route + 测试）
  - 文件：beat-plan-store.ts、beat-plan-generator.ts、beat-plan-routes.ts、core/prompts/role-chapter-beat-planner.md、相关测试
  - 改动：见实现方向 T2
  - 验证：vitest 新增用例全绿（21 tests）
  - 依赖：弱相关 T1（已先合入）
- [x] T3：SSE chapter_context 补 beatConstraint（后端 detail + 前端渲染分支）
  - 文件：novel-orchestrator.ts、use-novel-creation-flow.ts
  - 改动：见实现方向 T3
  - 验证：creation-flow-routes.test.ts 18 tests 全绿；渲染分支随行审查
  - 依赖：与 T5 配对交付
- [x] T4：共享数据层 + 大纲树融合（store、labels、BeatEditForm、ChapterRow、BeatPlanGroup 切换）
  - 文件：novel-client.ts、stores/novel-beat-store.ts（实现采用独立轻量 store 而非并入 novel-data-store，规避 persist+zundo 成本）、hooks/use-beat-plans.ts、beat-labels.ts（新）、beat-edit-form.tsx（新）、beat-plan-group.tsx、outline-tree.tsx、project-tree.tsx、outline-tree.test.tsx
  - 验证：outline-tree.test.tsx 8 tests 全绿（含徽标/单章生成/已发布只读）
  - 依赖：T2 API 契约
- [x] T5：创作面板横幅（启动前取数 + 渲染）
  - 文件：chapter-beat-banner.tsx（新，挂 novel-conversation-panel 头部下方，读共享 store）
  - 验证：novel-conversation-interject.test.tsx 23 tests 全绿（面板回归）
  - 依赖：与 T3 配对；复用 beat-labels

## 任务关系
- 强相关：T3 + T5（SSE 字段与消费端成对交付）；T4 依赖 T2 的 API 契约。
- 弱相关：T1 与 T2 同域文件（novel-store / beat-plan 测试），顺序执行减少冲突。
- 独立：T1 与 T3 可并行。
- 冲突风险：T1/T2 都改 `__tests__/beat-plan.test.ts` 与 novel-store 域；T4/T5 都落在 workspace 组件区域，注意先后合入。

## RouteSync
- 需要 route-sync：是
- 预期更新：novel-plugin.md 的 REST 清单、领域子模块备注、新增一体化条目与 last-updated；任务完成后执行。
