# 版本链收敛到 content_revisions，旧表只读归档

日期：2026-08-11 状态：已采纳

背景：正文版本曾双轨写入 novel_chapter_versions（旧）与 novel_chapter_content_revisions（V2 不可变链），同一正文最多三份，前端/后端/回滚读取来源不一致。

决策：novel_chapter_content_revisions 为唯一不可变正文版本链，novel_chapters.current_content_revision_id 为当前版本指针，novel_chapters.content 降级为读取缓存；novel_chapter_versions 停止新写、只读归档，下个主版本删除。切换经 versionChainV2Read/Write 两个 flag 灰度，先切读、再停写。

理由：不可变链 + 指针模型使回滚、版本面板、审计共享同一语义；旧表立即删除会破坏历史版本数据，违反迁移安全规范（先双写对账、再停写、观察一个版本）。

反方观点：保留旧表增加存储与认知负担。以"只读归档 + 对账差异为 0 后限期删除"收尾，不做永久双轨。
