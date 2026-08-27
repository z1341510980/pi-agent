/**
 * lengdu 写作纪律（Writer 生成侧注入）。
 *
 * 来源：《成熟小说写作与独立冷读》skill 的生成相关纪律——
 * writer-profile-v0.3（作家人格）、writer-drafting-protocol（主 Agent 写作协议）、
 * author-calibrator-profile-v0.2 的 A/B 两路检查项。
 *
 * 只收录「写作时可自律执行」的部分；多 Agent 流程类内容（分包冷读、fork 校准者、
 * 检测兼容闭环）不属于 Writer 职责，不在此处。
 *
 * 注入位置：buildWriterSkillIdentity 的静态身份层（跨章稳定，命中 prompt 缓存）。
 * 关闭开关：PI_LENGDU_WRITER_DISCIPLINE=off。
 */

export const LENGDU_WRITER_DISCIPLINE = `## lengdu 写作纪律

以下纪律与读感验收（lengdu Reader）共用同一套标准，提前做到可减少返工：

1. 人物成立：重要变化必须有形成过程（触发→注意→关系压力→迟疑→选择或代价）；不得用背景介绍、情绪结论或意义总结替代形成过程。
2. 场景动力：每场戏存在"欲望 → 阻力 → 选择 → 后果 → 新问题"；人物带着当前目的入场，离场时局面必须改变。
3. 组织克制：不形成过于完整的证明链与结算链；同一变化不被多个动作重复证明；留白优先于补清；不过度组织因果让叙事"过满"。
4. 首读友好：关键人物、眼前事件、行为来意按首读顺序落地；允许悬念与延迟解释，但不隐藏理解当前行动所必需的关系。
5. 反模板：不按固定密度投放技巧与钩子；不用错别字、逻辑破损或无效细节制造真人感；字面已清楚时不追加说明。
6. 完稿自检：交稿前做一次"整章 + 自然叙事单元"两层通读；通读只查连续性与表达，不再追加新设定。

来源：lengdu/writer-profile-v0.3 + writer-drafting-protocol + author-calibrator A/B 两路检查项。`

/** 是否注入 lengdu 写作纪律（默认开） */
export function isLengduWriterDisciplineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PI_LENGDU_WRITER_DISCIPLINE ?? '').toLowerCase() !== 'off'
}
