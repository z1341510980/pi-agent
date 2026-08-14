/**
 * 解析章节开篇可见的实体。
 *
 * 历史章节命中 N-1 快照时，快照外实体只能作为本章新编排的静态档案使用；
 * 当前表中的状态已经可能被后续章节推进，不能作为该历史章节的章前事实。
 */
export interface ChapterBoundaryEntityResolution<T> {
  entity: T
  /** true 表示实体的动态字段来自可靠的章前状态，可以注入提示词。 */
  hasBoundaryState: boolean
}

export function resolveChapterBoundaryEntity<T>(
  id: string,
  boundaryById: ReadonlyMap<string, T>,
  getCurrent: (id: string) => T | undefined,
  fromSnapshot: boolean,
): ChapterBoundaryEntityResolution<T> | undefined {
  const boundaryEntity = boundaryById.get(id)
  if (boundaryEntity) {
    return { entity: boundaryEntity, hasBoundaryState: true }
  }

  const currentEntity = getCurrent(id)
  if (!currentEntity) return undefined

  return {
    entity: currentEntity,
    hasBoundaryState: !fromSnapshot,
  }
}
