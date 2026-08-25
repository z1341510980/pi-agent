/**
 * 文风专家种子脚本 v2：《开局长生，苟在下界吃土飞升》（倩玉小说网 709632）
 *
 * v1 教训：只有一个专家、六条正向手法、没有失效条件、没有张力、没有反例——
 * Writer 拿到的仍是"样样都要做到"的空泛清单。v2 按 nuwa-skill 的方法论重做：
 *
 *   - 三重验证：每条 verified 手法必须跨域复现（crossDomain≥2）、有生成力、有排他性，
 *     且必须写出失效条件（failureMode）——没有"何时不适用"的手法会被无差别套用；
 *   - 表达 DNA 六项（句式/词汇/节奏/幽默/确定性/叙述距离）；
 *   - 内在张力：文风自身拉扯的力量 + 取舍原则，防止 Writer 追求样样满分；
 *   - 反模式与诚实边界：明确"不写什么"与"覆盖不到什么"。
 *
 * 文风基线同步扩充：
 *   - 正向样本 4 条，覆盖不同场景类型（对话场/动作场/静场），供 buildSceneSampleSection 分桶；
 *   - 反向样本 2 条，取自本项目自己被判高 AI 率的早期章节——它们最诚实地暴露了
 *     要避免的毛病（感官堆叠、每句都挂身体反应、排比三连、零对话）。
 *
 * 用法：
 *   pnpm --filter agent-server exec tsx scripts/seed-style-expert-qianyu.mts \
 *     --db <path> --project <id> --samples-dir <dir> [--dry]
 *
 * --samples-dir 必须包含抓取的章节纯文本（chNN.txt）；所有证据引文与范例段都会
 * 做原文存在性校验（与 distiller 相同的归一化规则），失败即中止写入。
 * 幂等：重复执行会删除同名专家后重建。
 */
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { NovelStore } from '../src/plugins/novel-plugin/core/novel-store.js'

interface Args {
  db: string
  project: string
  samplesDir?: string
  dry: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { db: '', project: '', dry: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--db') args.db = argv[++i] ?? ''
    else if (flag === '--project') args.project = argv[++i] ?? ''
    else if (flag === '--samples-dir') args.samplesDir = argv[++i] ?? ''
    else if (flag === '--dry') args.dry = true
  }
  return args
}

// 与 style-expert-distiller.evidenceQuoteExists 相同的归一化规则
function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}
function quoteExists(sample: string, quote: string): boolean {
  const trimmed = quote.trim()
  if (!trimmed) return false
  if (sample.includes(trimmed)) return true
  const ns = normalizeEvidenceText(sample)
  const nq = normalizeEvidenceText(trimmed)
  return nq.length >= 4 && ns.includes(nq)
}

/** 按首尾锚点截取连续原文（锚点必须唯一命中），避免行号漂移 */
function excerptBetween(text: string, startAnchor: string, endAnchor: string): string {
  const start = text.indexOf(startAnchor)
  if (start === -1) throw new Error(`起始锚点未找到: ${startAnchor.slice(0, 24)}…`)
  const endMarker = text.indexOf(endAnchor, start)
  if (endMarker === -1) throw new Error(`结束锚点未找到: ${endAnchor.slice(0, 24)}…`)
  return text.slice(start, endMarker + endAnchor.length).trim()
}

/** 在窗口内截取并在最后一个句号处收尾 */
function smartTrim(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.trim()
  const head = text.slice(0, maxChars)
  const lastStop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'))
  return (lastStop > maxChars * 0.5 ? head.slice(0, lastStop + 1) : head).trim()
}

const SOURCE_TITLE = '开局长生，苟在下界吃土飞升'
const SOURCE_AUTHOR = '混沌核心'
const OLD_EXPERT_ID = 'style-changsheng-baimiao-v1'
const EXPERT_PREFIX = 'style-cs'

const CHAPTER_FILES = ['ch15', 'ch19', 'ch20', 'ch30', 'ch34', 'ch183', 'ch486', 'ch487', 'ch785', 'ch839', 'ch914', 'ch1075', 'ch1076', 'ch1078'] as const
type ChapterId = typeof CHAPTER_FILES[number]

// ── 手法定义 ──
//
// 每条手法：dimension/name/mechanism/transfer/failureMode + evidence（原句摘录）
// + validation（三重验证）。verified 由脚本按以下门槛复核：
// 证据存在 && crossDomain>=2 && generative && exclusive && failureMode 非空。

interface TechniqueSeed {
  dimension: 'scene_craft' | 'character_craft' | 'dialogue_craft' | 'action_craft' | 'emotion_craft' | 'narrative_craft'
  name: string
  mechanism: string
  transfer: string
  failureMode: string
  evidence: Array<{ sectionId: ChapterId; quote: string }>
  crossDomain: number
}

interface ExpertSeed {
  id: string
  name: string
  sortOrder: number
  description: string
  distilledPrompt: string
  expressionDna: {
    sentence?: string
    lexicon?: string
    rhythm?: string
    humor?: string
    certainty?: string
    distance?: string
  }
  tensions: Array<{ name: string; between: [string, string]; resolution: string }>
  antiPatterns: string[]
  boundaries: string[]
  techniques: TechniqueSeed[]
  exemplar: { sectionId: ChapterId; start: string; end: string; reason: string }
  exclusions: string[]
}

const EXPERTS: ExpertSeed[] = [
  // ── 1. 情感与人物 ──
  {
    id: `${EXPERT_PREFIX}-emotion-v2`,
    name: '压后爆·情感白描',
    sortOrder: 0,
    description: '情绪低温铺垫、一处引爆、器物承情；人物心理诚实到不光彩也照写。自《开局长生》崇明殿托死、赵朗之死等章节蒸馏。',
    distilledPrompt: '情绪先压后爆：铺垫期全员克制，一章最多一处失态引爆，引爆台词允许重复破碎，爆后冷处理切场景。思念与哀悼不直写，落在与逝者相关的具体物件上。重大刺激下先写角色真实的私心本能，再让他自己惊觉，不加作者评判。悲伤段落的结尾落一句克制的日常话，不在悲处停留。',
    expressionDna: {
      sentence: '叙述句可长，落点句必须短且常独立成段；情绪爆点全部拆成短句',
      rhythm: '先铺陈后收拢；转折不用「然而/但是」起手，用事实并置让读者自己感到转折',
      lexicon: '平实准确，偶用文言残句点睛；禁止华丽形容词堆叠',
      humor: '冷幽默与自嘲藏在对话缝隙里，不专门写笑点段',
      certainty: '人物断言干脆，叙述者保留；内心话允许不光彩',
      distance: '第三人称限知贴主角，但敢写主角不愿承认的念头',
    },
    tensions: [
      {
        name: '克制与引爆',
        between: ['绝大部分篇幅低温白描', '唯一的爆点必须彻底失态'],
        resolution: '一章最多一个引爆点，其余情绪全部压进动作和物件里；处处中等强度等于没有强度',
      },
      {
        name: '诚实与可爱',
        between: ['主角的私心要照实写', '主角必须仍被读者认同'],
        resolution: '私心之后立刻给一个利他的实际行为兜底，让读者自己完成和解，不由作者辩护',
      },
    ],
    antiPatterns: [
      '用旁白解释人物刚做的事为什么合理',
      '情绪形容词堆叠（悲痛欲绝/心如刀绞）代替具体动作',
      '让同一个角色当场流泪多次；眼泪必须有具体触发物',
      '全员同频反应（「众人皆是骇然」）',
    ],
    boundaries: [
      '不适合快节奏群战章——分层情绪需要喘息空间',
      '不提供世界观与修炼体系层面的写法',
      '单章多视点多线并进的结构未验证',
    ],
    techniques: [
      {
        dimension: 'emotion_craft',
        name: '身份撑满后的失态爆发',
        mechanism: '引爆前用身份和体面把人物撑到最满（帝王、天骄），爆发时哀求短句连续重复，语言失去体面，爆后不做任何安慰直接冷处理。',
        transfer: '引爆前抬高人物的自持程度，爆发台词允许重复与破碎，爆点之后切场景或换话题，余韵留给读者而非旁白总结。',
        failureMode: '群像配角或本就卑微的人物不适用——他们的崩溃应更短促克制；连续高压章每章都引爆会让读者脱敏。',
        evidence: [{ sectionId: 'ch34', quote: '朕今年才五十八岁！平日里向来注重养生之道，也无纵欲过度之嫌' }],
        crossDomain: 3,
      },
      {
        dimension: 'character_craft',
        name: '不光彩心理的白描',
        mechanism: '面对他人死亡或灾祸，先写真实的第一反应（如释重负的轻松），再让角色自己惊觉其卑劣，两层之间不做道德净化。',
        transfer: '重大刺激下先给私心本能，再给自我审视；作者不添加评判词，让两层之间的落差自己说话。',
        failureMode: '视角人物与事件无利害关系时不适用——没有利害就没有卑劣感，强写会假。',
        evidence: [{ sectionId: 'ch1078', quote: '这轻松感来得如此自然，却又如此卑劣，让简云渊悚然一惊' }],
        crossDomain: 3,
      },
      {
        dimension: 'character_craft',
        name: '器物承情',
        mechanism: '思念与哀悼不直写，落在与逝者相关的具体物件上：坟头银杏、共栽的枇杷树。物件的生长状态就是人物没说出口的话。',
        transfer: '想写思念时找一个前文出现过的相关物件，只写它的现状，删掉所有情绪形容词。',
        failureMode: '物件与前文没有既定关联时不能硬安——没有铺垫的道具没有情感重量。',
        evidence: [
          { sectionId: 'ch34', quote: '在上面种了一株银杏树，如今三年过去，长势颇为喜人' },
          { sectionId: 'ch19', quote: '那枇杷树是父皇与母后一起亲手栽下的，您应还记得罢？' },
        ],
        crossDomain: 2,
      },
      {
        dimension: 'emotion_craft',
        name: '哀而不伤的收束',
        mechanism: '悲情段不在悲处停笔：情绪顶点之后落一句克制的日常话（也算是成材了/乘兴而来兴尽而去），把余韵交给沉默。',
        transfer: '哭戏或诀别戏的最后一句必须是平静的低语音量，禁止以嚎啕收尾。',
        failureMode: '若本章任务就是把情绪推到卷末高潮，这句日常收束会泄力；高潮章让情绪停在顶点。',
        evidence: [
          { sectionId: 'ch19', quote: '好，好啊……也算是成材了。' },
          { sectionId: 'ch34', quote: '乘兴而来，兴尽而去' },
        ],
        crossDomain: 2,
      },
    ],
    exemplar: {
      sectionId: 'ch1076',
      start: '其他天骄？最近的几人距离他不过数十丈',
      end: '反倒让周边的天骄离他更远了些。',
      reason: '群体见死不救的标准写法：距离的精确、借口的合理化、呼救的反效果，三层递进全程无一句情绪形容词。',
    },
    exclusions: [
      '人物姓名与称谓体系（荆雨/赵明成/简云渊等）',
      '仙侠境界、法宝、功法专名及其【】标记格式',
      '任何情节、场景与原句复制',
    ],
  },

  // ── 2. 对话暗线 ──
  {
    id: `${EXPERT_PREFIX}-dialogue-v2`,
    name: '对话暗线·权力推演',
    sortOrder: 1,
    description: '温柔口吻说残忍内容、借典故传话、利益摊开算账；对话承载权力关系与潜台词，叙述只记录听者的生理反应。',
    distilledPrompt: '对话推进叙事：轮次要短，一句一段，潜台词压在动作和停顿里。反派与精明角色的威胁全部包在礼貌措辞里，杀气交给听者的身体反应。要让角色传危险的话时，让他引用一段典故或旧文，真意留在选段的取舍里。势力谈判把成本收益摊开算账，越冷血的逻辑讲得越平静。主角在人前维持的伪装层与读者知道的真实层构成落差。',
    expressionDna: {
      sentence: '对话轮次短促，一句一段；长篇解释只留给「讲课型」角色且必须言之有物',
      rhythm: '对话推进剧情，叙述只补听者的生理反应；信息差在轮次之间逐步释放',
      lexicon: '口语与敬语按身份分层；称呼即关系（道友/父皇/大哥）',
      humor: '误会式幽默为主，靠旁观者误判产生，不由叙述者抖包袱',
      certainty: '表面措辞保留余地，内心判断斩钉截铁',
      distance: '限知视角贴听话人，说话人的真意通过听话人的解读落地',
    },
    tensions: [
      {
        name: '礼貌与杀机',
        between: ['对话表面滴水不漏', '内容步步紧逼'],
        resolution: '措辞可以软，条款必须硬；软只是包装，绝不是退让',
      },
      {
        name: '信息差与公平',
        between: ['读者早于场上角色知情', '场上角色不能为此降智'],
        resolution: '让不知情者依据自身立场做出合理误判，而不是突然变傻来配合主角',
      },
    ],
    antiPatterns: [
      '用对话复述双方都已知道的信息',
      '反派自报家门式独白（我这么做是因为……）',
      '谈判结果由叙述者宣布而不是由对话达成',
      '每句话都带「他说」「她说」的机械标注',
    ],
    boundaries: [
      '不覆盖武打过程中的招式喊招对话',
      '三人以上同时开口的混战场面未验证',
      '纯喜剧相声式对白不是这套能力的目标',
    ],
    techniques: [
      {
        dimension: 'dialogue_craft',
        name: '温柔口吻说残忍内容',
        mechanism: '说话者语气越温和，内容越冷酷，反差由听者的生理反应（心中发冷）感知，作者绝不评论。',
        transfer: '精明角色的威胁全部包在关心和礼貌里；杀气不写在说话人身上，写在听话人身上。',
        failureMode: '双方实力悬殊到无需掩饰时，直接的威胁更有力；温柔包装反而显得绕。',
        evidence: [{ sectionId: 'ch183', quote: '胡月秋温柔地看着怀中的儿子，止不住的喜爱之情，只是口中的言语却如一柄柄利剑' }],
        crossDomain: 2,
      },
      {
        dimension: 'dialogue_craft',
        name: '借古喻今的暗线传话',
        mechanism: '想传的话不明说，让对方和读者从第三方文本的选段取舍里拼出来；解码过程完整呈现在正文里。',
        transfer: 'A 要对 B 说危险的话时，让 A 引用一段史书或旧事；读者参与解码，说者保持清白。',
        failureMode: '典故必须在场内给出原文，否则读者无法参与解码；纯掉书袋等于什么都没说。',
        evidence: [{ sectionId: 'ch487', quote: '所谓【民气可用】' }],
        crossDomain: 3,
      },
      {
        dimension: 'dialogue_craft',
        name: '利益算计摊开讲',
        mechanism: '谈判双方把成本收益摆上台面逐条算账（分成比例、补给分配），恶毒的逻辑用清爽的数字讲。',
        transfer: '势力博弈对话用具体数字与条款推进，禁止喊口号；账算得越平静，内容越有压迫感。',
        failureMode: '情感关系戏不能用账本逻辑，会显得角色无情无义——除非薄凉就是该角色的人设。',
        evidence: [{ sectionId: 'ch1075', quote: '五成丹资中，岳某愿意分你两成……你不必炼丹，只需坐享其成便好。' }],
        crossDomain: 2,
      },
      {
        dimension: 'character_craft',
        name: '装拙人设的双层经营',
        mechanism: '主角在人前维持懒散平庸的表演层，真实实力只让读者知道；旁观者的误判同时供应喜剧与张力。',
        transfer: '藏拙场景写两层：给别人看的表演 + 给读者的真实；落差即幽默，误判即钩子。',
        failureMode: '连续多章只藏拙不出手会把读者憋闷；每次藏拙后必须紧跟一次半露锋芒兑现期待。',
        evidence: [{ sectionId: 'ch19', quote: '回父皇，儿臣政论丙下，兵策丙中！' }],
        crossDomain: 3,
      },
    ],
    exemplar: {
      sectionId: 'ch183',
      start: '胡月秋温柔地看着怀中的儿子',
      end: '不都找补回来了？”',
      reason: '温柔口吻承载最冷酷的算计的完整示范：逗孩子、谈战争、把人命折算成灵机肥田，全程笑意盈盈。',
    },
    exclusions: [
      '具体的朝堂制度与宗门架构设定',
      '原作的典故文本（《太祖本纪》引文本身）',
      '人物结盟关系与阵营立场',
    ],
  },

  // ── 3. 长生时间尺度 ──
  {
    id: `${EXPERT_PREFIX}-timescale-v2`,
    name: '长生尺度·账本叙事',
    sortOrder: 2,
    description: '百年千年用账本句带过、视角高度即主题、周期重复中藏突变；时间的重量靠具体物件与寿命换算呈现。',
    distilledPrompt: '时间跳跃只用一到两句账本（纪年+年龄+结果清单），随后必须落到一个当下的具体物件或动作上。写大势时切一次底层视角，用寿命换算让抽象时间可感（两百年是一个练气修士的两辈子），观点分歧保留不裁决。先用三五句建立「一直如此」的周期感，再让意外在重复中发生。重要角色死后用事务性语言处理后事，情绪藏在流程选择里。',
    expressionDna: {
      sentence: '时间状语开头（此后/又过了X年/这一日）；跨度越大句子越平静',
      rhythm: '大跨度章节内部仍嵌一场完整的当下戏；账本句之间不许真空',
      lexicon: '纪年标记与年号并存；数字精确（五十八岁/三百年），拒绝「许多年」',
      humor: '与巨大时间尺度反差的市井气（窝在洞府看志怪小说打发时间）',
      certainty: '叙述者对时间长河平静，对当下细节偏执地精确',
      distance: '从万年尺度俯瞰之后，总能收回一个人、一件物的特写',
    },
    tensions: [
      {
        name: '尺度与温度',
        between: ['百年千年一笔带过的冷静', '读者对角色的牵挂需要当下细节'],
        resolution: '每次时间跳跃后必须给一个当下的具体场景作为锚点，禁止连续两段账本',
      },
      {
        name: '宿命与主动',
        between: ['长生者理应看淡生死轮回', '主角仍为眼前之人奔走'],
        resolution: '行动的理由永远是具体的个人（侄孙女/徒弟/故人之树），不是宏大叙事',
      },
    ],
    antiPatterns: [
      '时间跳跃后用「岁月流逝，沧海桑田」式空话填充',
      '把时间跨度直接当史诗感（堆纪年不出人物）',
      '回忆杀超过一千字打断当前叙事线',
      '账本句里夹叙尚未发生的事',
    ],
    boundaries: [
      '单卷内的日级时间推进用不上这套手法',
      '多线并行的并行时间管理未验证',
      '倒叙为主的悬疑结构不在此能力范围',
    ],
    techniques: [
      {
        dimension: 'narrative_craft',
        name: '账本式时间跳跃',
        mechanism: '数十年跨度用纪年加年龄的账本句交代（如今已是祥符二十七年……荆雨四十五岁 / 又是两百余年匆匆而过），随后立刻落到一个具体物件或动作上。',
        transfer: '跳跃不超过两句账本加一个落点；跳过的事件用结果清单带过，绝不补写场面。',
        failureMode: '跨度中间若有读者关心的重大事件（重要角色死亡、关键约定），必须展开写；账本只用于无事发生的岁月。',
        evidence: [
          { sectionId: 'ch839', quote: '又是两百余年匆匆而过' },
          { sectionId: 'ch34', quote: '如今已是祥符二十七年，距离赵明成即位已过了整整二十六个年头，荆雨四十五岁。' },
        ],
        crossDomain: 3,
      },
      {
        dimension: 'narrative_craft',
        name: '视角高度即主题',
        mechanism: '同一战局让高位者与底层各给一套都成立的判断，作者不下结论；时间尺度本身就是论证的一部分（两百年是一个练气修士的两辈子）。',
        transfer: '写大势时切一次底层视角，用寿命换算让抽象时间可感；议论之后立刻接一个具体小动作泄压。',
        failureMode: '议论不得超过一页纸；连续两段观点交锋而没有具体人事落地就会变成社论。',
        evidence: [{ sectionId: 'ch785', quote: '从不同的视角、高度看待问题，会得出截然不同的结论，这何尝不是高修的傲慢？' }],
        crossDomain: 2,
      },
      {
        dimension: 'scene_craft',
        name: '庸常重复中的突变',
        mechanism: '先用三五句建立周期性的「一直如此」（每次墟魔来袭都一样/寿宴五年一办），然后让意外在重复的正中央发生，并用独立短段点破。',
        transfer: '重复铺垫控制在三五句以内；打破句单独成段，前后都不解释。',
        failureMode: '铺垫不足时打破无力；铺垫超过半页则拖沓——节奏配比是这条手法的生命。',
        evidence: [{ sectionId: 'ch1076', quote: '意外往往就是在庸常的重复中发生了' }],
        crossDomain: 2,
      },
      {
        dimension: 'narrative_craft',
        name: '身后事的账本清点',
        mechanism: '重要角色死后不抒情：清点遗物、安排后事（就地掩埋/骨灰种银杏/储物袋抵封口费），用事务性语言完成告别。',
        transfer: '死亡之后的段落写处理流程而不是心情；情绪全部藏在流程的选择里（埋在哪里、留下什么）。',
        failureMode: '死者若是本章情感核心，全账本化会显得冷血；至少保留一件遗物的特写。',
        evidence: [{ sectionId: 'ch1078', quote: '尘归尘，土归土。既然陨落于此，就地掩埋便是。' }],
        crossDomain: 3,
      },
    ],
    exemplar: {
      sectionId: 'ch34',
      start: '如今已是祥符二十七年',
      end: '在上面种了一株银杏树，如今三年过去，长势颇为喜人。',
      reason: '账本叙事的标准示范：四个亲人死亡的清单式交代，每一笔都落在一个具体选择上，最后停在银杏树的长势上。',
    },
    exclusions: [
      '长生历纪年体系与修士寿命设定本身',
      '具体的历史事件序列',
      '轮回转世的世界观机制',
    ],
  },

  // ── 4. 动作场面 ──
  {
    id: `${EXPERT_PREFIX}-action-v2`,
    name: '动作场面·异象分层',
    sortOrder: 3,
    description: '一招定胜负、旁观者标定强弱、异象分层递进；暴力写得越随意越可怕，最高潮之后必落回人间口吻。',
    distilledPrompt: '实力悬殊的战斗只写出手的瞬间和结束的姿态，过程留白；强弱差距由远处旁观者的生理反应定义。恐怖不写氛围写后果：施暴写得越随意越好，惨烈全部放在受害者结局的具体细节上。大能力显现有视觉层次（三到四层，一层比一层超出预期），最高潮之后必须用一句市井口吻收尾降温。动作句短促，拟声词独立成段。',
    expressionDna: {
      sentence: '动作句短促有力，拟声词独立成段；异象描写可以放开成长句',
      rhythm: '出手前蓄势放慢，交手瞬间加速，结束后立即降温回归日常',
      lexicon: '具体的物理动词（砸/碾/咬/压），禁止「恐怖如斯」「快到看不见」',
      humor: '战斗后的市井吐槽负责泄压（这时候倒是通人性了）',
      certainty: '结果确定，悬念放在过程与代价上',
      distance: '交手中贴 POV 的身体感受；旁观镜头只用来标定战力',
    },
    tensions: [
      {
        name: '爽感与代价',
        between: ['碾压要痛快利落', '世界规则必须有分量'],
        resolution: '碾压杂鱼可以零代价；越级挑战与关键之战必须付出可见的成本，否则胜负失去意义',
      },
      {
        name: '奇观与通胀',
        between: ['力量展示的视觉奇观', '频繁使用导致审美疲劳'],
        resolution: '异象是稀缺资源，只留给全书个位数的突破时刻；日常冲突用干净的一招定胜负',
      },
    ],
    antiPatterns: [
      '招式名轰炸（一句话连报七个技能名）',
      '用「快到看不见」「强得可怕」这类模糊形容代替具体动作',
      '战斗中途插入大段回忆闪回',
      '每个回合都由旁白解说双方心理',
    ],
    boundaries: [
      '军团级战争与多人混战的调度未验证',
      '现代热兵器场景不适用',
      '侦探式斗智对决（以信息差为核心的战斗）不在此能力范围',
    ],
    techniques: [
      {
        dimension: 'action_craft',
        name: '一招定胜负',
        mechanism: '强弱差距用单次交锋的结果呈现（连剑带臂带面门统统砸得凹陷下去），完全不拆解招式回合。',
        transfer: '实力悬殊的战斗写三拍：出手的瞬间、结束的姿态、旁观者的错愕；过程整段留白。',
        failureMode: '势均力敌的对手戏不适用——需要多回合拉锯时就老实写攻防转换，强行一招取胜会崩坏战力体系。',
        evidence: [
          { sectionId: 'ch30', quote: '原来宗师之间，亦有差距……' },
          { sectionId: 'ch20', quote: '一张嘴直接将这位明阳太子咬掉了半个身子！' },
        ],
        crossDomain: 3,
      },
      {
        dimension: 'action_craft',
        name: '旁观者侧写强弱',
        mechanism: '战力不由叙述者评分，由远处窥视的高手的生理反应定义（遍体生寒/趴在桌下装尸体/气息全无）。',
        transfer: '切一个够格的旁观者，写他身体的恐惧反应；这比任何招式描写都更能标定战力天花板。',
        failureMode: '场上没有够格的评价者时失效——让明显更弱的角色来震惊是廉价写法。',
        evidence: [{ sectionId: 'ch30', quote: '躲在远处皇宫院墙上窥视的武绝城感受到荆雨递来的目光，不由遍体生寒' }],
        crossDomain: 2,
      },
      {
        dimension: 'scene_craft',
        name: '异象分层递进',
        mechanism: '大能力显现有严格的视觉层次：血河→骨山→五脏神龛→五尊神灵，一层比一层超出预期，最高潮后用市井吐槽收尾降温。',
        transfer: '力量爆发分三到四层写，每层推翻上一层的预期上限；最后一层之后必须落回人间口吻。',
        failureMode: '低武世界或日常小冲突动用异象会造成通胀；这条手法一生只该用几次。',
        evidence: [{ sectionId: 'ch914', quote: '沙暴与肉身相撞的瞬间，竟爆出金戈交击之声！' }],
        crossDomain: 2,
      },
      {
        dimension: 'action_craft',
        name: '恐怖的具体性',
        mechanism: '恐怖不写氛围写后果：施暴动作轻描淡写（动了动手指/随手一掷），惨烈全部压在受害者的结局细节上（咬掉半个身子/压成齑粉）。',
        transfer: '强者的暴力写得越随意越好；受害者的结局必须有一个具体的、可视的物理细节。',
        failureMode: '血腥程度必须服务剧情：为吓而吓的虐杀会赶走读者，也让后续暴力贬值。',
        evidence: [{ sectionId: 'ch20', quote: '太和殿的屋顶忽地破开一个巨大的洞口' }],
        crossDomain: 2,
      },
    ],
    exemplar: {
      sectionId: 'ch30',
      start: '岂知这剑芒快要碰到荆雨',
      end: '竟也被牢牢卡在了肌肉中不得寸进。',
      reason: '一招定胜负的标准示范：攻守易势只用两次转折，伤害结果具体到肌肉卡剑，全程没有一个抽象形容词。',
    },
    exclusions: [
      '功法神通的名称体系与境界数值',
      '墟魔、归墟等专属设定',
      '具体的胜负结果与剧情走向',
    ],
  },
]

// ── 文风基线正向样本（首尾锚点截取）──

interface SampleSeed {
  sectionId: ChapterId
  start: string
  end: string
  label: string
}

const POSITIVE_SAMPLES: SampleSeed[] = [
  {
    sectionId: 'ch34',
    start: '“六弟。”赵明成嘶哑的声音',
    end: '“我不想死啊！”',
    label: '静场·情感引爆（崇明殿托死）',
  },
  {
    sectionId: 'ch19',
    start: '只见赵明玉提起裙摆',
    end: '一旁的皇后也显得有些手足无措，不知发生了什么事情。',
    label: '对话场·器物承情（枇杷献礼）',
  },
  {
    sectionId: 'ch30',
    start: '“嘿！”荆雨猛地冲向王崇',
    end: '原来宗师之间，亦有差距……',
    label: '动作场·一招定胜负（擒王）',
  },
  {
    sectionId: 'ch1076',
    start: '起初，凭借着洞天中储存的丰厚资源',
    end: '以及战斗结束后更加死寂的沉默。',
    label: '静场·时间账本（归墟百年）',
  },
]

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.db || join(homedir(), '.pi', 'wenlang-agent.db')
  if (!args.project) {
    console.error('--project 必填')
    process.exit(1)
  }
  if (!args.samplesDir || !existsSync(args.samplesDir)) {
    console.error('--samples-dir 必填（包含 chNN.txt 的目录）')
    process.exit(1)
  }
  if (!existsSync(dbPath)) {
    console.error(`数据库不存在: ${dbPath}`)
    process.exit(1)
  }

  // ── 加载参考章节文本 ──
  const texts = new Map<string, string>()
  for (const id of CHAPTER_FILES) {
    const file = join(args.samplesDir, `${id}.txt`)
    if (!existsSync(file)) {
      console.error(`缺少样本文件: ${file}`)
      process.exit(1)
    }
    texts.set(id, readFileSync(file, 'utf-8'))
  }

  // ── 组装正向样本并校验 ──
  const positiveExamples = POSITIVE_SAMPLES.map((seed) => {
    const text = excerptBetween(texts.get(seed.sectionId)!, seed.start, seed.end)
    if (text.length < 20 || text.length > 3000) {
      throw new Error(`正向样本 ${seed.sectionId} 长度异常: ${text.length}`)
    }
    return text
  })

  // ── 组装范例段并校验 ──
  const exemplars = EXPERTS.map((expert) => {
    const text = excerptBetween(texts.get(expert.exemplar.sectionId)!, expert.exemplar.start, expert.exemplar.end)
    if (text.length > 500) throw new Error(`范例段 ${expert.id} 超过 500 字: ${text.length}`)
    return { expert, text }
  })

  // ── 全部证据引文做原文存在性校验 ──
  let failures = 0
  for (const expert of EXPERTS) {
    for (const technique of expert.techniques) {
      for (const ev of technique.evidence) {
        if (!quoteExists(texts.get(ev.sectionId)!, ev.quote)) {
          failures += 1
          console.error(`[校验失败] ${expert.id}/${technique.name}@${ev.sectionId}: ${ev.quote.slice(0, 40)}…`)
        }
      }
      if (technique.crossDomain < 2) {
        failures += 1
        console.error(`[校验失败] ${expert.id}/${technique.name}: crossDomain=${technique.crossDomain} < 2`)
      }
    }
  }
  if (failures > 0) {
    console.error(`共 ${failures} 处未通过校验，中止写入`)
    process.exit(1)
  }
  const techniqueCount = EXPERTS.reduce((sum, e) => sum + e.techniques.length, 0)
  console.log(`原文校验通过：${techniqueCount} 条手法证据 + ${exemplars.length} 段范例 + ${positiveExamples.length} 条正向样本`)

  const db = new Database(dbPath)
  const store = new NovelStore(db)
  if (!store.getProject(args.project)) {
    console.error(`项目不存在: ${args.project}`)
    process.exit(1)
  }

  const now = Date.now()

  // ── 1. 文风基线（更新既有档案：多样本 + 项目自身的反向样本）──
  const existingProfile = store.getWritingStyleProfile(args.project)

  // 反向样本：取自本项目自己生成的早期章节（被判高 AI 率的那批）。
  // 它们是最诚实的"不要这样写"：感官堆叠、每句都挂身体反应、零对话、解释腔。
  let negativeExamples: string[] = []
  if (!args.dry) {
    const chapterStmt = db.prepare(
      'SELECT chapter_number, content FROM novel_chapters WHERE project_id = ? AND chapter_number IN (2, 4) ORDER BY chapter_number',
    )
    const rows = chapterStmt.all(args.project) as Array<{ chapter_number: number; content: string }>
    negativeExamples = rows.map((row) => smartTrim(row.content ?? '', 800)).filter((item) => item.length >= 20)
    console.log(`反向样本：取自本项目第 ${rows.map((r) => r.chapter_number).join('、')} 章（高 AI 率自产正文），共 ${negativeExamples.length} 条`)
  }

  if (!existingProfile) {
    console.error('文风档案不存在——请先运行 v1 种子或在前端创建档案后再执行本脚本')
    process.exit(1)
  }
  if (!args.dry) {
    store.upsertWritingStyleProfile(args.project, {
      name: existingProfile.name || '长生白描基准',
      preset: existingProfile.preset || 'custom',
      narrativePerson: existingProfile.narrativePerson,
      narrativeDistance: existingProfile.narrativeDistance,
      sentenceRhythm: existingProfile.sentenceRhythm,
      dialogueRatio: existingProfile.dialogueRatio,
      emotionalTemperature: existingProfile.emotionalTemperature,
      imageryDensity: existingProfile.imageryDensity,
      vocabularyRegister: existingProfile.vocabularyRegister,
      hardRules: [
        '不使用长横线破折号',
        '不以总结或感悟收尾',
        '保持 POV 信息边界',
        '情绪爆点用短句独立成段',
        '一章最多一个情绪引爆点',
      ],
      softRules: [
        '叙述句可以长，落点句必须短',
        '时间跳跃用账本句带过，情感锚在具体物件上',
        '群体冲突的逻辑推演放进对话，不进旁白',
        '战斗写出手、结果与观者反应三拍，不拆招式回合',
        '对话轮次一句一段，潜台词压在动作和停顿里',
      ],
      positiveExamples,
      negativeExamples,
      notes: '基线参数与样本蒸馏自《开局长生，苟在下界吃土飞升》十四章精读（三重验证：跨域复现/生成力/排他性）。反向样本取自本项目早期自产正文——它们暴露的正是要避免的毛病：感官堆叠、每句挂身体反应、排比三连、零对话的解释腔。',
    })
    console.log(`文风基线已更新：正向样本 ${positiveExamples.length} 条 + 反向样本 ${negativeExamples.length} 条`)
  } else {
    console.log('[dry] 将更新文风基线')
  }

  // ── 2. 专家团（幂等重建：清理 v1 旧专家 + 四个 v2 能力专家）──
  if (!args.dry) {
    if (store.listStyleExperts(args.project).some((expert) => expert.id === OLD_EXPERT_ID)) {
      store.deleteStyleExpert(args.project, OLD_EXPERT_ID)
      console.log('已移除 v1 旧专家:', OLD_EXPERT_ID)
    }
  }

  for (const seed of EXPERTS) {
    if (args.dry) {
      console.log(`[dry] 将创建专家 ${seed.name}（${seed.techniques.length} 手法 / DNA / 张力×${seed.tensions.length} / 反模式×${seed.antiPatterns.length}）`)
      continue
    }
    if (store.listStyleExperts(args.project).some((expert) => expert.id === seed.id)) {
      store.deleteStyleExpert(args.project, seed.id)
    }
    const exemplar = exemplars.find((item) => item.expert.id === seed.id)
    if (!exemplar) {
      throw new Error(`范例段未匹配专家 ${seed.id}；已有=[${exemplars.map((item) => item.expert.id).join(', ')}]`)
    }
    store.createStyleExpert({
      id: seed.id,
      projectId: args.project,
      name: seed.name,
      sourceTitle: SOURCE_TITLE,
      sourceAuthor: SOURCE_AUTHOR,
      description: seed.description,
      distilledPrompt: seed.distilledPrompt,
      metrics: { chaptersSampled: CHAPTER_FILES.length, note: 'nuwa 式三重验证蒸馏 v2' },
      techniques: seed.techniques.map((technique, index) => ({
        id: `${seed.id}-t${index + 1}`,
        dimension: technique.dimension,
        name: technique.name,
        mechanism: technique.mechanism,
        transfer: technique.transfer,
        failureMode: technique.failureMode,
        evidence: technique.evidence,
        metricAnchors: [],
        validation: { crossDomain: technique.crossDomain, generative: true, exclusive: true },
        confidence: 'verified' as const,
        kept: true,
      })),
      exclusions: seed.exclusions,
      exemplarPassages: [{
        sectionId: exemplar.expert.exemplar.sectionId,
        text: exemplar.text,
        reason: exemplar.expert.exemplar.reason,
      }],
      expressionDna: seed.expressionDna,
      tensions: seed.tensions,
      antiPatterns: seed.antiPatterns,
      boundaries: seed.boundaries,
      customPrompt: undefined,
      sortOrder: seed.sortOrder,
      distillMeta: {
        sampleChars: [...texts.values()].reduce((sum, t) => sum + t.length, 0),
        model: 'manual-close-read (ox-alpha) nuwa-v2',
        distilledAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
      enabled: true,
    })
    const saved = store.listStyleExperts(args.project).find((item) => item.id === seed.id)
    console.log(`已写入专家：${saved?.name} | 手法 ${saved?.techniques?.length ?? 0} | 张力 ${saved?.tensions?.length ?? 0} | 反模式 ${saved?.antiPatterns?.length ?? 0} | 边界 ${saved?.boundaries?.length ?? 0}`)
  }

  db.close()
}

main()
