# 小说创作接口清单

本文按页面和用户操作路径整理小说创作相关接口。接口前缀为 `/api/plugins/novel`。

## 小说工作区

### 手动编排后创作

用户路径：打开章节 → 在矩阵中选择角色、冲突、伏笔、势力、地点 → 点击“编排模式创作” → 在 Director / Reviewer 检查点确认。

| 方法 | 路径 | 主要请求字段 | 主要结果/事件 |
|---|---|---|---|
| POST | `/projects/:projectId/chapters/:chapterNumber/create-flow` | `arrangedEntities.characterIds`, `conflictIds`, `foreshadowIds`, `factionIds`, `locationIds` | AG-UI SSE；Director、Writer、Reviewer、Reviser、Memory 进度；章节正文和状态变更 |
| POST | `/projects/:projectId/checkpoint/:checkpointId/decision` | `decision`: `approve/revise/rewrite/reject`；`userMessages[]` | 恢复等待中的 workflow；用户意见注入下一 Agent |

### 群聊模式创作

用户路径：打开章节 → 选择“群聊模式” → Director 拆分场景 → 当前场景角色 Agent 对戏 → Writer 编织全章 → Reviewer 验收 → 用户确认。

| 方法 | 路径 | 主要请求字段 | 主要结果/事件 |
|---|---|---|---|
| POST | `/projects/:projectId/chapters/:chapterNumber/create-discussion` | 与 `create-flow` 相同的 `arrangedEntities` 字段 | AG-UI SSE；场景、主持人点名、角色演出、Writer 编织、最终审稿和 Memory 收尾 |
| POST | `/projects/:projectId/discussion-checkpoint/:checkpointId/decision` | `decision`; `userMessages[]` | 群聊暂停点决策；群聊消息不注入 workflow Orchestrator |

群聊成员字段：`id`、`type`、`name`、`expertise`、`characterProfile.personality`、`currentState`、`currentGoal`、`secret`、`arcStage`、`participatingConflicts`。场景字段：`sceneId`、`title`、`location`、`time`、`presentCharacters`、`presentCharacterNames`、`unresolvedCharacterNames`、`conflict`、`goal`、`emotion`。

角色 Agent 规则：角色库已有角色复用其角色卡；Director 临时引入且未建档的角色创建本次运行使用的临时 Agent，不自动写入角色库；未解析角色不会扩散为全体角色出场。

### AI 编排与反推

用户路径：打开章节 → 点击“AI 编排”或“反推编排” → 查看实体和关系 → 再选择 `create-flow` 或 `create-discussion` 生成正文。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects/:projectId/chapters/:chapterNumber/ai-arrange` | 按章纲生成并编排角色、冲突、伏笔、势力、地点；本接口不直接生成正文 |
| POST | `/projects/:projectId/chapters/:chapterNumber/reverse-arrange` | 从已有章节内容反推实体编排；本接口不直接生成正文 |

## 章节聊天页面

用户路径：打开章节 → 查看历史聊天 → 输入问题或 `@Agent` → 接收 SSE 回复 → 可清空历史。

| 方法 | 路径 | 主要字段/行为 |
|---|---|---|
| GET | `/projects/:projectId/chapters/:chapterNumber/chat` | 返回章节聊天消息：发送者、Agent、内容、时间、阶段 |
| POST | `/projects/:projectId/chapters/:chapterNumber/chat` | `message`，可选 `mentionedAgents[]`；SSE 返回一位或多位 Agent 回复 |
| DELETE | `/projects/:projectId/chapters/:chapterNumber/chat` | 清空当前章节聊天历史 |
| POST | `/projects/:projectId/chapters/:chapterNumber/chat/persist` | `phase`、`role`、`content`、`fromId`、`fromName`、`metadata`；保存创作过程中的用户消息 |

## Agent 设置页面

用户路径：打开设置 → Agent → 修改 Moderator 模型、轮数和角色温度 → 保存。

| 方法 | 路径 | 字段 |
|---|---|---|
| GET | `/discussion-settings` | `moderatorModel.provider`、`moderatorModel.modelId`、`maxRounds`、`maxRoundsPerScene`、`characterTemperature` |
| PUT | `/discussion-settings` | 更新上述设置；下一次群聊和章节聊天读取最新值 |

## 外部系统与复用

- LLM Provider：Director、Writer、Reviewer、Reviser、Memory、角色 Agent 和 Moderator 均通过 Provider Session 调用外部模型。
- AG-UI/SSE：`create-flow`、`create-discussion`、章节聊天、AI 编排、反推编排共用 SSE 事件协议和前端流式解析。
- `checkpoint/:checkpointId/decision` 与 `discussion-checkpoint/:checkpointId/decision` 复用 ConfirmationManager；前者兼容 workflow，后者保留群聊别名。
- `create-flow` 与 `create-discussion` 共用 `ChapterFinalizer`；两者分别复用章节上下文、矩阵编排字段和章节聊天持久化接口。

## 当前明确的边界与待确认项

1. 临时角色 Agent 只在本次群聊生命周期内存在，是否需要持久化为角色卡，需要产品确认。
2. `arrangedEntities` 中的角色是“必须出场”还是“候选角色”，当前按章节约束注入，但最终出场由 Director 场景规划决定。
3. Reviewer 的 `approve/revise/reject` 是用户检查点决策；自动审查失败时放行，不阻塞章节生成。
4. AI 编排接口与正文生成接口分离，前端必须在编排完成后显式触发生成流程。
