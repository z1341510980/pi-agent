// ── 节拍共享标签与配色（大纲树章节行 / 节拍表分组 / 创作流程共用）──

import type { NovelBeatPlan, BeatDramaticFunction } from '@/api/novel-client'

export const BEAT_FUNCTION_LABELS: Record<BeatDramaticFunction, string> = {
  setup: '铺垫',
  escalation: '递进加压',
  false_victory: '假胜利',
  false_defeat: '假失败',
  midpoint_turn: '中点反转',
  low_point: '低谷',
  climax: '爆发',
  payoff: '兑现爽点',
  aftermath: '余波',
  breather: '缓冲',
}

/** 戏剧功能配色：爆发/兑现暖色警示，低谷冷灰，反转系紫，铺垫缓冲绿蓝 */
export const BEAT_FUNCTION_ACCENTS: Record<BeatDramaticFunction, string> = {
  setup: 'text-blue-500',
  escalation: 'text-orange-500',
  false_victory: 'text-violet-500',
  false_defeat: 'text-violet-500',
  midpoint_turn: 'text-violet-600 font-medium',
  low_point: 'text-slate-400',
  climax: 'text-rose-500 font-medium',
  payoff: 'text-amber-500 font-medium',
  aftermath: 'text-emerald-500',
  breather: 'text-emerald-400',
}

export const BEAT_STATUS_LABELS: Record<NovelBeatPlan['status'], string> = {
  planned: '待执行',
  confirmed: '已发布',
  superseded: '已取代',
}
