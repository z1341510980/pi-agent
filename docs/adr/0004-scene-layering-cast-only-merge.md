# 保留 Scene / SceneRevision 分层，仅合并 Cast 三表

日期：2026-08-11 状态：已采纳

背景：Scene 角色关联被拆成 novel_scene_focus / novel_scene_presence / novel_scene_functions 三张同构表，存在合并呼声；同时有提议把 novel_scenes 与 novel_scene_revisions 一并合并减表。

决策：三张角色关联表合并为 novel_scene_cast（role ∈ focus/present/functional，复合主键 + CHECK 约束）；novel_scenes（稳定场景身份）与 novel_scene_revisions（版本状态）保持分层，不合并。

理由：Scene 与 SceneRevision 分别表达"这个场景是谁"和"这个版本什么样"，合并后稳定身份随版本复制，跨版本引用（出场关系、推进记录）将失去锚点。Cast 三表则是纯同构重复，合并后往返转换对账差异为 0（reconcile-scene-cast 验证）。

反方观点：cast 单表丢失三表各自的语义命名。以 role 列 + CHECK 约束保留语义，功能位以 function 非空约束兜底。
