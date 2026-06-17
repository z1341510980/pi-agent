/** 通用键值对类型 */
export type RecordType<T = unknown> = Record<string, T>

/** 可等待的 void（回调函数返回值） */
export type MaybeAsync = void | Promise<void>
