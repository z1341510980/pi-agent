import type { ForeshadowBeat, NovelForeshadow } from '@/api/novel-client'
import type { NovelCreationMode } from '@repo/shared/novel'

export type ChapterTaskKind = NovelCreationMode
export type ChapterFlowSelection = ChapterTaskKind | 'chat'
export type ChapterStartMode = 'manual' | 'ai-arrange'

export interface ChapterTaskSnapshot {
  kind: ChapterTaskKind
  projectId: string
  chapterNumber: number
}

type ForeshadowSchedule = Pick<NovelForeshadow, 'firstChapter' | 'recoverByChapter'> & {
  beats?: ForeshadowBeat[]
}

/**
 * 判断伏笔是否在指定章节有真实写作节点。
 * 伏笔是离散事件链，不是从埋设到回收连续占用每一章的时间段。
 */
export function foreshadowHasBeatAtChapter(
  foreshadow: ForeshadowSchedule,
  chapterNumber: number,
): boolean {
  if (foreshadow.beats && foreshadow.beats.length > 0) {
    return foreshadow.beats.some((beat) => beat.chapter === chapterNumber)
  }

  // 兼容尚未迁移 beats 的旧数据，但同样不把中间章节视为自动出场。
  // recoverByChapter 是"计划回收章"：在计划回收的那一章把伏笔编排进去是期望行为，
  // 所以这里保留它作为出场判据（注意它只在 beats 为空时生效）。
  return foreshadow.firstChapter === chapterNumber
    || foreshadow.recoverByChapter === chapterNumber
}

/** 根据面板选择和启动按钮解析这次真实执行的任务。 */
export function resolveChapterTaskKind(
  flowType: ChapterFlowSelection,
  mode: ChapterStartMode,
): ChapterTaskKind {
  if (mode === 'ai-arrange') return 'arrange'
  if (flowType === 'discussion' || flowType === 'reverse') return flowType
  return 'workflow'
}

/** 时间轴“重新生成/从此章开始”只选择写作引擎，不触发编排或反推。 */
export function resolveWritingTaskKind(
  flowType: ChapterFlowSelection,
): Extract<ChapterTaskKind, 'workflow' | 'discussion'> {
  return flowType === 'discussion' ? 'discussion' : 'workflow'
}

/**
 * 失败重试优先使用同一项目、同一章节的原任务快照。
 * 用户在错误出现后切换 Tab，不应改变已经失败的任务类型。
 */
export function resolveRetryChapterTask(
  activeTask: ChapterTaskSnapshot | null,
  flowType: ChapterFlowSelection,
  projectId: string,
  chapterNumber: number,
): ChapterTaskSnapshot {
  if (activeTask?.projectId === projectId && activeTask.chapterNumber === chapterNumber) {
    return activeTask
  }
  return {
    kind: resolveWritingTaskKind(flowType),
    projectId,
    chapterNumber,
  }
}
