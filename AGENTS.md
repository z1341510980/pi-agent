# Agent 指南

## LLM 结构化输出：方案 D（submit 工具，非文本 JSON）

凡是要求模型输出结构化协议（节拍/章纲/叙事任务/验收报告等）的生成器，**不要用 `responseFormat: 'json'` + 文本解析作为主路径**——模型键名/大小写/嵌套漂移会直接打穿校验。改用闭包捕获式 **submit 工具**：

- TypeBox schema 定义参数；provider 约束 + SDK 校验，工具 execute 内闭包捕获 payload
- `createSession` 挂工具时**去掉 `responseFormat: 'json'`**（底座会注入 tool_choice='none'，工具不会被调用）
- 工具 execute 内对枚举/章号做防御式归一化校验，不合法返回纠正提示让模型重调
- 文本解析只作兜底（provider 不支持工具时）+ 一次同会话修复轮（把首次错误反馈回去）

范本：`core/chapters/beat-plan-generator.ts`（`submit_chapter_beat`）、`core/chapters/chapter-outline-generator.ts`（`submit_chapter_outline`）、`core/tools/submit.ts`（Director/Reviewer/Reviser 工具集）。
