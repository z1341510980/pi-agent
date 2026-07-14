# 小说信息查询 A+B + Pi SDK Skill 落地

## 完成内容

### A. 恢复并收敛小说 Agent 的查询能力
- 修改 `apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts`
  - 给 `director` / `writer` / `reviewer` / `reviser` 开放单一语义化查询工具 `novel_ask_story`
  - 不开放全量 `novel_query_state` / 写工具，避免 token 爆炸和误修改状态

### B. 新增语义化查询工具 `novel_ask_story`
- 修改 `apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts`
  - 新增 `novel_ask_story` 工具，支持自然语言问题
  - 内置路由：上一章/角色/冲突/伏笔/线索/风格/大纲/世界设定
  - 返回精炼 Markdown，不 dump 全表

### Pi SDK Skill 落地
- 创建 `.pi/skills/novel-assistant/SKILL.md`
  - 符合 Agent Skills 标准（frontmatter name/description）
  - 定义小说创作中何时/如何用 `novel_ask_story` 查询信息
  - Pi SDK `DefaultResourceLoader` 会自动从 `cwd/.pi/skills` 发现并列出该 skill

## 关键设计决策

1. **为什么只给一个工具**：给 Agent 多个只读查询工具会触发 LLM 反复调用、上下文膨胀。`novel_ask_story` 一个入口覆盖常见查询意图，内部按关键词路由。
2. **Skill 与工具的关系**：SKILL.md 只注入 name/description/location，完整内容由 Agent 通过内置 `read` 工具按需读取；实际调用由 `novel_ask_story` 工具完成。
3. **状态修改仍由 Memory Agent 负责**：Director/Writer/Reviewer/Reviser 只有只读工具，不写状态，保持现有架构不变。

## 验证

- `pnpm --filter agent-server exec tsc --noEmit` 通过
- `pnpm --filter desktop exec tsc --noEmit` 通过
- `team-discussion-engine.test.ts` 6 项测试通过
- `pi-session-confirmation.test.ts` 3 项测试通过
- agent-server 全量测试中的失败用例（arranged-entities / novel-routes 等）为历史已有问题，与本次改动无关

## 使用方式

Agent 在创作/修订过程中可直接调用：

```
novel_ask_story({
  projectId: "...",
  question: "上一章结尾是什么？",
  chapterNumber: 9
})
```

支持的查询意图：
- 上一章/最近章节/结尾/前情
- 角色 "xxx" 的状态/目标/压力
- 当前冲突/最大冲突
- 未回收伏笔
- 进行中线索
- 风格指南
- 项目大纲
- 世界规则/势力/地点
