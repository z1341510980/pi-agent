/**
 * 流式错误分类。
 *
 * ## 为什么需要
 *
 * 后端只发 `{ type: 'RUN_ERROR', message: string }`，前端原来就把这个字符串
 * 原样贴到一个红框里。对使用者来说这几乎无用：
 *
 * - **不知道是谁的问题**。API Key 过期、上下文超限、网断了、模型服务 500，
 *   在界面上长得一模一样，都是一行红字。
 * - **不知道该不该重试**。「重试」按钮永远显示，哪怕是 Key 无效这种重试一万次
 *   也不会好的错误。
 * - **不知道去哪修**。Key 的问题要去设置页，上下文超限要压缩，网络问题要看代理，
 *   这些都得用户自己猜。
 *
 * 所以这里做一层分类：判断归属、是否可重试、给一句「该怎么办」，以及一个能
 * 直接点的修复入口。分类只能靠消息文本做模式匹配 —— 后端没给结构化错误码，
 * 这是当前能拿到的全部信号。后端补上错误码之后，这里应该优先读错误码。
 */

/** 错误归属：决定用户该找谁 */
export type ErrorOwnership =
  /** 本应用的问题（上下文管理、参数拼装等） */
  | 'app'
  /** 模型服务方的问题（鉴权、限流、服务不可用） */
  | 'provider'
  /** 网络 / 代理 */
  | 'network'
  /** Agent 执行过程（工具失败、权限拒绝） */
  | 'agent'
  /** 分不出来 */
  | 'unknown'

/** 可点击的修复入口 */
export type ErrorActionKind = 'retry' | 'open-settings' | 'compact' | 'none'

export interface ClassifiedError {
  ownership: ErrorOwnership
  /** 重试有没有意义。false 时不显示重试按钮 —— 显示一个注定失败的按钮比不显示更糟 */
  retryable: boolean
  /** 一句话说清是什么问题 */
  title: string
  /** 一句话说清该怎么办 */
  hint: string
  /** 除重试之外的修复入口 */
  action: ErrorActionKind
  /** 用户主动中断，不算错误（UI 应降级为中性提示） */
  aborted: boolean
  /** 原始消息，折叠在「技术细节」里 */
  raw: string
}

/** 归属的中文标签 */
export const OWNERSHIP_LABELS: Record<ErrorOwnership, string> = {
  app: '应用',
  provider: '模型服务',
  network: '网络',
  agent: 'Agent 执行',
  unknown: '未知来源',
}

interface Rule {
  /** 命中任一模式即判定为该类 */
  patterns: RegExp[]
  build: (raw: string) => Omit<ClassifiedError, 'raw'>
}

/**
 * 规则表按**从具体到笼统**排列，第一个命中的生效。
 *
 * 顺序上的讲究：「401」要排在「网络」之前，因为鉴权失败的消息里也常带
 * `fetch failed`；「context length」要排在通用 400 之前。
 */
const RULES: Rule[] = [
  // ── 用户主动中断：不是错误 ──
  {
    patterns: [/\baborted?\b/i, /AbortError/i, /canceled|cancelled/i, /用户取消|已中断/],
    build: () => ({
      ownership: 'app',
      retryable: true,
      title: '生成已中断',
      hint: '这次输出被手动停止了，可以直接重新发送。',
      action: 'retry',
      aborted: true,
    }),
  },

  // ── 正文质量门（novel 创作流程的确定性检测，不是基础设施故障）──
  //
  // 必须排在「服务端 5xx」之前：质量门文案里常带数字（"仍有 500 字未通过"），
  // 通用 /\b5\d{2}\b/ 会把它误判成模型服务故障并给出「稍后重试」，
  // 而重新生成不会让确定性检测消失 —— 那只是再烧一遍 token。
  // 正确出口是定向再修订 / 手动编辑 / 保留草稿，由 NovelConversationPanel
  // 的结构化失败卡提供（依据 result.errorCode）。
  {
    patterns: [/质量门|已阻止落库|正文表达|修订后仍未通过|未成功应用任何修改/],
    build: () => ({
      ownership: 'app',
      retryable: false,
      title: '正文质量门未通过',
      hint: '本次修订未通过确定性质量门，正文未落库但修订稿已保留。可对未通过项再次定向修订、手动编辑或保留草稿；不建议整章重跑。',
      action: 'none',
      aborted: false,
    }),
  },

  // ── 鉴权 ──
  {
    patterns: [
      /\b401\b/,
      /\b403\b/,
      /unauthorized/i,
      /invalid[\s_-]*api[\s_-]*key/i,
      /incorrect api key/i,
      /authentication[\s_-]*(failed|error)/i,
      /api[\s_-]*key.*(missing|not\s*(set|found)|无效|缺失)/i,
      /密钥|鉴权失败/,
    ],
    build: () => ({
      ownership: 'provider',
      retryable: false,
      title: 'API Key 无效或已过期',
      hint: '重试不会有用。到设置页检查该 Provider 的 API Key 与 Base URL。',
      action: 'open-settings',
      aborted: false,
    }),
  },

  // ── 余额 / 配额 ──
  {
    patterns: [
      /insufficient[\s_-]*(quota|balance|credit)/i,
      /quota[\s_-]*exceeded/i,
      /billing/i,
      /余额不足|欠费/,
    ],
    build: () => ({
      ownership: 'provider',
      retryable: false,
      title: '账户额度不足',
      hint: '重试不会有用。请到该 Provider 的控制台充值，或在设置页换一个 Provider。',
      action: 'open-settings',
      aborted: false,
    }),
  },

  // ── 限流 ──
  {
    patterns: [/\b429\b/, /rate[\s_-]*limit/i, /too many requests/i, /请求过于频繁|限流/],
    build: () => ({
      ownership: 'provider',
      retryable: true,
      title: '触发服务端限流',
      hint: '稍等几秒再重试；如果频繁出现，考虑换一个模型或提高账户等级。',
      action: 'retry',
      aborted: false,
    }),
  },

  // ── 上下文超限 ──
  {
    patterns: [
      /context[\s_-]*(length|window)/i,
      /maximum context/i,
      /too many tokens/i,
      /token[\s_-]*limit/i,
      /上下文.*(超|过长|溢出)/,
    ],
    build: () => ({
      ownership: 'app',
      retryable: false,
      title: '上下文超出模型窗口',
      hint: '直接重试还是会超。先压缩上下文，或换一个窗口更大的模型。',
      action: 'compact',
      aborted: false,
    }),
  },

  // ── 模型不存在 / 不可用 ──
  {
    patterns: [
      /model[\s_-]*not[\s_-]*found/i,
      /(unknown|unsupported|invalid)[\s_-]*model/i,
      // 「model X does not exist」与「does not exist ... model」两种语序都要覆盖
      /model\b[\s\S]{0,60}does not exist/i,
      /does not exist[\s\S]{0,60}\bmodel\b/i,
      /模型.*(不存在|不可用|未找到)/,
    ],
    build: () => ({
      ownership: 'provider',
      retryable: false,
      title: '模型不可用',
      hint: '当前 Provider 没有这个模型。到设置页确认模型 ID，或换一个模型。',
      action: 'open-settings',
      aborted: false,
    }),
  },

  // ── 网络 / 代理 ──
  {
    patterns: [
      /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT/,
      /fetch failed/i,
      /network[\s_-]*error/i,
      /socket hang up/i,
      /tunnel|proxy/i,
      /certificate|self[\s_-]*signed/i,
      /网络(错误|不可用)|连接(失败|被拒)/,
    ],
    build: () => ({
      ownership: 'network',
      retryable: true,
      title: '连不上模型服务',
      hint: '检查网络与代理设置（设置页 → 通用设置 → 代理），然后重试。',
      action: 'retry',
      aborted: false,
    }),
  },

  // ── 超时 ──
  {
    patterns: [/timed?[\s_-]*out/i, /timeout/i, /超时/],
    build: () => ({
      ownership: 'network',
      retryable: true,
      title: '请求超时',
      hint: '可以直接重试。若反复超时，到设置页调大 LLM 超时时间或换个模型。',
      action: 'retry',
      aborted: false,
    }),
  },

  // ── 服务端错误 ──
  {
    patterns: [
      /\b5\d{2}\b/,
      /internal server error/i,
      /bad gateway/i,
      /service unavailable/i,
      /overloaded/i,
      /服务(暂时)?不可用/,
    ],
    build: () => ({
      ownership: 'provider',
      retryable: true,
      title: '模型服务暂时故障',
      hint: '这是服务端的问题，稍后重试通常就好了。',
      action: 'retry',
      aborted: false,
    }),
  },

  // ── 工具 / 权限 ──
  {
    patterns: [
      /tool[\s_-]*(call|execution)[\s_-]*(failed|error)/i,
      /permission[\s_-]*denied/i,
      /工具(调用|执行)失败|权限(不足|被拒)/,
    ],
    build: () => ({
      ownership: 'agent',
      retryable: true,
      title: '工具执行失败',
      hint: '看下面的技术细节确认是哪个工具；权限问题可在输入框左侧调整权限模式。',
      action: 'retry',
      aborted: false,
    }),
  },
]

/** 兜底：分不出来时假定可重试 —— 让用户至少有一次机会，比直接判死好 */
const FALLBACK: Omit<ClassifiedError, 'raw'> = {
  ownership: 'unknown',
  retryable: true,
  title: '生成失败',
  hint: '可以先重试一次。若持续失败，展开技术细节看原始报错。',
  action: 'retry',
  aborted: false,
}

export function classifyStreamError(message: string): ClassifiedError {
  const raw = message?.trim() ?? ''
  if (!raw) return { ...FALLBACK, raw: '' }

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(raw))) {
      return { ...rule.build(raw), raw }
    }
  }
  return { ...FALLBACK, raw }
}
