/**
 * Novel 提示词 / 编排重构护栏用的固定项目状态。
 *
 * 用途：Golden 快照测试的输入。重构 prompt-builder / entity-generator 的结构时，
 * 快照 diff 必须为空；只有刻意的行为变更才允许更新快照，并在 PR 里逐条说明。
 *
 * 要求：
 * - 所有 ID、时间戳、文本必须是确定值，不能用 randomUUID / Date.now，否则快照不稳定。
 * - 覆盖面尽量贴近真实项目：多角色（含结构化 JSON 性格）、跨章冲突、带 beats 的伏笔、
 *   势力/地点/物品/线索、已写正文的前置章节、文风档案、账本记录。
 */
import Database from 'better-sqlite3'
import { NovelStore } from '../../core/novel-store.js'
import { NovelMemoryStore } from '../../core/novel-memory-store.js'
import { novelMigrations } from '../../novel-migrations.js'
import type { ArrangedEntity, ChapterConstraints, NarrativeTask } from '../../core/types.js'

export const FIXTURE_PROJECT_ID = 'fixture-project-0000-0000-000000000001'

export const FIXTURE_IDS = {
  volume: 'fx-volume-1',
  protagonist: 'fx-char-protagonist',
  ally: 'fx-char-ally',
  scientist: 'fx-char-scientist',
  conflictMain: 'fx-conflict-main',
  conflictSurvival: 'fx-conflict-survival',
  foreshadowPlanted: 'fx-foreshadow-planted',
  foreshadowFresh: 'fx-foreshadow-fresh',
  clue: 'fx-clue-1',
  faction: 'fx-faction-1',
  location: 'fx-location-1',
  item: 'fx-item-1',
} as const

/** 目标章节：前 3 章已有正文，第 4 章待写 */
export const FIXTURE_TARGET_CHAPTER = 4

const PERSONALITY_JSON = JSON.stringify({
  核心: '温和的理性主义者',
  优点: ['遇事先拆解成子问题', '情绪稳定，极少失控', '韧性极强，愿意反复重试'],
  缺点: ['过度分析，该凭直觉时仍在权衡', '缺乏热血，不易让人追随', '认定方案后很难被情感说服'],
  '座右铭（内心独白）': '一切异常都是可复现的问题。',
})

const SPEECH_STYLE_JSON = JSON.stringify({
  基调: '平静、有条理、偶尔带点冷幽默',
  特点: ['节奏偏慢', '用词精确', '不擅寒暄，开口往往是提问'],
  典型句式示例: ['让我拆解一下这个问题。', '我的结论是……但数据还不够。', '别急，先复现一下现场。'],
})

/** 每章正文：含中文弯引号对话 + 叙述段，长度足以让文风指纹达到可信阈值 */
function chapterContent(chapterNumber: number): string {
  const blocks: string[] = []
  for (let i = 0; i < 18; i += 1) {
    blocks.push(`\u201c第${chapterNumber}章第${i}句话，说得很清楚。\u201d`)
    blocks.push(`他把灯放回桌上，动作很稳，没有多余的话。这一段是叙述，用来撑起段落平均长度与总字数，让文风指纹达到可信样本量。`)
  }
  return blocks.join('\n\n')
}

export interface NovelFixture {
  db: Database.Database
  store: NovelStore
  memoryStore: NovelMemoryStore
  projectId: string
  /** 目标章节的叙事任务（Director 已批准的形态） */
  narrativeTask: NarrativeTask
  /** 目标章节的约束（由 store 数据推导，此处给出稳定的手工值） */
  constraints: ChapterConstraints
  /** 完整编排实体（含 itemIds / characterFunctions，用于校验字段不丢） */
  arrangedEntities: ArrangedEntity
  close(): void
}

export function createNovelFixture(): NovelFixture {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)

  const store = new NovelStore(db)
  const memoryStore = new NovelMemoryStore(db)
  const projectId = FIXTURE_PROJECT_ID

  store.createProject({
    id: projectId,
    title: '双界工程',
    genre: '科幻修真',
    synopsis: '一个带着工程思维的普通人在两个互为镜像的世界之间建立通道。',
    outline: '第一卷：主角在修真界求生，同时与蓝星建立稳定通讯。',
    targetWords: 3000,
    currentVolume: 1,
    currentChapter: FIXTURE_TARGET_CHAPTER - 1,
    currentStage: 'setup',
    status: 'active',
  })

  store.createVolume({
    id: FIXTURE_IDS.volume,
    projectId,
    volumeNumber: 1,
    title: '第一卷',
    outline: '本卷主线：通讯建立与身份保密之间的持续张力。',
    sortOrder: 1,
  })

  // ── 角色 ──
  store.createCharacter({
    id: FIXTURE_IDS.protagonist,
    projectId,
    name: '叶明远',
    description: '带着工程思维穿越的普通人，不靠血统不靠奇遇。',
    identity: '青云宗外门弟子，无灵根，靠自身摸索修炼。',
    personality: PERSONALITY_JSON,
    appearance: '瘦高，习惯把袖子卷到小臂。',
    currentState: '连续六天白日采石，夜里配合蓝星做低输入节点测试，已建立前六处节点的稳定顺序。',
    currentGoal: '在外门考核前稳住异常节点联动，同时通过考核。',
    currentPressure: '第七处节点在最低刺激下失控牵引，而考核已在次日到来。',
    secret: '玉佩是两界通道钥匙。',
    arcStage: 'rising',
    arcHistory: '[]',
    speechStyle: SPEECH_STYLE_JSON,
    isProtagonist: true,
    longTermDesire: '把整个修炼体系拆解成可复现、可验证的工程问题。',
    plotRole: 'protagonist',
    removalImpact: '主线直接终止。',
  })

  store.createCharacter({
    id: FIXTURE_IDS.ally,
    projectId,
    name: '小张',
    description: '蓝星年轻民警，理性务实。',
    identity: '基层公安民警，入职三年，缺乏大案经验。',
    personality: JSON.stringify({
      核心: '用常识解释一切的理性主义者',
      优点: ['遇事冷静', '有职业责任感'],
      缺点: ['过于依赖经验判断', '想象力不足'],
    }),
    appearance: '制服笔挺。',
    currentState: '已确认对方身份信息真实无误，从"恶作剧"转为困惑与强烈不安。',
    currentGoal: '等待上级进一步指示，把事件按程序上报。',
    currentPressure: '事件完全超出职业经验，需要快速消化并维持专业判断。',
    secret: '',
    arcStage: 'rising',
    arcHistory: '[]',
    speechStyle: JSON.stringify({
      基调: '语速中等偏快，用词规范职业',
      特点: ['习惯用"先生/女士"称呼对方', '质疑时语气平稳但带压迫'],
      典型句式示例: ['你知道报假警要承担什么后果吗。', '请你配合，把情况再说一遍。'],
    }),
    isProtagonist: false,
    longTermDesire: '平安做完本职工作，别摊上无法解释的大事。',
    plotRole: 'supporting',
    removalImpact: '蓝星侧的程序化推进失去锚点。',
  })

  store.createCharacter({
    id: FIXTURE_IDS.scientist,
    projectId,
    name: '沈维章',
    description: '中科院资深院士，专攻空间物理。',
    identity: '国防科工首席技术顾问，七十一岁。',
    personality: JSON.stringify({
      核心: '严谨到苛刻，尊重数据胜过一切',
      优点: ['专业权威无可置疑', '结论经得起复验'],
      缺点: ['过于直白，缺乏政治敏感性'],
    }),
    appearance: '白发，常年穿旧夹克。',
    currentState: '已带领蓝星侧完成四十二轮分段记录测试，确认前六处节点顺序可复现。',
    currentGoal: '在不诱发进一步失控的前提下确认第七处的真实结构与风险边界。',
    currentPressure: '异常联动已超出既有模型，且缺乏足够时间做更安全的验证。',
    secret: '',
    arcStage: 'rising',
    arcHistory: '[]',
    speechStyle: JSON.stringify({
      基调: '一针见血，从不绕弯子',
      特点: ['每句话之间习惯停顿两三秒', '引用数据时闭着眼报数字'],
      典型句式示例: ['这不是普通反应。', '继续切断。不要对抗，不要加任何输入。'],
    }),
    isProtagonist: false,
    longTermDesire: '在有生之年搞清楚这个宇宙到底有几层。',
    plotRole: 'function',
    removalImpact: '科学侧判断失去权威来源。',
  })

  store.createRelationship({
    id: 'fx-rel-1',
    projectId,
    characterA: FIXTURE_IDS.protagonist,
    characterB: FIXTURE_IDS.scientist,
    relationType: '盟友',
    currentStage: '互为唯一可验证的信息源',
    stageHistory: '[]',
    dynamicRole: '为主角提供科学侧的验证能力与判断权威',
    alignment: 'ally',
    trend: 'warming',
    chapterHint: '本章因旧模型被推翻而加深依赖',
    lastUpdatedChapter: 3,
  })

  // ── 冲突：一条跨章主线 + 一条本章升级的生存线 ──
  store.createConflict({
    id: FIXTURE_IDS.conflictMain,
    projectId,
    description: '蓝星科学分析发现修炼功法的七处关键节点在蓝星人体解剖上不存在，对修炼体系的可移植性构成根本性质疑。',
    type: 'world_rule',
    intensity: 8,
    stage: 'erupting',
    participants: JSON.stringify([FIXTURE_IDS.protagonist, FIXTURE_IDS.scientist]),
    chapterSpans: [[2, 3]],
    tier: 'main',
    climaxChapter: 12,
    climaxType: 'theme',
    stakes: '主角的修炼合法性与两界协作的基础。',
    twistPotential: 8,
    plotFunction: 'reveal_world_rule',
    progressionMode: 'linear',
    currentStep: '已确认七处节点无对应实体，但顺序可稳定复现。',
    nextStep: '验证节点结构是否独立于既有经络体系。',
  })

  store.createConflict({
    id: FIXTURE_IDS.conflictSurvival,
    projectId,
    description: '主角必须在异常失控风险与放弃外门考核所带来的现实后果之间做出选择。',
    type: 'survival',
    intensity: 6,
    stage: 'escalating',
    participants: JSON.stringify([FIXTURE_IDS.protagonist]),
    chapterSpans: [[3, 3]],
    tier: 'secondary',
    climaxChapter: null,
    climaxType: null,
    stakes: '失去宗门庇护即暴露于外部猎杀。',
    twistPotential: 5,
    plotFunction: 'amplify_conflict',
    progressionMode: 'linear',
    currentStep: '风险已显现但尚未迫使决断。',
    nextStep: '迫使主角在本章给出明确的风险边界。',
  })

  // ── 伏笔：一条已埋设（复用场景）+ 一条本章新埋 ──
  store.createForeshadow({
    id: FIXTURE_IDS.foreshadowPlanted,
    projectId,
    description: '主角体内第七处深层节点在最低刺激下自行牵动前六点，形成完整图形。',
    category: 'secret',
    status: 'planted',
    firstChapter: 3,
    lastChapter: 3,
    // 注意：recoverByChapter 非空时 store 会合成 payoff beat，进而把状态派生为 recovered。
    // fixture 要的是“已埋设、未回收”的常见态，所以置 null。
    recoverByChapter: null,
    plantMethod: 'implicit',
    recoverMethod: 'progressive',
    chapterSpans: [],
    beats: [{ chapter: 3, type: 'plant', note: '首次出现自发联动' }],
  })

  store.createForeshadow({
    id: FIXTURE_IDS.foreshadowFresh,
    projectId,
    description: '旧藏残卷中的七枢内照图与主角体内节点结构高度一致，但性质既非行气图也非通道图。',
    category: 'item',
    status: 'planted',
    firstChapter: FIXTURE_TARGET_CHAPTER,
    lastChapter: FIXTURE_TARGET_CHAPTER,
    recoverByChapter: null,
    plantMethod: 'explicit',
    recoverMethod: 'explicit',
    chapterSpans: [],
    beats: [{ chapter: FIXTURE_TARGET_CHAPTER, type: 'plant', note: '古图与节点图对应' }],
  })

  store.createClue({
    id: FIXTURE_IDS.clue,
    projectId,
    description: '主角体内七点在第七处主动内收时会形成固定顺序与连线结构。',
    pointsTo: '第七处与前六点构成一种独立于既有经络体系的真实结构。',
    isMisleading: false,
    chapterSpans: [[3, 6]],
    progress: 45,
    currentStep: '已记录节点顺序、位置与图案。',
    nextStep: '只观察自发联动时的顺序与延迟，验证结构是否稳定复现。',
  })

  store.createFaction({
    id: FIXTURE_IDS.faction,
    projectId,
    name: '国安总局',
    description: '蓝星侧主导该事件的机构。',
    type: 'organization',
    leaderId: null,
    ideology: '秩序优先，风险可控。',
    strength: 'strong',
    resources: ['指挥体系', '科研力量'],
    allies: [],
    enemies: [],
    status: 'active',
    chapterSpans: [[2, 3]],
  })

  store.createLocation({
    id: FIXTURE_IDS.location,
    projectId,
    name: '潼关杂役坑',
    description: '大阵外围的采石杂役坑，昏暗压抑。',
    type: 'dungeon',
    parentId: null,
    factionId: null,
    significance: 'major',
    firstChapter: 1,
    status: 'normal',
    appearChapters: [1, 2, 3],
  })

  store.createItem({
    id: FIXTURE_IDS.item,
    projectId,
    name: '鱼环形玉佩',
    description: '成对的玉佩，分处两界。',
    type: 'artifact',
    ownerId: FIXTURE_IDS.protagonist,
    status: 'active',
    abilities: '在两界之间建立语音通讯。',
    origin: '穿越时随身触碰之物。',
    firstChapter: 1,
    chapterSpans: [[1, 3]],
  })

  // ── 章节：前 3 章已写，第 4 章待写 ──
  for (let n = 1; n <= FIXTURE_TARGET_CHAPTER; n += 1) {
    const written = n < FIXTURE_TARGET_CHAPTER
    store.createChapter({
      id: `fx-chapter-${n}`,
      projectId,
      volume: 1,
      chapterNumber: n,
      title: `第${n}章`,
      content: written ? chapterContent(n) : '',
      wordCount: written ? 900 : 0,
      status: written ? 'published' : 'planned',
      narrativeTask: '',
      outline: written ? `第${n}章章纲。` : '主角记录异常节点顺序，蓝星侧找到对应古图。',
      volumeId: FIXTURE_IDS.volume,
      acceptanceResult: null,
    })
  }

  // ── 文风档案 ──
  store.upsertWritingStyleProfile(projectId, {
    name: '冷峻工程视角',
    preset: 'custom',
    narrativePerson: 'third',
    narrativeDistance: 'limited',
    sentenceRhythm: 'balanced',
    dialogueRatio: 45,
    emotionalTemperature: 5,
    imageryDensity: 3,
    vocabularyRegister: 'plain',
    hardRules: ['不使用长横线破折号', '不以总结或感悟收尾', '保持 POV 信息边界'],
    softRules: ['优先用动作和感官展示情绪', '场景压力越高，句子越短'],
    positiveExamples: [
      '“把灯放低一点。”\n\n他没有抬头，手指仍压在纸面上。\n\n线一条条画下去，顺序和昨夜一致。\n\n“第六点亮了。”\n\n对面沉默了两秒。\n\n“继续。不要加输入。”',
    ],
    negativeExamples: [
      '这意味着一切才刚刚开始，他明白了，命运的齿轮已经开始转动，而真正的考验，才刚刚拉开帷幕。',
    ],
    notes: '写实基调，不写玄虚。',
  })

  // ── 账本：第 3 章的状态推进记录 ──
  memoryStore.createStoryEventWithChanges({
    event: {
      projectId,
      chapterNumber: 3,
      sceneId: null,
      sceneOrder: 0,
      type: 'discovery',
      title: '第七处节点自发联动',
      summary: '最低刺激下第七处主动牵引前六点，形成完整图形。',
      outcome: '主角决定只观察不干预。',
      status: 'confirmed',
      parentEventId: null,
      source: 'manual',
    },
    entityRefs: [
      { entityType: 'character', entityId: FIXTURE_IDS.protagonist, role: 'actor', note: '承受异象' },
      { entityType: 'conflict', entityId: FIXTURE_IDS.conflictMain, role: 'affected', note: '质疑升级' },
    ],
    changes: [
      {
        subjectType: 'character',
        subjectId: FIXTURE_IDS.protagonist,
        dimension: 'character.state',
        targetType: null,
        targetId: null,
        valueType: 'text',
        beforeValue: '仍在按计划做低输入节点测试。',
        afterValue: '已建立前六处节点的稳定顺序，并目击第七处主动牵引。',
        reason: '第七处节点自发联动',
        significance: 7,
        source: 'manual',
      },
      {
        subjectType: 'conflict',
        subjectId: FIXTURE_IDS.conflictMain,
        dimension: 'conflict.stage',
        targetType: null,
        targetId: null,
        valueType: 'enum',
        beforeValue: 'escalating',
        afterValue: 'erupting',
        reason: '节点结构的真实性被直接观测',
        significance: 8,
        source: 'manual',
      },
    ],
  })

  const narrativeTask: NarrativeTask = {
    description: '本章把第七处异象从"失控风险"读反转为"结构成图"，主角据此确定中止边界并决定赴考。',
    type: 'create_reversal',
    targetEntity: FIXTURE_IDS.conflictMain,
    priority: 'high',
    chapterEndingHook: 'suspense',
    povCharacters: ['叶明远'],
    sceneCount: 3,
    positioning: 'information',
    timeOffset: 8,
  }

  const constraints: ChapterConstraints = {
    facts: [],
    cognitive: [],
    stage: [],
    narrativeDebts: [store.getForeshadow(FIXTURE_IDS.foreshadowPlanted)!],
    characterArcs: [
      { character: store.getCharacter(FIXTURE_IDS.protagonist)!, allowedNextStage: 'climax' },
    ],
    conflictTargets: [
      {
        conflict: store.getConflict(FIXTURE_IDS.conflictMain)!,
        targetStage: 'reversing',
        intensityDelta: 2,
        isClimax: false,
      },
    ],
    suspenseHooks: [],
    povCharacters: [FIXTURE_IDS.protagonist],
    sceneCount: 3,
    timeOffset: 8,
    positioning: 'information',
  }

  const arrangedEntities: ArrangedEntity = {
    characterIds: [FIXTURE_IDS.protagonist, FIXTURE_IDS.ally, FIXTURE_IDS.scientist],
    conflictIds: [FIXTURE_IDS.conflictMain, FIXTURE_IDS.conflictSurvival],
    foreshadowIds: [FIXTURE_IDS.foreshadowPlanted, FIXTURE_IDS.foreshadowFresh],
    clueIds: [FIXTURE_IDS.clue],
    factionIds: [FIXTURE_IDS.faction],
    locationIds: [FIXTURE_IDS.location],
    itemIds: [FIXTURE_IDS.item],
    characterFunctions: [
      { characterId: FIXTURE_IDS.protagonist, function: 'change_judgment', note: '把失控读成结构' },
      { characterId: FIXTURE_IDS.scientist, function: 'reveal_world_rule', note: '宣布旧模型错了' },
      { characterId: FIXTURE_IDS.ally, function: 'create_obstacle', note: '用程序压力迫使上报' },
    ],
  }

  return {
    db,
    store,
    memoryStore,
    projectId,
    narrativeTask,
    constraints,
    arrangedEntities,
    close: () => db.close(),
  }
}

/**
 * NovelPromptBuilder 只依赖读接口，这里代理到真实 NovelStore，
 * 避免为快照测试搭一整套服务依赖。
 */
export function createPromptStores(store: NovelStore) {
  return {
    getProject: (id: string) => store.getProject(id),
    listWorldRules: (id: string) => store.listWorldRules(id),
    listStyleGuide: (id: string) => store.listStyleGuide(id),
    listCharacters: (id: string) => store.listCharacters(id),
    listRelationships: (id: string) => store.listRelationships(id),
    listConflicts: (id: string) => store.listConflicts(id),
    listForeshadowing: (id: string) => store.listForeshadowing(id),
    listClues: (id: string) => store.listClues(id),
    listInformationLayers: (id: string) => store.listInformationLayers(id),
    listConstraints: (id: string) => store.listConstraints(id),
    listRecentChapters: (id: string, n: number) => store.listRecentChapters(id, n),
    getChapter: (pid: string, n: number) => store.getChapter(pid, n),
    listEdges: (id: string) => store.listEdges(id),
    listEdgesByEntity: (id: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }) =>
      store.listEdgesByEntity(id, opts),
    listFactions: (id: string) => store.listFactions(id),
    listLocations: (id: string) => store.listLocations(id),
    listItems: (id: string) => store.listItems(id),
    listWorldElements: (id: string) => store.listWorldElements(id),
    listUnfulfilledHooksBefore: (id: string, before: number) => store.listUnfulfilledHooksBefore(id, before),
    listHooksByChapter: (id: string, chapter: number) => store.listHooksByChapter(id, chapter),
    getCharacter: (id: string) => store.getCharacter(id),
    getConflict: (id: string) => store.getConflict(id),
    getForeshadow: (id: string) => store.getForeshadow(id),
    getClue: (id: string) => store.getClue(id),
    getFaction: (id: string) => store.getFaction(id),
    getLocation: (id: string) => store.getLocation(id),
    getInformationLayer: (id: string) => store.getInformationLayer(id),
    getVolume: (id: string) => store.getVolume(id),
    listVolumes: (id: string) => store.listVolumes(id),
    // 文风档案必须代理：缺了它 buildAgentIdentity 会走"档案未生效"降级分支，
    // 快照就测不到 Writer 真实的文风约束段。
    getWritingStyleProfile: (id: string) => store.getWritingStyleProfile(id),
  }
}
