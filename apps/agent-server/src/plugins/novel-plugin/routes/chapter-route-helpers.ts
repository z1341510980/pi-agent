import type { NovelServices } from '../novel-services.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export function requireNovelChapter(
  services: Pick<NovelServices, 'store'>,
  projectId: string,
  chapterNumber: string,
): number {
  const parsed = Number(chapterNumber)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError(ErrorCode.BAD_REQUEST, '无效的 chapterNumber: ' + chapterNumber, 400)
  }
  if (!services.store.getProject(projectId)) {
    throw new AppError(ErrorCode.NOT_FOUND, '项目不存在: ' + projectId, 404)
  }
  if (!services.store.getChapter(projectId, parsed)) {
    throw new AppError(ErrorCode.NOT_FOUND, '章节不存在或不属于该项目: ' + chapterNumber, 404)
  }
  return parsed
}

export function requireWritableNovelChapter(
  services: Pick<NovelServices, 'store'>,
  projectId: string,
  chapterNumber: string,
): number {
  const parsed = requireNovelChapter(services, projectId, chapterNumber)
  if (services.store.getChapter(projectId, parsed)?.status === 'published') {
    throw new AppError(ErrorCode.CONFLICT, '已发布章节不能重新创作，请先进入修订流程', 409)
  }
  try {
    services.store.assertTimelineAllowsGeneration?.(projectId, parsed)
  } catch (error) {
    throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : String(error), 409)
  }
  return parsed
}

export function requireDerivedStateWritableNovelChapter(
  services: Pick<NovelServices, 'store'>,
  projectId: string,
  chapterNumber: string,
): number {
  const parsed = requireWritableNovelChapter(services, projectId, chapterNumber)
  try {
    services.store.assertTimelineAllowsPublish?.(projectId, parsed)
  } catch (error) {
    throw new AppError(ErrorCode.CONFLICT, error instanceof Error ? error.message : String(error), 409)
  }
  return parsed
}
