/**
 * 群聊同场角色合并调用
 *
 * 演出阶段逐角色轮询，ch10 实测 20 次调用 × 15.9s ≈ 318 秒只换回 3.7k token ——
 * 每次都要重发完整 system + 场景上下文 + 对话历史，固定开销远大于产出。
 *
 * 用例的核心是那条**不能放松的前提**：只合并信息对称的角色。
 * 角色可见上下文按人裁剪（informationLayers 决定谁知道什么），
 * 把知情者和不知情者合进一次调用等于泄露秘密，后续会出现
 * "他明明不知道却提到了那件事"。这比省下的时间代价大得多。
 */
import { describe, it, expect } from 'vitest'
import {
  groupSymmetricActors,
  computeKnowledgeFingerprint,
  buildMergedActorPrompt,
  parseMergedActorResponse,
  splitIntoBatches,
  MAX_MERGE_GROUP_SIZE,
  MIN_MERGE_GROUP_SIZE,
  type ActorForGrouping,
} from '../core/agent/discussion-actor-batching.js'

function actor(
  name: string,
  knowledge: ActorForGrouping['knowledge'] = {},
): ActorForGrouping {
  return { id: `char-${name}`, name, characterId: name, knowledge }
}

describe('groupSymmetricActors：只合并信息对称的角色', () => {
  it('认知完全相同 → 同组', () => {
    const groups = groupSymmetricActors([
      actor('甲', { L1: { knows: true } }),
      actor('乙', { L1: { knows: true } }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].actors.map((a) => a.name)).toEqual(['甲', '乙'])
  })

  it('一方知情一方不知情 → 必须分开（否则泄露秘密）', () => {
    const groups = groupSymmetricActors([
      actor('甲', { L1: { knows: true } }),
      actor('乙', {}),
    ])

    expect(groups).toHaveLength(2)
  })

  it('knows 与 suspects 不对称 —— 可见文本不同（"你知道" vs "你有所怀疑"）', () => {
    const groups = groupSymmetricActors([
      actor('甲', { L1: { knows: true } }),
      actor('乙', { L1: { suspects: true } }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('误解内容不同 → 分开（注入的文本就是误解内容本身）', () => {
    const groups = groupSymmetricActors([
      actor('甲', { L1: { misunderstands: '以为是意外' } }),
      actor('乙', { L1: { misunderstands: '以为是他人所为' } }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('误解内容相同 → 同组', () => {
    const groups = groupSymmetricActors([
      actor('甲', { L1: { misunderstands: '以为是意外' } }),
      actor('乙', { L1: { misunderstands: '以为是意外' } }),
    ])
    expect(groups).toHaveLength(1)
  })

  it('三态优先级与 buildCharacterVisibleContext 一致：knows 命中后忽略 suspects', () => {
    // 那边是 if-else 链，命中 knows 就 continue，不再看 suspects
    const groups = groupSymmetricActors([
      actor('甲', { L1: { knows: true, suspects: true } }),
      actor('乙', { L1: { knows: true } }),
    ])
    expect(groups).toHaveLength(1)
  })

  it('多层信息：任一层不对称就分开', () => {
    const groups = groupSymmetricActors([
      actor('甲', { L1: { knows: true }, L2: { knows: true } }),
      actor('乙', { L1: { knows: true }, L2: {} }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('指纹覆盖全部层的并集 —— 只看自己的 key 会漏掉"一方有该层状态"的差异', () => {
    const a = actor('甲', { L1: { knows: true } })
    const b = actor('乙', { L2: { knows: true } })
    const layerIds = ['L1', 'L2']

    expect(computeKnowledgeFingerprint(a, layerIds))
      .not.toBe(computeKnowledgeFingerprint(b, layerIds))
  })

  it('全员无信息层（如临时角色）→ 全部同组', () => {
    const groups = groupSymmetricActors([actor('甲'), actor('乙'), actor('丙')])
    expect(groups).toHaveLength(1)
    expect(groups[0].actors).toHaveLength(3)
  })

  it('保持输入顺序 —— 演出顺序影响台词承接，不能被分组打乱', () => {
    const groups = groupSymmetricActors([
      actor('甲', { L1: { knows: true } }),
      actor('乙', {}),
      actor('丙', { L1: { knows: true } }),
      actor('丁', {}),
    ])

    // 组间按首次出现顺序；组内保持原顺序
    expect(groups[0].actors.map((a) => a.name)).toEqual(['甲', '丙'])
    expect(groups[1].actors.map((a) => a.name)).toEqual(['乙', '丁'])
  })

  it('空输入不抛错', () => {
    expect(groupSymmetricActors([])).toEqual([])
  })
})

describe('buildMergedActorPrompt', () => {
  const group = {
    actors: [actor('叶明远'), actor('林霜')],
    fingerprint: 'x',
  }

  it('给出严格的出场顺序与段标记格式', () => {
    const prompt = buildMergedActorPrompt(group, '在实验室外对峙')

    expect(prompt).toContain('1. 叶明远')
    expect(prompt).toContain('2. 林霜')
    expect(prompt).toContain('### 叶明远')
    expect(prompt).toContain('### 林霜')
  })

  it('明确禁止替他人说话 —— 合并调用最容易出的错', () => {
    const prompt = buildMergedActorPrompt(group, '任务')
    expect(prompt).toContain('不得在某人的段落里替另一个角色说话')
  })

  it('保留单角色调用的剧本格式与风格约束', () => {
    const prompt = buildMergedActorPrompt(group, '任务')
    expect(prompt).toContain('[可见动作]')
    expect(prompt).toContain('不得趋同')
    expect(prompt).toContain('不得输出「意图 / 心理 / 应对')
  })

  it('说明合并的目的是让后者回应前者', () => {
    const prompt = buildMergedActorPrompt(group, '任务')
    expect(prompt).toContain('后出场的角色可以回应先出场角色刚说的话')
  })

  it('带上本回合任务', () => {
    expect(buildMergedActorPrompt(group, '在实验室外对峙')).toContain('在实验室外对峙')
  })
})

describe('parseMergedActorResponse：按角色分发', () => {
  const names = ['叶明远', '林霜']

  it('标准格式正确切分', () => {
    const text = [
      '### 叶明远',
      '[后退半步] "你不该来。"',
      '',
      '### 林霜',
      '[抬手拦住] "现在轮不到你说这句。"',
    ].join('\n')

    const result = parseMergedActorResponse(text, names)

    expect(result.get('叶明远')).toContain('你不该来')
    expect(result.get('林霜')).toContain('轮不到你说')
    // 段内容不能串到别人名下
    expect(result.get('叶明远')).not.toContain('轮不到你说')
  })

  it('容忍 ## 与行尾冒号等常见变体', () => {
    const text = '## 叶明远：\n[点头] "好。"\n\n#### 林霜\n[沉默] "……"'
    const result = parseMergedActorResponse(text, names)

    expect(result.size).toBe(2)
  })

  it('容忍名字被引号包裹', () => {
    const text = '### 「叶明远」\n[点头] "好。"'
    expect(parseMergedActorResponse(text, names).get('叶明远')).toContain('好')
  })

  it('模型自编的角色名不被采纳 —— 应解析失败而非猜测', () => {
    const text = '### 神秘人\n[出现] "……"'
    expect(parseMergedActorResponse(text, names).size).toBe(0)
  })

  it('缺段时如实报告，由调用方决定回退', () => {
    const text = '### 叶明远\n[点头] "好。"'
    const result = parseMergedActorResponse(text, names)

    expect(result.has('叶明远')).toBe(true)
    expect(result.has('林霜')).toBe(false)
  })

  it('段标记前的前言被丢弃（模型有时会先寒暄）', () => {
    const text = '好的，我来演出。\n\n### 叶明远\n[点头] "好。"'
    const result = parseMergedActorResponse(text, names)

    expect(result.get('叶明远')).toBe('[点头] "好。"')
  })

  it('空段不产生空条目', () => {
    const text = '### 叶明远\n\n### 林霜\n[沉默] "……"'
    const result = parseMergedActorResponse(text, names)

    expect(result.has('叶明远')).toBe(false)
    expect(result.has('林霜')).toBe(true)
  })

  it('空输入返回空 Map', () => {
    expect(parseMergedActorResponse('', names).size).toBe(0)
    expect(parseMergedActorResponse('   \n ', names).size).toBe(0)
  })
})

describe('splitIntoBatches：成组规模上限', () => {
  it('不超上限时单批', () => {
    const group = { actors: [actor('甲'), actor('乙')], fingerprint: 'x' }
    expect(splitIntoBatches(group)).toHaveLength(1)
  })

  it('超上限时拆分 —— 一次产出太多段会让后面的角色被草草收尾', () => {
    const actors = Array.from({ length: MAX_MERGE_GROUP_SIZE + 2 }, (_, i) => actor(`A${i}`))
    const batches = splitIntoBatches({ actors, fingerprint: 'x' })

    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(MAX_MERGE_GROUP_SIZE)
    expect(batches[1]).toHaveLength(2)
  })

  it('拆分保持顺序', () => {
    const actors = Array.from({ length: MAX_MERGE_GROUP_SIZE + 1 }, (_, i) => actor(`A${i}`))
    const flat = splitIntoBatches({ actors, fingerprint: 'x' }).flat()
    expect(flat.map((a) => a.name)).toEqual(actors.map((a) => a.name))
  })

  it('阈值常量自洽：最小成组 < 最大成组', () => {
    expect(MIN_MERGE_GROUP_SIZE).toBeLessThan(MAX_MERGE_GROUP_SIZE)
  })
})

describe('实测场景：ch10 的 20 次调用', () => {
  it('4 个信息对称角色合并为 1 次调用', () => {
    const actors = ['甲', '乙', '丙', '丁'].map((n) => actor(n, { L1: { knows: true } }))
    const groups = groupSymmetricActors(actors)
    const batches = groups.flatMap(splitIntoBatches)

    expect(batches).toHaveLength(1)
  })

  it('有信息差时按认知分层，仍能减少调用数', () => {
    // 2 个知情 + 2 个不知情 → 2 次调用（而非 4 次）
    const actors = [
      actor('甲', { L1: { knows: true } }),
      actor('乙', {}),
      actor('丙', { L1: { knows: true } }),
      actor('丁', {}),
    ]
    const batches = groupSymmetricActors(actors).flatMap(splitIntoBatches)

    expect(batches).toHaveLength(2)
  })

  it('全员认知各不相同时退化为逐个调用（正确但无收益）', () => {
    const actors = [
      actor('甲', { L1: { knows: true } }),
      actor('乙', { L1: { suspects: true } }),
      actor('丙', { L1: { misunderstands: 'x' } }),
      actor('丁', {}),
    ]
    expect(groupSymmetricActors(actors).flatMap(splitIntoBatches)).toHaveLength(4)
  })
})
