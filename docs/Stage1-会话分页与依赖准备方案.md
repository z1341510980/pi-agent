# Stage 1 — 会话分页与依赖准备方案

> 创建时间：2026-07-27
> 关联文档：`AionUi-借鉴分析报告.md`（项目根目录）
> 当前阶段：Stage 1（Chat 功能增强前置准备）
> 方向决策：**B — 先做分页不做搜索**

---

## 1. 背景与目标

为对齐 AionUi 的会话管理体验，pi-agent 需要在前端引入：
- 会话历史消息的分页加载（避免一次性加载超长 JSONL）
- 置顶会话的拖拽排序（依赖 @dnd-kit/sortable）
- 后续阶段的本地搜索能力（不在本阶段实施）

本阶段聚焦「依赖准备 + 后端分页 API + 前端 http-client 方法补全」，不引入会话搜索功能。

## 2. 范围与非目标

### 范围
- 装齐 @dnd-kit 三个包并迁移到 `dependencies`
- 后端新增 `GET /api/sessions/:threadId/messages` 分页接口
- 前端 `http-client.ts` 补 `getSessionMessages` 方法
- TypeScript 类型检查通过

### 非目标（明确不做）
- ❌ 后端会话搜索 API（`GET /api/sessions/search