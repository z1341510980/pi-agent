/**
 * 防 AI 腔正则扫描器（借鉴 PlotPilot ClicheScanner）
 *
 * 与 Writer 系统提示词的 4 条风格规则对应：
 * 1. 不用"——"做转折 → em_dash_abuse
 * 2. 开头直接进入场景 → opening_scenery（开头纯风景描写，启发式）
 * 3. 结尾止于画面 → ending_summary
 * 4. 语言干净 → sudden_adverb/however_conjunction/so_conjunction
 *
 * 每个模式带 hint 字段，Reviewer 拿到扫描结果后可给出具体修改建议。
 *
 * 阈值设计：单次出现的"突然""然而"等是正常的（小说语言天然会有），
 * 只有滥用（出现 ≥ 2 次）才标记为 AI 腔。
 */

export type ClicheSeverity = 'low' | 'medium' | 'high'

export interface ClichePattern {
  /** 模式 ID（稳定，不随文案变化） */
  pattern: string
  /** 中文名称 */
  name: string
  /** 正则表达式（g 标志必须，用于全局匹配） */
  regex: RegExp
  /** 触发阈值（出现次数 >= 阈值才算命中） */
  threshold: number
  /** 修复建议 */
  hint: string
  /** 严重程度 */
  severity: ClicheSeverity
}

export interface ClicheHit {
  pattern: string
  name: string
  count: number
  /** 每个匹配的起始索引 */
  positions: number[]
  hint: string
  severity: ClicheSeverity
}

const PATTERNS: ClichePattern[] = [
  {
    pattern: 'em_dash_abuse',
    name: '滥用长横线破折号',
    regex: /——/g,
    threshold: 1,
    hint: '不使用破折号做情节转折或插说。所有转折通过角色的行动、对话或心理变化自然完成。',
    severity: 'high',
  },
  {
    pattern: 'sudden_adverb',
    name: '"突然"滥用',
    regex: /突然[，,]?/g,
    threshold: 2,
    hint: '"突然"出现过于频繁，建议改为更具体的动作描写或心理变化。如"突然门开了"→"门吱呀一声推开"。',
    severity: 'medium',
  },
  {
    pattern: 'however_conjunction',
    name: '"然而"做转折开头',
    regex: /然而[，,]?/g,
    threshold: 2,
    hint: '"然而"作为转折连词开头过于密集。建议改用角色行动或对话承载转折，如"她没有回头"。',
    severity: 'medium',
  },
  {
    pattern: 'so_conjunction',
    name: '"于是"过度使用',
    regex: /于是[，,]?/g,
    threshold: 2,
    hint: '"于是"出现频繁。建议拆分为独立句子，用动作或时间推进替代。',
    severity: 'low',
  },
  {
    pattern: 'cant_help_but',
    name: '"不禁/不由得"AI 总结腔',
    regex: /(不禁|不由得|不由自主地)/g,
    threshold: 2,
    hint: '"不禁/不由得"是 AI 总结腔的常见标志。建议直接描写角色的具体动作或表情。',
    severity: 'medium',
  },
  {
    // {1,15} 限制中间长度，避免跨句误匹配（如"仿佛春天来了。过了一会儿，他像往常一样"）
    pattern: 'simile_template',
    name: '"仿佛...一般"AI 比喻模板',
    regex: /(仿佛|宛如|犹如)[^，。！？]{1,15}(一般|似的|一样)/g,
    threshold: 2,
    hint: '比喻句式过于工整。建议减少"仿佛...一般"模板，改用更直接的意象。',
    severity: 'low',
  },
  {
    pattern: 'deep_inside',
    name: '"内心深处"等陈词滥调',
    regex: /(内心深处|灵魂深处|心底深处|心底里)/g,
    threshold: 1,
    hint: '"内心深处"是 AI 常见的情感陈词滥调。建议改用具体动作或微表情承载情感。',
    severity: 'medium',
  },
  {
    pattern: 'ending_summary',
    name: '结尾总结性句子',
    regex: /(就这样[，,].{0,20}结束了|这便是.{0,15}安排|一切都.{0,10}尘埃落定|所有的.{0,10}都.{0,10}释然)/g,
    threshold: 1,
    hint: '结尾出现总结性句子。结尾应止于一个动作、一句对话或一个画面，绝不发表总结性、感悟性的句子。',
    severity: 'high',
  },
  {
    pattern: 'opening_scenery',
    name: '开头纯风景描写',
    regex: /^[^"「『]{0,5}(天|云|风|雨|月|日|阳光|夜色|山|水)/g,
    threshold: 1,
    hint: '开头可能为纯风景/环境描写。开头必须直接进入场景、动作或对话。',
    severity: 'medium',
  },
  {
    pattern: 'meta_narration',
    name: '元叙事评论',
    regex: /(读者|观众|故事|剧情|作者|笔锋|文字)/g,
    threshold: 2,
    hint: '元叙事评论（提及"读者/故事"等）破坏沉浸感。建议删除直接对读者的称呼。',
    severity: 'medium',
  },
  {
    // 注意：与 simile_template 在"仿佛/宛如/犹如"上有重叠。
    // 区别：simile_template 检测"...一般/似的/一样"完整句式；
    //       purple_prose 检测比喻词的总体密度（threshold=3）。
    pattern: 'purple_prose',
    name: '紫色散文（过度修饰）',
    regex: /(犹如|宛若|仿佛|恍若|好似|有如)/g,
    threshold: 3,
    hint: '比喻词密度过高。建议精简，仅保留最具表现力的比喻。',
    severity: 'low',
  },

  // ═══════════════════════════════════════════════════════════════
  // 模型退化检测（4 类）—— 借鉴 oh-story-claudecode 的模型退化检测
  // 这些模式意味着模型输出质量退化，需要立即干预（重写或重新生成）
  // ═══════════════════════════════════════════════════════════════
  {
    pattern: 'model_repetition',
    name: '模型复读（连续重复）',
    // 同一 2-20 字短语连续出现 3 次以上
    regex: /([\u4e00-\u9fa5]{2,20})\1{2,}/g,
    threshold: 1,
    hint: '检测到模型复读：同一短语连续重复出现。这是模型退化信号，该段必须重写。',
    severity: 'high',
  },
  {
    pattern: 'model_refusal',
    name: '模型拒绝输出',
    regex: /(我不能|我无法|作为AI|作为语言模型|作为一个人工智能|对不起，我|抱歉，我(?:不能|无法)|我(?:被|受)(?:编程|训练|设计)(?:为|来))/g,
    threshold: 1,
    hint: '检测到模型拒绝输出的措辞。模型触发了安全策略，该段必须重写。',
    severity: 'high',
  },
  {
    pattern: 'engineering_leak',
    name: '工程词泄漏（英文）',
    regex: /(system\s*prompt|role\s*[:：]|assistant\s*[:：]|user\s*[:：]|```[a-z]*|【system】|\[INST\]|<\|im_start\|>|<\|im_end\|>)/gi,
    threshold: 1,
    hint: '检测到提示词工程相关词汇泄漏到正文。模型输出了内部指令，必须立即清理。',
    severity: 'high',
  },
  {
    pattern: 'engineering_words_cn',
    name: '工程词泄漏（中文）',
    // 移除"任务类型""叙事任务"：在军事/谍战/任务流题材中是正常用语，会误判。
    // 保留明确的工程词：提示词/系统提示/角色设定/章节约束/创作约束/字数要求/输出格式/验收标准
    regex: /(提示词|系统提示|角色设定|章节约束|创作约束|字数要求|输出格式|验收标准)/g,
    threshold: 1,
    hint: '检测到创作系统的工程词汇泄漏到正文中。这些词属于提示词模板，不应出现在小说正文。',
    severity: 'high',
  },

  // ═══════════════════════════════════════════════════════════════
  // Gate G 检测（解释腔/上帝感/安排感）—— 借鉴 oh-story-claudecode 7 Gate 体系
  // 这些模式是 AI 写作最深层的"腔调"问题，比表面词汇滥用更难察觉
  // ═══════════════════════════════════════════════════════════════
  {
    pattern: 'explanation_tone',
    name: '解释腔（替读者总结）',
    regex: /(这意味着|换句话说|也就是说|简而言之|总的来说|换言之|这并不是说|从某种意义上说|换句话说)/g,
    threshold: 1,
    hint: '出现解释腔：替读者总结"这意味着什么"。小说应让读者自己体会，不要替他总结。',
    severity: 'high',
  },
  {
    pattern: 'god_view_arrangement',
    name: '上帝感/安排感',
    regex: /(命运(?:的安排|使然|注定|轨迹)|注定(?:要|会|得)|冥冥之中|上天的安排|命运的齿轮|巧合的是|恰好在那时|就在这时|正巧|碰巧|不偏不倚)/g,
    threshold: 1,
    hint: '出现上帝感/安排感措辞。情节应通过角色行动和因果推进，不要用"命运/注定/恰好"等词强行安排。',
    severity: 'high',
  },
  {
    pattern: 'over_analysis',
    name: '过度心理分析',
    // 连续多句心理分析（"他想...他明白...他意识到...他感到..."）
    regex: /(他想道|他想到|他明白|他意识到|他感到|他感觉到|他知道|他清楚|他理解|他领悟|他认识到)/g,
    threshold: 4,
    hint: '心理分析词汇密度过高。建议用动作、对话和微表情承载心理变化，而非直接告知"他想/他明白/他意识到"。',
    severity: 'medium',
  },
]

export class ClicheScanner {
  private readonly patterns: ClichePattern[]

  constructor(patterns: ClichePattern[] = PATTERNS) {
    this.patterns = patterns
  }

  scan(text: string): ClicheHit[] {
    if (!text) return []
    const hits: ClicheHit[] = []
    // 1. 正则模式检测
    for (const p of this.patterns) {
      // 重置 regex lastIndex（g 标志会保留状态）
      p.regex.lastIndex = 0
      const positions: number[] = []
      let match: RegExpExecArray | null
      while ((match = p.regex.exec(text)) !== null) {
        positions.push(match.index)
        // 防止零宽匹配死循环
        if (match.index === p.regex.lastIndex) p.regex.lastIndex++
      }
      if (positions.length >= p.threshold) {
        hits.push({
          pattern: p.pattern,
          name: p.name,
          count: positions.length,
          positions,
          hint: p.hint,
          severity: p.severity,
        })
      }
    }
    // 2. 结构性检测（长段落/碎句号/过度压缩/比喻密度）
    hits.push(...this.scanStructural(text))
    return hits
  }

  /**
   * 结构性检测：无法用单一正则表达，需要分析段落/句子结构
   */
  private scanStructural(text: string): ClicheHit[] {
    const hits: ClicheHit[] = []
    hits.push(...this.scanLongParagraph(text))
    hits.push(...this.scanFragmentSentences(text))
    hits.push(...this.scanOverCompression(text))
    return hits
  }

  /**
   * 长段落检测：单段超过 200 字
   * 长段落通常是 AI 一次性输出过多内容，缺少分段节奏感
   */
  private scanLongParagraph(text: string): ClicheHit[] {
    const hits: ClicheHit[] = []
    const paragraphs = text.split(/\n+/)
    let offset = 0
    let longCount = 0
    const positions: number[] = []
    for (const para of paragraphs) {
      const paraStart = text.indexOf(para, offset)
      // 中文段落字数（去除空白）
      const charCount = para.replace(/\s/g, '').length
      if (charCount > 200) {
        longCount++
        if (paraStart >= 0) positions.push(paraStart)
      }
      if (paraStart >= 0) offset = paraStart + para.length
    }
    if (longCount >= 1) {
      hits.push({
        pattern: 'long_paragraph',
        name: '长段落（单段 >200 字）',
        count: longCount,
        positions,
        hint: '存在超过 200 字的超长段落。建议适当分段，增强阅读节奏感。网文段落宜短不宜长。',
        severity: 'low',
      })
    }
    return hits
  }

  /**
   * 碎句号检测：连续多个超短句（每句 < 8 字）
   * 碎句号是过度压缩的标志——模型把本应连贯的叙述拆成了碎片
   */
  private scanFragmentSentences(text: string): ClicheHit[] {
    const hits: ClicheHit[] = []
    // 按句号/问号/感叹号分句
    const sentences = text.split(/[。！？\n]+/).filter(s => s.trim().length > 0)
    let consecutive = 0
    let maxConsecutive = 0
    let fragCount = 0
    for (const s of sentences) {
      const len = s.replace(/\s/g, '').length
      if (len > 0 && len < 8) {
        consecutive++
        if (consecutive > maxConsecutive) maxConsecutive = consecutive
      } else {
        if (consecutive >= 3) fragCount += consecutive
        consecutive = 0
      }
    }
    if (consecutive >= 3) fragCount += consecutive
    // 连续 3+ 个超短句才算碎句号
    if (maxConsecutive >= 3) {
      hits.push({
        pattern: 'fragment_sentences',
        name: '碎句号（连续超短句）',
        count: fragCount,
        positions: [],
        hint: `检测到连续 ${maxConsecutive} 个超短句（<8字）。叙述过于碎片化，建议合并为连贯的长句，长短句交替。`,
        severity: 'medium',
      })
    }
    return hits
  }

  /**
   * 过度压缩检测：连续大量超短段落（1-2 行）
   * 过度压缩是模型为了控制字数而把内容压扁，牺牲了描写的丰满度
   */
  private scanOverCompression(text: string): ClicheHit[] {
    const hits: ClicheHit[] = []
    const paragraphs = text.split(/\n+/).filter(p => p.trim().length > 0)
    let consecutive = 0
    let maxConsecutive = 0
    let compressCount = 0
    for (const p of paragraphs) {
      const len = p.replace(/\s/g, '').length
      // 单段不足 30 字视为超短段
      if (len > 0 && len < 30) {
        consecutive++
        if (consecutive > maxConsecutive) maxConsecutive = consecutive
      } else {
        if (consecutive >= 4) compressCount += consecutive
        consecutive = 0
      }
    }
    if (consecutive >= 4) compressCount += consecutive
    // 连续 4+ 个超短段才算过度压缩
    if (maxConsecutive >= 4) {
      hits.push({
        pattern: 'over_compression',
        name: '过度压缩（连续超短段）',
        count: compressCount,
        positions: [],
        hint: `检测到连续 ${maxConsecutive} 个超短段落（<30字）。内容可能被过度压缩，建议丰富描写、合并相关段落。`,
        severity: 'medium',
      })
    }
    return hits
  }
}

const defaultScanner = new ClicheScanner()

export function scanCliches(text: string): ClicheHit[] {
  return defaultScanner.scan(text)
}

/**
 * 把扫描结果格式化为 Reviewer 可读的文本块
 * 用于注入 Reviewer 系统提示词或用户消息
 *
 * 调用约定：即使 hits 为空也返回"未检测到"提示文本。
 * 若调用方希望"无命中时不注入"，应在调用前自行判断 hits.length > 0。
 */
export function formatClicheReport(hits: ClicheHit[]): string {
  if (hits.length === 0) {
    return '【防 AI 腔扫描】未检测到明显的 AI 腔模式。'
  }
  const lines: string[] = ['【防 AI 腔扫描】检测到以下问题：']
  for (const hit of hits) {
    lines.push(
      `- ${hit.name}：出现 ${hit.count} 次（严重度：${hit.severity}）`,
    )
    lines.push(`  建议：${hit.hint}`)
  }
  return lines.join('\n')
}
