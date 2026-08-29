/**
 * prompts-protocol-constants：提示词协议共享常量（P1-5 防再漂移）。
 *
 * 背景：prompt-protocol.test.ts 长期用硬编码字符串做子串断言，提示词演进后
 * 出现「子串匹配掩盖意图漂移」（如 4 元素 vs 5 元素因果链、写前检查项从
 * 四件事变为四件事 + 一条修辞红线）。本文件把产品既定协议关键词抽为常量，
 * 测试引用常量而非硬编码字符串；prompt-protocol-constants.test.ts 守卫
 * 常量与提示词文件内容的一致性。
 */

/** 场景动力因果链（产品既定协议，5 元素；role-director/writer/reviewer/chapter-instruction/discussion 统一） */
export const SCENE_DRIVE_CAUSAL_CHAIN = '欲望 → 具体阻力 → 选择 → 后果 → 新问题'

/** Director 场景契约边界：不指定修辞方向、意象或比喻 */
export const DIRECTOR_NO_RHETORIC = '不指定修辞方向、意象或比喻'

/** Writer 写前确认项：场景动力四件事 + 一条修辞红线 */
export const WRITER_PREFLIGHT = '写前只确认场景的四件事和一条修辞红线'

/** Writer 行为后果铁律（至少改变一项局势维度） */
export const WRITER_CONSEQUENCE_RULE = '后果必须改变局势、关系、认知、资源、身体状态或时间压力'

/** Writer 禁止把 Director 结论直接写成角色共识 */
export const WRITER_NO_DIRECTOR_CONSENSUS = '禁止把 Director 的结论直接写成角色共识'

/** Writer 比喻约束：比喻是感官工具，不是身份标签 */
export const WRITER_METAPHOR_SENSORY = '比喻是感官工具，不是身份标签'

/** Writer 比喻约束：禁止职业比喻系统 */
export const WRITER_NO_PROFESSIONAL_METAPHOR = '禁止职业比喻系统'

/** Writer 比喻约束：比喻必须来自现场 */
export const WRITER_METAPHOR_FROM_SCENE = '比喻必须来自现场'

/** Reviewer 因果链验收（与 Writer 同一协议） */
export const REVIEWER_CAUSAL_CHECK = '因果链检查'

/** Reviewer 对话形态检查（防接口式对白） */
export const REVIEWER_DIALOGUE_PATTERN = '提问 → 完整回答 → 沉默 → 下一个问题'

/** Reviser 修订前保护检查 */
export const REVISER_SILENT_PROTECTION = '修订前的静默保护检查'

/** Reviser 修订不新增比喻 */
export const REVISER_NO_NEW_METAPHOR = '修订不新增比喻'

/** 群聊 Writer：台词留存义务（2026-08-29 口径修订：保留意图与信息差，授权改写/合并/拆分/挪位，禁止逐字钉入或全量丢弃） */
export const DISCUSSION_LINES_MUST_LAND = '必须保留的是人物的核心表达、意图和信息差，不是原句——把推演台词机械钉进正文，和全部丢弃一样，都是失职'

/** 群聊 Writer 风格约束：不机械整理成轮流对话记录（是风格建议，不再是丢弃台词的豁免条款） */
export const DISCUSSION_NO_ROBOTIC_SCRIPT = '不要把演出机械整理成完整、准确、轮流发言的对话记录'

/** 通用铁律：不必机械地让第一句都以动作开头 */
export const BASE_RULES_NO_FIRST_LINE_TEMPLATE = '不必机械地让第一句都以动作开头'

/** 人工样本优先于通用反 AI 规则 */
export const BASE_RULES_HUMAN_SAMPLE_PRIORITY = '文风档案的人工样本'

/** Writer 文风优先级：人工样本、通用反 AI 规则 */
export const WRITER_STYLE_PRIORITY = '文风档案中的人工样本、通用反 AI 规则'
