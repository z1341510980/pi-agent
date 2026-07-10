# M5：硬编码提示词重构方案

> **状态**：方案记录，暂不实施
> **优先级**：中（违反项目硬约束，但短期不影响运行）
> **创建时间**：2026-07-06

## 一、问题描述

项目硬约束规定：「Prompt words for different systems must be configurable and cannot be hardcoded in the code」（提示词必须可配置，不能硬编码在代码中）。

但以下文件将完整的 LLM 指令硬编码在 TypeScript 代码中，而非通过 `promptManager` 从模板加载：

### 1.1 novel-entity-generator.ts

| 方法 | 行号 | 硬编码内容 |
|------|------|-----------|
| `buildUserPrompt` | 1006-1119 | 5 种实体类型（conflict/foreshadow/faction/location/world_element）的完整字段定义、枚举值说明、输出格式要求 |
| `planEntitiesFromOutline` | 846-894 | "已有实体清单"格式说明、功能位枚举、返回 JSON 格式要求 |

**示例**（buildUserPrompt 片段）：
```typescript
private buildUserPrompt(kind: EntityKind, coreStyle: string): string {
  const fields: Record<EntityKind, string> = {
    conflict: `字段说明：
- description: 冲突描述（必填）
- tier: 冲突层级，枚举值 [main, secondary, goal]
- firstChapter: 首次出现章节
- chapterSpans: 章节跨度数组 [[start, end], ...]
...`,
    foreshadow: `...`,
    // ... 其余 3 种类型
  }
  return `请根据以下信息生成${kind}实体：\n\n${fields[kind]}\n\n风格：${coreStyle}`
}
```

### 1.2 novel-memory-generator.ts

| 方法 | 行号 | 硬编码内容 |
|------|------|-----------|
| `buildUserPrompt` | 325-344 | 记忆提取的字段说明、输出 JSON 格式、约束条件 |

### 1.3 对比：符合规范的实现

`prompt-builder.ts` 的 `buildSystemPrompt` 正确使用 `this.promptManager.render('system-base', ...)` 从模板加载，符合规范。模板文件位于 `core/prompts/` 目录。

## 二、影响分析

### 2.1 短期影响
- **功能正常**：硬编码 prompt 能正常运行，不影响创作流程
- **调试不便**：调整 prompt 需改代码、重启服务，无法热更新

### 2.2 长期影响
- **违反硬约束**：项目规范明确要求提示词可配置
- **维护成本高**：每次新增字段需改代码而非改模板
- **A/B 测试困难**：无法在不发版的情况下试验不同 prompt
- **团队协作受限**：非开发人员无法调整 prompt

## 三、重构方案

### 3.1 目标
- 所有 LLM prompt 移至 `core/prompts/` 目录的模板文件
- 通过 `promptManager.render()` 加载，与 `system-base.md` 等模板一致
- 支持变量插值（实体类型、风格、已有实体清单等）

### 3.2 新增模板文件

```
core/prompts/
├── entity-generation.md       # 新增：实体生成 prompt（对应 buildUserPrompt）
├── entity-planning.md         # 新增：实体规划 prompt（对应 planEntitiesFromOutline）
└── memory-generation.md       # 新增：记忆生成 prompt（对应 memory-generator buildUserPrompt）
```

### 3.3 模板格式示例（entity-generation.md）

```markdown
请根据以下信息生成 {{entityType}} 实体：

## 字段说明
{{#each fields}}
- {{this.name}}: {{this.description}}
{{/each}}

## 枚举值
{{#each enums}}
- {{this.field}}: [{{this.values}}]
{{/each}}

## 输出格式
返回 JSON 数组，每个对象包含上述字段。

## 风格参考
{{coreStyle}}
```

### 3.4 代码改造

**改造前**（novel-entity-generator.ts:1006）：
```typescript
private buildUserPrompt(kind: EntityKind, coreStyle: string): string {
  const fields: Record<EntityKind, string> = { ... }
  return `请根据...${fields[kind]}...${coreStyle}`
}
```

**改造后**：
```typescript
private buildUserPrompt(kind: EntityKind, coreStyle: string): string {
  return this.promptManager.render('entity-generation', {
    entityType: kind,
    fields: ENTITY_FIELDS[kind],
    enums: ENTITY_ENUMS[kind],
    coreStyle,
  })
}
```

字段定义（`ENTITY_FIELDS`/`ENTITY_ENUMS`）可保留在代码中作为数据结构，或移至 `entity-fields.json` 配置文件。

### 3.5 迁移步骤

1. **提取现有 prompt 文本**到 `.md` 模板文件，保持原文不变
2. **识别变量**：把硬编码的动态部分（实体类型、风格、已有清单）改为模板变量
3. **改造代码**：`buildUserPrompt` 等方法改为调用 `promptManager.render()`
4. **回归测试**：对比改造前后 LLM 输出，确保 prompt 语义一致
5. **文档更新**：在 `PLUGIN_ARCHITECTURE_DESIGN.md` 补充新模板说明

### 3.6 风险与注意事项

| 风险 | 缓解措施 |
|------|----------|
| 模板引擎不支持复杂逻辑 | 项目已用 Handlebars 风格（确认 promptManager 实现），支持 each/if |
| 改造后 prompt 语义偏移 | 逐字迁移 + LLM 输出对比测试 |
| 字段定义与 TS 类型不同步 | 字段定义从 TS 类型生成，或用 codegen |

## 四、工作量评估

| 任务 | 复杂度 |
|------|--------|
| 提取 3 个 prompt 模板 | 低 |
| 改造 3 个方法的 prompt 构造逻辑 | 中 |
| 回归测试（需实际调用 LLM） | 中 |
| 字段定义配置化（可选） | 低 |

## 五、决策建议

**建议暂不实施**，原因：
1. 短期不影响功能运行
2. 当前 prompt 处于快速迭代期，频繁调整模板不如改代码方便
3. 待 prompt 稳定后（预计 2-3 个迭代后）再统一迁移

**触发条件**：当满足以下任一条件时启动重构：
- 非开发人员需要调整 prompt
- 需要对不同项目使用不同 prompt
- prompt 迭代频率下降到每月少于 2 次
