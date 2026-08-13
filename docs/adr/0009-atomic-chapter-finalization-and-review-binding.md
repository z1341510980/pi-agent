# 章节最终提交原子化并绑定审稿版本

日期：2026-08-13 状态：已采纳

背景：Finalizer 曾先写 Memory 实体、MemoryEvent 和 Snapshot，最后才保存正文；正文或版本链失败会留下没有对应正文的未来状态。章节 Review 也只绑定 chapter，Reviser 或人工改稿后仍可能误用旧稿的通过结论。群聊断点快照一度为“停旧写”清空 scenes 和 arrangedEntities，导致 Writer 阶段无法恢复。

决策：Memory Generator 拆成 `analyze()` 与 `applyAnalysis()`。LLM 分析在事务外执行；正文、不可变 content revision、Memory 实体、MemoryEvent、章节维度和 Snapshot 在同一个短 SQLite 事务提交。Review 保存被审正文的规范化 SHA-256，并在正文落库后绑定匹配的 current revision；发布必须命中当前正文 hash 且绑定当前 revision 的 accept Review。DiscussionRun 保留断点恢复输入，但不得充当规范 Scene 主数据。

理由：网络调用不能占用长事务；业务写必须以章节正文为提交锚点。hash 解决“审稿先于正文落库”，revision 指针解决相同内容在不同版本链位置的审计歧义。运行恢复数据与稳定场景身份职责不同，保留前者不违反 Scene/SceneRevision 单一主数据决策。

后果：Memory 分析失败时可提交正文但不写状态变化，并明确记录失败；事务内任一步失败时全部业务写回滚。Reviser 产生的新正文没有对应 accept Review 时保持 review 状态，不能发布。历史 Review 没有可验证 hash，需重新审稿后发布。
