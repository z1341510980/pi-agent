/**
 * 角色声音坐标系（治理"所有角色像同一个人"）。
 *
 * ## 问题
 *
 * 角色档案里的 `speechStyle` 是一段自由文本（"沉稳克制，用词简练"）。
 * 自由文本对 LLM 是**软提示**：三个角色的描述都写着"简练""克制""理性"时，
 * 模型没有任何可判定的差异可依，于是所有人的台词都变成同一把嗓子 ——
 * 完整、准确、功能明确的"问答接口"。
 *
 * 只加"不要让角色趋同"这类禁令没有用：禁令描述的是结果，不是可执行的差异。
 *
 * ## 做法
 *
 * 把说话方式拆成**三条互相独立、可判定的轴** + 口头禅 + 禁用词：
 *
 * | 轴 | 取值 | 判定方式 |
 * | --- | --- | --- |
 * | 句长 | clipped / medium / winding | 台词平均字数 |
 * | 语域 | blunt / official / technical / folksy / literary | 标记词 |
 * | 回答方式 | direct / deflect / withhold / overflow | 是否直答、是否反问 |
 *
 * 轴优先从角色档案里读；读不到的轴按角色 id 做**确定性**分配（同一角色每章一致），
 * 并保证同场角色的三轴组合互不相同 —— 这是"读者仅凭台词能分辨是谁"的下限。
 *
 * 分配结果同时用于两处，形成闭环：
 * 1. `formatVoiceContrastTable` 注入 Writer，把差异写成可执行指令；
 * 2. `detectVoiceCollapse` 在正文生成后按台词实测，趋同则触发修订。
 *
 * 本模块是纯函数，不读数据库、不调 LLM。
 */

import type { NovelCharacter } from './types.js'

export type SentenceLengthAxis = 'clipped' | 'medium' | 'winding'
export type RegisterAxis = 'blunt' | 'official' | 'technical' | 'folksy' | 'literary'
export type AnswerModeAxis = 'direct' | 'deflect' | 'withhold' | 'overflow'

export interface CharacterVoiceProfile {
  characterId: string
  name: string
  sentenceLength: SentenceLengthAxis
  register: RegisterAxis
  answerMode: AnswerModeAxis
  /** 口头禅 / 语气词，最多 2 个 */
  tics: string[]
  /** 该角色不该使用的词（来自同场其他角色的语域标记） */
  banned: string[]
  /** 各轴是从档案读出的（true）还是系统分配的（false） */
  fromProfile: {
    sentenceLength: boolean
    register: boolean
    answerMode: boolean
  }
}

/** 句长轴的可执行描述：给出字数区间，不只给形容词 */
export const SENTENCE_LENGTH_LABELS: Record<SentenceLengthAxis, string> = {
  clipped: '短句为主，单句台词多在 12 字以内，能省的主语和修饰全省',
  medium: '中等句长，单句台词多在 12-28 字，一句话说完一个判断',
  winding: '长句为主，单句台词常超过 28 字，习惯带条件、让步和补充说明',
}

/** 语域轴：每档给出标记词，Writer 可直接照着选词 */
export const REGISTER_LABELS: Record<RegisterAxis, string> = {
  blunt: '粗直口语，说人话不说场面话，允许脏字替代词、反问和不客气的祈使句',
  official: '公务腔，用"按规定/需要报备/暂时不便说明"这类限定语，回避第一人称承诺',
  technical: '术语腔，用自己专业里的词打比方（模块、参数、误差、复现），对精度敏感',
  folksy: '乡土口语，用日常生活里的东西打比方（庄稼、牲口、饭食、天气），少用抽象名词',
  literary: '书面语，句子完整、用词考究，习惯引古语或成句',
}

/** 回答方式轴：决定对白是"问答接口"还是真实交锋 */
export const ANSWER_MODE_LABELS: Record<AnswerModeAxis, string> = {
  direct: '直答：先给结论再补理由，被追问时不闪躲',
  deflect: '反问式：用反问、追问或换话题挡回去，很少正面回答第一次提问',
  withhold: '保留式：只答被问到的那一点，知道更多也不主动说，常用"暂时""目前"限定',
  overflow: '溢出式：答完还会多说一截无关的，主动补充别人没问的细节',
}

/** 语域标记词：既用于从档案反推语域，也用于生成其他角色的禁用词 */
const REGISTER_MARKERS: Record<RegisterAxis, string[]> = {
  blunt: ['扯', '滚', '废话', '你他'],
  official: ['按规定', '需要报备', '不便说明', '上级', '流程'],
  technical: ['参数', '模块', '误差', '复现', '数据'],
  folksy: ['庄稼', '牲口', '锅里', '天上', '日头'],
  literary: ['所谓', '譬如', '不外乎', '之于'],
}

/**
 * 从档案文本反推各轴的关键词表（命中即认为档案已声明该轴）。
 *
 * 关键词必须能抗否定式表述。裸写 `绕` 会让"从不绕弯子"被判成 winding ——
 * 恰好反了。所以这里只收**肯定形态**的短语。
 */
const SENTENCE_LENGTH_HINTS: Record<SentenceLengthAxis, RegExp> = {
  clipped: /短句|简练|简洁|惜字|干脆|利落|少言|寡言|直接了当|一针见血/,
  winding: /长句|冗长|绕来绕去|说话绕|爱绕|铺陈|啰嗦|滔滔|引经据典|层层/,
  medium: /长短句|语速中等|平实|平稳|中性/,
}

const REGISTER_HINTS: Record<RegisterAxis, RegExp> = {
  blunt: /粗鲁|直白|不客气|市井|骂|野/,
  official: /公务|官腔|体制|外交|措辞严谨|滴水不漏|用词规范|程序/,
  technical: /术语|专业术语|工程|技术|程序员|精确|数据/,
  folksy: /乡土|土话|方言|朴实|庄稼|接地气/,
  literary: /文雅|书面|古雅|典雅|文人|雅致/,
}


const ANSWER_MODE_HINTS: Record<AnswerModeAxis, RegExp> = {
  deflect: /反问|回避|绕开|不正面|打太极|试探/,
  withhold: /保留|藏|隐瞒|不肯说|留一手|守口/,
  overflow: /话多|絮|唠|说不停|爱解释|补充/,
  direct: /直答|直言|坦率|有话直说|不藏/,
}

/** 展开档案字段：结构化 JSON 与自由文本都归一成一段可正则匹配的文本 */
function flattenDetail(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed))
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/**
 * 各轴的取值来源刻意分开：
 *
 * - 句长、语域只看 `speechStyle`。曾把 `personality` 也算进来，结果"理性主义者"
 *   "专业权威"这类**性格**描述全部命中 technical，三个角色的语域一起塌成术语腔，
 *   而且因为被判定为"档案已声明"，撞车避让逻辑也不敢改它 —— 比不分配更糟。
 * - 回答方式看两者：是否回避、是否话多既属说话方式也属性格。
 */
function readVoiceSourceText(character: NovelCharacter): { speech: string; combined: string } {
  const speech = flattenDetail(character.speechStyle)
  return { speech, combined: `${speech} ${flattenDetail(character.personality)}` }
}


/**
 * 确定性 hash：同一角色在任何一章都得到同一把嗓子。
 *
 * 用随机数会让角色每章换一种说话方式，比趋同更糟。
 */
function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash)
}

function matchAxis<T extends string>(text: string, hints: Record<T, RegExp>, order: T[]): T | null {
  for (const key of order) {
    if (hints[key].test(text)) return key
  }
  return null
}

/**
 * 从档案里抽口头禅。
 *
 * 只在**自由文本**档案上做引号匹配。speechStyle 常是结构化 JSON，
 * 对 JSON 做引号匹配会把键名（"基调"、"特点"）当成口头禅注入 prompt ——
 * 模型于是让所有角色把"基调"挂在嘴边。
 */
function extractTics(character: NovelCharacter): string[] {
  const raw = (character.speechStyle ?? '').trim()
  const tics: string[] = []
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const value = parsed['口头禅'] ?? parsed['语气词'] ?? parsed['tics']
      if (typeof value === 'string') tics.push(...value.split(/[、,，;；\s]+/))
      else if (Array.isArray(value)) {
        tics.push(...value.filter((item): item is string => typeof item === 'string'))
      }
      // JSON 解析成功即以键取值为准，不再回退到引号匹配
      return tics.map((tic) => tic.trim()).filter(Boolean).slice(0, 2)
    } catch {
      // 解析失败按自由文本处理
    }
  }
  for (const match of raw.matchAll(/["“「']([^"”」'\n]{1,6})["”」']/g)) {
    if (match[1]) tics.push(match[1])
  }
  return tics.map((tic) => tic.trim()).filter(Boolean).slice(0, 2)
}


const SENTENCE_LENGTH_ORDER: SentenceLengthAxis[] = ['clipped', 'winding', 'medium']
const REGISTER_ORDER: RegisterAxis[] = ['technical', 'official', 'folksy', 'blunt', 'literary']
const ANSWER_MODE_ORDER: AnswerModeAxis[] = ['deflect', 'withhold', 'overflow', 'direct']

/** 主角默认给 direct：主角长期回避会让读者跟不住动机 */
function defaultAnswerModeFor(character: NovelCharacter, seed: number): AnswerModeAxis {
  if (character.isProtagonist || character.plotRole === 'protagonist') return 'direct'
  return ANSWER_MODE_ORDER[seed % ANSWER_MODE_ORDER.length]
}

/**
 * 为同场角色分配声音坐标。
 *
 * 分配顺序很重要：**先落档案已声明的轴**（这些不能被改写），再给剩下的角色分配，
 * 且分配时避开已占用的组合。否则"按 hash 分配"可能正好和档案角色撞在一起，
 * 等于没有分配。
 */
export function buildVoiceProfiles(characters: readonly NovelCharacter[]): CharacterVoiceProfile[] {
  const profiles: CharacterVoiceProfile[] = []
  const usedCombos = new Set<string>()
  // 语域单独记账：它决定选词与比喻来源，是三轴里最影响"能否分辨"的一条。
  // 只查三轴组合唯一性会让两个角色都拿到术语腔（组合仍不同），读起来还是一个人。
  const usedRegisters = new Set<RegisterAxis>()
  const comboKey = (profile: Pick<CharacterVoiceProfile, 'sentenceLength' | 'register' | 'answerMode'>): string =>
    `${profile.sentenceLength}|${profile.register}|${profile.answerMode}`


  const drafts = characters.map((character) => {
    const { speech, combined } = readVoiceSourceText(character)
    return {
      character,
      seed: stableHash(character.id || character.name),
      sentenceLength: matchAxis(speech, SENTENCE_LENGTH_HINTS, SENTENCE_LENGTH_ORDER),
      register: matchAxis(speech, REGISTER_HINTS, REGISTER_ORDER),
      answerMode: matchAxis(combined, ANSWER_MODE_HINTS, ANSWER_MODE_ORDER),
    }
  })


  // 落位顺序 = 谁的语域最该被保住。
  //
  // 只按"档案声明的轴数"排序会出问题：主角档案里若只有语域一条命中，
  // 就会排在配角后面，被避让逻辑挤走 —— 实测让程序员主角拿到了"乡土口语"。
  // 笔墨最重的角色先落位：他的声音贯穿全书，配角让位的代价小得多。
  const plotRoleWeight: Record<NovelCharacter['plotRole'], number> = {
    protagonist: 4,
    main_opponent: 3,
    supporting: 2,
    function: 1,
    background: 0,
  }
  const declaredCount = (draft: typeof drafts[number]): number =>
    (draft.sentenceLength ? 1 : 0) + (draft.register ? 1 : 0) + (draft.answerMode ? 1 : 0)
  const priority = (draft: typeof drafts[number]): number => {
    const role = draft.character.isProtagonist
      ? 4
      : (plotRoleWeight[draft.character.plotRole] ?? 1)
    return role * 10 + declaredCount(draft)
  }
  const ordered = [...drafts].sort((a, b) => priority(b) - priority(a))


  for (const draft of ordered) {
    const { character, seed } = draft
    let sentenceLength = draft.sentenceLength
      ?? SENTENCE_LENGTH_ORDER[seed % SENTENCE_LENGTH_ORDER.length]
    let register = draft.register ?? REGISTER_ORDER[seed % REGISTER_ORDER.length]
    let answerMode = draft.answerMode ?? defaultAnswerModeFor(character, seed)

    // 语域先避让。
    //
    // 这里**不区分**语域是从档案关键词反推的还是系统分配的：反推本身是启发式
    // （"用词精确""报数字"都会命中 technical），而 fixture 里两个角色正是这样一起
    // 塌成术语腔的。区分度的价值高于一次关键词猜测，因此按已声明轴数从多到少的顺序
    // 处理，让描述最具体的角色保住它的语域，后来者让位。
    for (let step = 0; step < REGISTER_ORDER.length && usedRegisters.has(register); step += 1) {
      register = REGISTER_ORDER[(seed + step + 1) % REGISTER_ORDER.length]
    }

    // 组合仍撞车时只调整**系统分配**的轴，档案声明的轴不动
    let attempt = 0
    while (usedCombos.has(comboKey({ sentenceLength, register, answerMode })) && attempt < 24) {
      attempt += 1
      if (!draft.sentenceLength) {
        sentenceLength = SENTENCE_LENGTH_ORDER[(seed + attempt) % SENTENCE_LENGTH_ORDER.length]
      } else if (!draft.answerMode) {
        answerMode = ANSWER_MODE_ORDER[(seed + attempt) % ANSWER_MODE_ORDER.length]
      } else if (!draft.register) {
        register = REGISTER_ORDER[(seed + attempt) % REGISTER_ORDER.length]
      } else {
        // 三轴全部来自档案：档案本身让两个角色同声，交给 Writer 用口头禅区分
        break
      }
    }
    usedCombos.add(comboKey({ sentenceLength, register, answerMode }))
    usedRegisters.add(register)


    profiles.push({
      characterId: character.id,
      name: character.name,
      sentenceLength,
      register,
      answerMode,
      tics: extractTics(character),
      banned: [],
      fromProfile: {
        sentenceLength: draft.sentenceLength != null,
        // 语域可能因避让被改掉，此处记录**最终**是否仍与档案一致，
        // 否则调用方会以为这条是用户声明的而不敢调整。
        register: draft.register != null && draft.register === register,
        answerMode: draft.answerMode != null,
      },

    })
  }

  // 禁用词：把同场其他角色的语域标记列为本角色不该用的词。
  // 这是"语域"从形容词变成可检查约束的关键一步。
  for (const profile of profiles) {
    const others = profiles.filter((other) => other.characterId !== profile.characterId)
    const banned = new Set<string>()
    for (const other of others) {
      if (other.register === profile.register) continue
      for (const marker of REGISTER_MARKERS[other.register].slice(0, 2)) banned.add(marker)
    }
    profile.banned = [...banned].slice(0, 4)
  }

  // 恢复入参顺序，便于与角色短卡逐行对齐
  const indexOf = new Map(characters.map((character, index) => [character.id, index]))
  return profiles.sort((a, b) => (indexOf.get(a.characterId) ?? 0) - (indexOf.get(b.characterId) ?? 0))
}

/**
 * 声音对照表：**横向**列出同场角色的差异。
 *
 * 为什么不写进角色短卡：短卡是纵向的，模型逐个读完三张卡后并不会自动去比较；
 * 横向排在一起，差异本身成为指令。
 */
export function formatVoiceContrastTable(profiles: readonly CharacterVoiceProfile[]): string {
  if (profiles.length === 0) return ''
  const lines: string[] = ['### 角色声音对照表（同场必须听得出区别）']
  for (const profile of profiles) {
    const parts = [
      `- **${profile.name}**`,
      `  句长：${SENTENCE_LENGTH_LABELS[profile.sentenceLength]}`,
      `  语域：${REGISTER_LABELS[profile.register]}`,
      `  被追问时：${ANSWER_MODE_LABELS[profile.answerMode]}`,
    ]
    if (profile.tics.length > 0) parts.push(`  口头禅：${profile.tics.join('、')}（自然出现，不要每句都挂）`)
    if (profile.banned.length > 0) parts.push(`  不要让他说：${profile.banned.join('、')}`)
    lines.push(parts.join('\n'))
  }
  if (profiles.length > 1) {
    lines.push(
      '',
      '检验方式：把本章任意两个角色的台词互换，如果读起来同样通顺，这段对话就是写失败的，重写它。',
      '同一场对话里不要让每个人都完整、准确、按顺序回答。至少有一个人答不到点上、只答一半或先反问回去。',
    )
  }
  return lines.join('\n')
}

/** 台词提取：只取成对引号内的内容，避免把叙述当台词 */
const DIALOGUE_PATTERN = /[“「『"]([^”」』"\n]{1,300})[”」』"]/g

export interface VoiceCollapseReport {
  /** 台词条数 */
  dialogueCount: number
  /** 台词平均字数 */
  averageLength: number
  /** 台词长度标准差：越小说明所有人说话节奏越像 */
  lengthDeviation: number
  /** 以句末标点收尾的完整句台词占比 */
  completeSentenceRatio: number
  /** 反问、未答、只答一半的台词占比 */
  evasiveRatio: number
  /** 命中的问题码 */
  issues: Array<{ code: 'voice_uniform_length' | 'voice_all_complete' | 'voice_no_friction'; message: string }>
}

/**
 * 对白趋同的确定性检测。
 *
 * 三个指标都不判断"写得好不好"，只判断**结构上是否可能区分角色**：
 *
 * 1. `voice_uniform_length`：所有台词长度高度一致 —— 不同人物的语速一样。
 * 2. `voice_all_complete`：几乎每句台词都是完整句 —— 现实对话里有半句、有被打断。
 * 3. `voice_no_friction`：没有反问、没有回避、没有未答 —— 对白退化成问答接口。
 *
 * 阈值刻意保守：这几项都可能因为场景性质（如正式汇报）而合理偏高，
 * 因此最强动作只到 revise，不整章重写。
 */
export function detectVoiceCollapse(content: string): VoiceCollapseReport {
  const dialogues = [...content.matchAll(DIALOGUE_PATTERN)]
    .map((match) => (match[1] ?? '').trim())
    .filter((text) => text.length > 0)
  const empty: VoiceCollapseReport = {
    dialogueCount: dialogues.length,
    averageLength: 0,
    lengthDeviation: 0,
    completeSentenceRatio: 0,
    evasiveRatio: 0,
    issues: [],
  }
  // 台词太少时比例没有意义（章节可能本来就是独处场景）
  if (dialogues.length < 8) return empty

  const lengths = dialogues.map((text) => text.replace(/\s/g, '').length)
  const average = lengths.reduce((sum, value) => sum + value, 0) / lengths.length
  const variance = lengths.reduce((sum, value) => sum + (value - average) ** 2, 0) / lengths.length
  const deviation = Math.sqrt(variance)
  const completeCount = dialogues.filter((text) => /[。！？!?]$/.test(text)).length
  // 反问 / 回避 / 半句：任一即算"有摩擦"
  const evasiveCount = dialogues.filter((text) => (
    /[？?]$/.test(text)
    || /^(?:那|可|但|不是|谁|凭什么|你说呢|什么)/.test(text)
    || /(?:再说|以后再|不知道|不清楚|没法说|不便|回头)/.test(text)
    || !/[。！？!?]$/.test(text)
  )).length

  const report: VoiceCollapseReport = {
    dialogueCount: dialogues.length,
    averageLength: Math.round(average * 10) / 10,
    lengthDeviation: Math.round(deviation * 10) / 10,
    completeSentenceRatio: Math.round((completeCount / dialogues.length) * 1000) / 10,
    evasiveRatio: Math.round((evasiveCount / dialogues.length) * 1000) / 10,
    issues: [],
  }
  // 标准差低于均值的 35% 说明长度高度集中
  if (average >= 6 && deviation / average < 0.35) {
    report.issues.push({
      code: 'voice_uniform_length',
      message: `台词长度高度一致（均值 ${report.averageLength} 字，标准差 ${report.lengthDeviation}），角色语速没有差别`,
    })
  }
  if (completeCount / dialogues.length >= 0.9) {
    report.issues.push({
      code: 'voice_all_complete',
      message: `${report.completeSentenceRatio}% 的台词都是完整句收尾，缺少半句、被打断和答不完的话`,
    })
  }
  if (evasiveCount / dialogues.length < 0.15) {
    report.issues.push({
      code: 'voice_no_friction',
      message: `只有 ${report.evasiveRatio}% 的台词存在反问、回避或未答，对白呈问答接口形态`,
    })
  }
  return report
}




