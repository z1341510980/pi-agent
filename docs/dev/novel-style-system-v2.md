# 文风系统 V2：参考小说 → 专家管线整合方案

> 状态：部分实施（共享测量、参考源蒸馏、结构化专家、Writer 编译与 Reviewer 手法检查已落地；确定性指标差异报告和旧入口清理未完成）
> 日期：2026-08-17
> 前置：novel-style-system.md（V1 重构文档，其中专家部分被本方案取代）

---

## 0. 改造前问题

V1 之后曾存在三个模块各自为政的问题；下表用于保留改造动机，不代表当前实现状态。

| 模块 | 实际能力 | 问题 |
|---|---|---|
| 参考小说分析 | 本地 NLP：句长分布/段落节奏/对话占比/标点频率/词频/六通道感官词汇/人称信号/高频4-gram/章节长度/开头结尾形态 | 报告只展示，从不进创作链 |
| 文风指纹（prompt-builder 内） | 对已写章节测同一套指标（句长/对话比/比喻密度/人称/温度），带可信度降级 | 与参考分析是两套平行实现，代码互不复用 |
| 文风专家 | 一段自由文本 prompt；蒸馏=LLM 读粘贴样本写一段话 | 无结构、无证据、无验证，Reviewer 不认，召集后无法确认生效 |

用户定义的主流程（本方案的唯一主线）：

```
从参考小说中提取对应的文风作为专家，这个专家在写作的时候可以被召集。
```

---

## 1. 写作精髓的提取方法论

文风分三层，每层提取方式不同，混合处理必然失败。

### L1 形态层：辅助标注，不是精髓

句长分布（四桶）、段落长度分布、对话占比（字符级+段落级）、比喻密度、
感官通道分配（视/听/嗅/触/味/身体）、人称信号、标点习惯、开场收尾形态。

- 提取方式：确定性统计（现有 reference-analysis 已具备）
- 性质：只能提供客观旁证。"平均句长 14 字"不解释"为什么在这里切短"；词频更不能解释感情是如何被引爆的
- 用途：定位候选样本、给 LLM 分析附客观标注、做 Reviewer 的辅助对比
- 禁止：不能把这些统计直接包装成“文风精髓”，不能仅凭数字生成专家

### L2 手法层：提取主体，必须由 LLM 深读

- 信息释放顺序：先结果后过程 / 先场面后判断 / 延迟解释
- 视角距离的伸缩时机：何时贴皮肤、何时拉远，与场景压力的联动
- 情绪表达通道：走动作 / 走环境 / 走独白 / 走身体反应的配比
- 张力的制造与释放节奏：钩子的埋设方式、章节收束位置
- 对话的用法：推进 / 显性格 / 潜台词占比
- 场景切换技术：硬切 / 过渡句 / 感官桥接

提取方式：LLM 阅读**带 L1 辅助标注的分层采样文本**，产出手法卡。LLM 分析是主体，统计不是结论来源。

每次分析必须按描写维度分别处理，不能只让模型输出一段“总体文风评价”：

- **场景描写**：空间如何建立，远近/感官/细节如何选择，环境如何承载氛围和压力
- **人物描写**：人物如何出场，动作如何显性格，心理通过独白、动作还是生理反应呈现
- **对话描写**：台词推进什么，潜台词如何存在，不同人物如何被区分，对话和动作如何交织
- **动作/打斗描写**：镜头距离如何切换，快慢节奏如何组织，力量、痛感、环境反馈如何落地
- **感情引爆**：日常铺垫、压抑蓄势、引爆点选择、语言/句法变化、爆发后的余韵如何连接
- **叙事结构**：POV 距离、信息释放顺序、时间切换、场景转场和章节钩子如何运作

用户特别关心的“如何引爆感情”必须单独产出，不能被一个“情绪浓度”数字代替。
模型需要说明：引爆前埋了什么、延迟了什么、在哪个感官/动作上释放、爆发时文本形态发生了什么变化、爆发后如何留余波。
每张手法卡必须满足：

1. **原文锚定**：章节 + 引文（≤80字），无锚定的手法丢弃
2. **指标交叉验证**：手法声明的倾向必须与 L1 指标一致。
   声明"以短句制造紧张"而句长分布均匀 → 该卡降级为 unverified，不注入 prompt
3. **可执行性**：描述写成"迁移什么/如何触发/禁止什么"，禁止"文笔凝练"式空话

### L3 内容层：显式排除

意象库、专名、情节桥段、人物关系模式、独有比喻。
这是那本书的**内容**，不是**手法**。蒸馏必须产出排除清单，
并在 Writer 注入时附带（"不得复用"），否则蒸馏产物是仿写器。

**总结：精髓 = L1 骨架 + L2 带证据的手法 + L3 显式排除边界。**

---

## 2. 目标架构

```
┌─────────────┐   分层采样    ┌──────────────┐
│ 参考小说库   │ ───────────→ │ measurement   │ ← 同一模块测自己写的章节
│ (已有,保留)  │              │ 共享测量器     │    (替代 formatStyleFingerprint)
└─────────────┘              └──────┬───────┘
                                    │ L1 指纹
                                    ▼
                          ┌──────────────────┐
                          │ LLM 解读器        │  输入: 带指标的采样文本
                          │ (新增蒸馏管线)     │  输出: 手法卡 + 排除清单
                          └────────┬─────────┘
                                   │ 交叉验证
                                   ▼
                          ┌──────────────────┐
                          │ 专家组装 + 人工审核│
                          └────────┬─────────┘
                                   │
                    写作时召集 ────┤
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
             Writer 注入                    Reviewer 验收
          (参数约束+手法卡+证据样本)      (本章指纹 vs 专家L1 对比表
                                          + 手法体现检查)
```

---

## 3. 数据模型

### 专家（改造现有 novel_style_experts）

```ts
interface StyleExpertV2 {
  id: string
  projectId: string
  name: string
  status: 'draft' | 'active' | 'archived'

  // 来源（可追溯）
  source: {
    sourceId: string              // 指向 reference source
    sectionRange: [string, string] // 使用的章节
    sampleChars: number
    distilledAt: number
    analyzerVersion: string
  }

  // L1：结构化指纹（复用 ReferenceLocalAnalysisReport 的度量结构）
  metrics: StyleMetricsSnapshot

  // L2：手法卡（精髓）
  techniques: StyleTechniqueCard[]

  // L3：排除清单
  exclusions: string[]

  // 证据样本（从参考章节中精选，注入 Writer 用）
  exemplarPassages: Array<{ sectionId: string; text: string; reason: string }>

  // 编译缓存（由 techniques+metrics 生成，人工可改，改动记版本）
  compiledPromptOverride?: string
  version: number
}

interface StyleTechniqueCard {
  id: string
  name: string                    // 如"压力下视角贴皮肤"
  description: string             // 迁移什么/如何触发/禁止什么
  evidence: Array<{ sectionId: string; quote: string }>
  metricAnchors: string[]         // 引用的 L1 指标 key
  confidence: 'verified' | 'unverified' | 'rejected'
  kept: boolean                   // 人工审核保留/丢弃
}
```

### 共享测量器（从两处实现合并）

```ts
// 新文件: core/analysis/style-measurement.ts
interface StyleMetricsSnapshot {
  sentenceLength: Distribution & { buckets: Record<'1-10'|'11-20'|'21-40'|'41+', number> }
  paragraphLength: Distribution
  dialogueRatio: { char: number; paragraph: number }
  metaphorDensity: number          // 每千字
  sensoryMix: { visual; auditory; olfactory; tactile; taste; bodily }  // 归一化占比
  personSignal: { first; third }
  punctuationProfile: FrequencyItem[]  // top N
  repeatedExpressions: FrequencyItem[] // 高频4-gram
  openingShape / endingShape
  sampleQuality: { chars; paragraphs; trustworthy: boolean }
}
```

消费方：
- 蒸馏管线：测参考章节 → expert.metrics
- prompt-builder：测已写章节 → 文风指纹 chunk（替换现有实现）
- Reviewer 对比：两份 snapshot 的 diff

---

## 4. 蒸馏管线（重写现有 distill 接口）

```
输入: sourceId + sectionRange（从参考小说 UI 选择，不再是粘贴框）
步骤:
1. 取章节正文 → measurement → L1 指纹
2. 分层采样: 参考分析的统计只用于定位候选，最终由 LLM 判断段落功能；取 6-10 段，优先覆盖场景、人物、对话、动作/打斗、感情高潮、过渡段，不能只按词频截取
3. LLM 分维度深读: 输入=采样文本+每段附带的 L1 辅助标注；输出 JSON：六类手法卡（每卡带引文、机制、迁移方式）+ 排除清单
4. 交叉验证: 引文必须在原文中存在（模糊匹配容忍标点差）；L1 只能验证“模型的描述是否有客观迹象”，不能推翻对场景手法的语义分析；无法核验的卡降级 confidence
5. 组装 draft 专家 → 前端审核页（手法卡逐张勾选）
6. 确认入库
```

LLM 解读提示词的硬边界（写进系统提示）：
- 只提炼写作机制，禁止复述情节
- 每条手法必须引用原文 ≤80 字
- 禁止"文笔凝练/画面感强"类不可执行评价
- 必须输出"不迁移清单"

---

## 5. 召集与生效闭环

### Writer 注入（编译进 buildAgentIdentity）

被召集专家按序注入：

```
### 文风能力: {name}（来源: {sourceTitle}）
辅助形态标注: 句长/段落/对话/感官分布（不作为配额）
手法卡:（仅 confidence=verified 且 kept，L2 为主体）
  - {name}: {description}（证据方向: {引文关键词}）
样本: 1-2 段 exemplarPassage（带"学机制不学内容"声明）
排除: {exclusions}
```

体积预算：单专家 ≤1200 字符，多专家共享总预算 2000，超出按召集顺序截断。

### Reviewer 验收（LLM 手法检查为主，数字对比为辅）

本章写完后，先由 Reviewer LLM 对本章在场的场景/人物/对话/动作/感情手法进行语义检查；measurement 只作为辅助 diff：

```
句长均值: 本章17 vs 专家基准13 (偏离+31%, 带宽外)
对话占比: 本章22% vs 专家带宽[30%,55%] (低于下限)
感官侧重: 本章视觉主导 vs 专家身体感觉主导 (倒挂)
```

产出结构化报告进 Reviewer 上下文 + 前端气泡：
- 全绿 → "已体现专家文风"
- 偏离 → 列出具体维度，Reviser 可定向修

这是"专家真正起作用"的证明：召集前后的差异可测量。

### 与文风档案（基线）的关系

基线管本书出厂声音（人称/视角/语域/硬规则/正反样本），始终生效。
专家是叠加的能力层。冲突时基线优先（基线=作者意志，专家=借来的偏好）。

---

## 6. 前端整合

| 入口 | 功能 | 变化 |
|---|---|---|
| 参考小说工作台 | 源管理+质量报告（保留） | 每个源增加「蒸馏文风专家」按钮，选章节范围进入管线 |
| 蒸馏审核页（新） | 手法卡勾选、样本预览、命名 | 独立 Dialog，非弹窗套弹窗 |
| 专家库（专家 Tab 改造） | 列表/启用/版本/回滚（保留） | 详情增加 metrics 雷达图 + 手法卡浏览 |
| 输入框召集（保留） | 本轮选择 | 卡片增加"来源+verified 手法数"徽标 |
| 文风基线设置（保留瘦身） | 本书声音 | 不再含任何专家管理 |

---

## 7. 实施阶段

### 阶段 1：measurement 共享模块（无破坏，先消重复）
- 抽 style-measurement.ts，合并 reference-analysis 与 formatStyleFingerprint 的统计逻辑
- prompt-builder 的文风指纹 chunk 改调新模块（输出格式向后兼容）
- 测试：同一文本两路实现结果一致

### 阶段 2：蒸馏管线
- 新增 `POST /reference-sources/:sourceId/style-distill`：输入 sectionIds；旧粘贴式 `/writing-style-experts/distill` 暂留兼容
- LLM 解读器 + 引文回验 + 指标交叉验证
- 专家表加 metrics/techniques/exclusions/exemplars 列（JSON）
- 蒸馏审核页

### 阶段 3：生效闭环
- Writer 编译改造（参数化注入，受预算约束）
- Reviewer 对比报告（确定性 diff + 注入上下文）
- 前端召集徽标与验收气泡

### 阶段 4：清理
- 旧粘贴式蒸馏下线
- 文风档案编辑器移除专家 Tab（已在 V1 部分完成，彻底化）
- 文档更新

依赖关系：阶段 2 依赖 1；阶段 3 依赖 2；4 依赖 3。
每阶段独立可验证、可回滚。

当前实施对照：

| 阶段 | 状态 | 已完成与剩余项 |
|---|---|---|
| 阶段 1 | 已完成 | `style-measurement.ts` 已供参考分析、蒸馏和 Prompt Builder 共用 |
| 阶段 2 | 已完成主链路 | `sourceId + sectionIds` 蒸馏、分层采样、证据回验、指标锚点校验、结构化专家字段和逐卡审核已落地 |
| 阶段 3 | 部分完成 | Writer/Reviser/Reviewer 已编译结构化专家；Reviewer 已提交语义手法检查，确定性 metrics diff 和完整前端对比报告仍缺失 |
| 阶段 4 | 部分完成 | 文档已同步；旧粘贴蒸馏兼容入口、基线编辑器内专家管理容器仍保留 |

---

## 8. 与 V1 方案的差异

| V1 | V2（本方案） |
|---|---|
| 专家=来源+一段提示词 | 专家=结构化剖面（L1指标+手法卡+排除+样本） |
| 蒸馏=粘贴样本让 LLM 写话 | 蒸馏=参考库管线（测量→采样→解读→验证） |
| 召集=注入那段话 | 召集=参数化编译+Reviewer 确定性对比 |
| 参考分析模块与创作无关 | 参考分析=管线输入端+测量引擎 |
| 两套平行测量代码 | 一个共享 measurement 模块 |
