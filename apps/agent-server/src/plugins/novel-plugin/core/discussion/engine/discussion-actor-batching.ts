/**
 * 群聊演出阶段的同场角色合并调用。
 *
 * ## 问题
 *
 * 演出阶段逐角色轮询，每个角色一次独立 LLM 调用只产出几行台词。实测：
 *
 * | 章 | character 调用数 | 平均输出 token |
 * | --- | --- | --- |
 * | 9 | 13 | **0** |
 * | 10 | 20 | 187 |
 * | 11 | 12 | 350 |
 *
 * ch10 那 20 次 × 15.9s ≈ 318 秒，只换回 3.7k token。每次调用都要重发完整
 * system + 场景上下文 + 已有对话历史，固定开销远大于产出。
 *
 * ## 合并的前提：信息对称
 *
 * 不能无条件合并。角色的可见上下文是**按人裁剪**的 —— 谁知道什么、谁误解什么
 * 由 informationLayers 决定，这是小说信息差的核心机制。把知情者和不知情者
 * 合进一次调用，等于把秘密泄露给不该知道的角色，后续台词就会出现
 * "他明明不知道却提到了那件事"。
 *
 * 所以只合并**认知状态完全一致**的角色：对每一条信息层，两人的
 * knows / suspects / misunderstands 都相同。这类角色共享同一份可见上下文，
 * 合并后没有任何信息泄露。
 *
 * ## 边界
 *
 * 纯函数：分组、构建合并提示词、解析分发。是否合并、何时调用由引擎决定。
 */

/** 角色的认知状态（对单条信息层） */
export interface KnowledgeState {
  knows?: boolean
  suspects?: boolean
  misunderstands?: string
}

/** 参与合并判定的最小角色信息 */
export interface ActorForGrouping {
  /** 成员 ID */
  id: string
  /** 显示名，用于合并输出的分段标记 */
  name: string
  /** 实体 ID；临时角色可能没有 */
  characterId?: string
  /**
   * 该角色在各信息层上的认知状态，key 为信息层 ID。
   * 缺失的层视为「完全不知情」。
   */
  knowledge: Record<string, KnowledgeState>
}

/** 一组信息对称的角色 */
export interface ActorGroup {
  actors: ActorForGrouping[]
  /** 该组共享的认知指纹，便于日志排查 */
  fingerprint: string
}

/**
 * 把认知状态归一化为可比较的字符串。
 *
 * 三态互斥且有优先级（knows > suspects > misunderstands），与
 * `buildCharacterVisibleContext` 的 if-else 链一致 —— 那里也是命中一个就 continue。
 * 口径必须一致，否则会把实际可见内容不同的角色判成对称。
 */
function normalizeState(state: KnowledgeState | undefined): string {
  if (!state) return '-'
  if (state.knows) return 'K'
  if (state.suspects) return 'S'
  // 误解内容不同则可见文本不同，必须纳入指纹
  if (state.misunderstands) return `M:${state.misunderstands}`
  return '-'
}

/**
 * 计算角色的认知指纹。
 *
 * 必须遍历**全部层 ID 的并集**而不是各自的 key：只看自己的 key 会让
 * 「层 A 知情」与「层 B 知情」两个角色算出不同长度的指纹却可能意外相等，
 * 也会漏掉「一方在某层有状态、另一方没有」这种差异。
 */
export function computeKnowledgeFingerprint(
  actor: ActorForGrouping,
  allLayerIds: readonly string[],
): string {
  return allLayerIds.map((id) => `${id}=${normalizeState(actor.knowledge[id])}`).join('|')
}

/**
 * 按信息对称性分组。
 *
 * 保持输入顺序：组内顺序 = 原顺序，组间顺序 = 首次出现顺序。
 * 演出顺序影响台词的承接关系，不能被分组打乱。
 */
export function groupSymmetricActors(actors: readonly ActorForGrouping[]): ActorGroup[] {
  // 收集所有出现过的层 ID，保证指纹可比
  const layerIds = new Set<string>()
  for (const actor of actors) {
    for (const id of Object.keys(actor.knowledge)) layerIds.add(id)
  }
  const allLayerIds = Array.from(layerIds).sort()

  const groups: ActorGroup[] = []
  const byFingerprint = new Map<string, ActorGroup>()
  for (const actor of actors) {
    const fingerprint = computeKnowledgeFingerprint(actor, allLayerIds)
    const existing = byFingerprint.get(fingerprint)
    if (existing) {
      existing.actors.push(actor)
      continue
    }
    const group: ActorGroup = { actors: [actor], fingerprint }
    byFingerprint.set(fingerprint, group)
    groups.push(group)
  }
  return groups
}

/** 合并调用的分段标记前缀。用 `###` 是因为角色台词本身不会以它开头。 */
const SEGMENT_PREFIX = '### '

/**
 * 构建合并调用的提示词。
 *
 * 关键约束写进提示词：
 * - 严格按给定顺序、每人一段，段标记固定格式（否则解析不出来）
 * - 各自只演自己，不得替他人说话（合并调用最容易出的错）
 * - 仍遵守单角色调用的剧本格式
 */
export function buildMergedActorPrompt(
  group: ActorGroup,
  roundPrompt: string,
): string {
  const names = group.actors.map((a) => a.name)
  return [
    '本回合由你同时扮演以下角色。这些角色在当前场景中掌握完全相同的信息，因此合并推演。',
    '',
    `## 出场顺序（必须严格按此顺序输出，每个角色一段）`,
    ...names.map((n, i) => `${i + 1}. ${n}`),
    '',
    '## 输出格式（必须严格遵守，否则无法解析）',
    '',
    ...names.map((n) => `${SEGMENT_PREFIX}${n}`),
    '（该角色的演出内容）',
    '',
    '每段内部仍使用单角色演出格式：每行 `[可见动作] "角色台词"`，2-6 行。',
    '',
    '## 硬约束',
    '',
    '- 每个角色只演自己：不得在某人的段落里替另一个角色说话或描写其内心',
    '- 各角色的台词必须符合各自的说话风格，不得趋同',
    '- 后出场的角色可以回应先出场角色刚说的话，这是合并推演的目的',
    '- 不得输出「意图 / 心理 / 应对 / 分析 / 说明」这类提纲标签',
    '',
    '## 本回合任务',
    '',
    roundPrompt,
  ].join('\n')
}

/**
 * 解析合并输出，按角色名分发。
 *
 * 返回 Map 而非数组：调用方需要按成员 ID 定位，且要能判断哪个角色缺段。
 * 解析失败（缺段/串段）由调用方决定回退策略 —— 这里只如实报告。
 */
export function parseMergedActorResponse(
  text: string,
  actorNames: readonly string[],
): Map<string, string> {
  const result = new Map<string, string>()
  if (!text.trim()) return result

  // 按 `### 名字` 切分。宽松匹配前后空白与全角冒号，LLM 常会多加标点。
  const lines = text.split(/\r?\n/)
  let current: string | null = null
  let buffer: string[] = []

  const flush = (): void => {
    if (current && buffer.length > 0) {
      const content = buffer.join('\n').trim()
      if (content) result.set(current, content)
    }
    buffer = []
  }

  for (const line of lines) {
    const heading = matchHeading(line, actorNames)
    if (heading) {
      flush()
      current = heading
      continue
    }
    if (current) buffer.push(line)
  }
  flush()

  return result
}

/**
 * 判断该行是否是某角色的段标记。
 *
 * 容忍 LLM 的常见变体：`###`/`##`、名字带引号或书名号、行尾冒号。
 * 不容忍名字不在给定列表里 —— 那说明模型自行编了角色，应当解析失败而非猜测。
 */
function matchHeading(line: string, actorNames: readonly string[]): string | null {
  const trimmed = line.trim()
  if (!/^#{2,4}\s/.test(trimmed)) return null
  const label = trimmed
    .replace(/^#{2,4}\s*/, '')
    .replace(/[：:]\s*$/, '')
    .replace(/^[「『"'【[]|[」』"'】\]]$/g, '')
    .trim()
  return actorNames.find((n) => n === label) ?? null
}

/** 合并调用的最小成组规模：单人不值得走合并路径（提示词开销反而更大） */
export const MIN_MERGE_GROUP_SIZE = 2

/**
 * 合并调用的最大成组规模。
 *
 * 上限存在的理由：一次调用要产出 N 段台词，N 太大时输出 token 逼近上限，
 * 模型会开始压缩后面的段落（前几个角色演得完整，后面草草收尾），
 * 反而不如拆两次。4 个角色约 8~24 行，是同场对话的常见规模。
 */
export const MAX_MERGE_GROUP_SIZE = 4

/** 把分组切成实际可执行的批次（受最大规模限制） */
export function splitIntoBatches(group: ActorGroup): ActorForGrouping[][] {
  const batches: ActorForGrouping[][] = []
  for (let i = 0; i < group.actors.length; i += MAX_MERGE_GROUP_SIZE) {
    batches.push(group.actors.slice(i, i + MAX_MERGE_GROUP_SIZE))
  }
  return batches
}
