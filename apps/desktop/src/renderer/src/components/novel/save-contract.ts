/**
 * 保存契约：让「什么时候落库」这件事只有一套说法。
 *
 * ## 问题
 *
 * 同一屏内此前有四种互不相同的保存行为：
 *
 * | 位置 | 契约 | 用户看到的 |
 * | --- | --- | --- |
 * | 章节正文编辑器 | 1.5s 防抖 + 切章/反推前 flush | 「已保存 / 保存中 / 保存失败」 |
 * | 大纲字段（`DebouncedOutlineField`） | 1.5s 防抖 + onBlur | **无任何反馈**（失败只 `console.error`） |
 * | 实体详情表单（`SaveButton`） | 必须手点「保存修改」 | 按钮禁用态 |
 * | 矩阵拖拽 | 即时入库 | 无（乐观更新） |
 *
 * 后果不是"不统一"这么轻，是**用户无法预测自己的编辑会不会丢**：
 * 同一个角色，在矩阵里拖一下立刻入库，在右栏改个名字不点按钮就丢；
 * 大纲字段自动保存但失败时静默 —— 用户以为存上了。
 *
 * ## 本模块做什么
 *
 * 把四种行为归纳成三类**显式命名**的契约，并为每类定义统一的状态机与文案。
 * 组件仍各自实现落库（存储结构差异真实存在），但「用户如何知道自己的编辑安全了」
 * 由这里统一规定。
 *
 * 不改任何组件的保存时机 —— 那会改变已被用户依赖的行为。本模块提供的是
 * 共享的状态语义与提示文案，让四处至少说同一套话，并让静默失败暴露出来。
 */

/** 保存契约的三类 */
export type SaveContract =
  /**
   * 自动保存：编辑后延迟落库，失焦或切换目标时立即落库。
   * 适用于长文本（正文、大纲）——频繁手点保存不现实。
   */
  | 'autosave'
  /**
   * 显式保存：必须用户确认。
   * 适用于结构化表单（实体详情）——字段间可能互相约束，中途落库会写入半成品。
   */
  | 'explicit'
  /**
   * 即时保存：操作本身就是提交。
   * 适用于直接操作（矩阵拖拽、单元格双击）——那些动作没有"草稿"概念。
   */
  | 'immediate'

/** 保存状态。三类契约共用同一套状态，让 UI 反馈可复用。 */
export type SaveState =
  /** 无未保存改动 */
  | 'saved'
  /** 有未保存改动（autosave 下等待防抖；explicit 下等待用户点击） */
  | 'dirty'
  /** 正在落库 */
  | 'saving'
  /** 落库失败 —— 必须让用户看见，这是原实现最大的缺口 */
  | 'error'

/** 自动保存的防抖延迟（毫秒）。与正文编辑器、大纲字段原值一致。 */
export const AUTOSAVE_DEBOUNCE_MS = 1500

export interface SaveStatusText {
  /** 状态标签 */
  label: string
  /** 语气：决定颜色 */
  tone: 'neutral' | 'pending' | 'success' | 'danger'
  /** 补充说明；无则不显示 */
  hint?: string
}

/**
 * 状态 → 文案。
 *
 * 按契约分别措辞，因为**同一个 `dirty` 在三类契约下含义完全不同**：
 * autosave 下是「马上会自动存」，explicit 下是「你必须点按钮否则会丢」。
 * 用同一句话说这两件事正是原实现让人搞不清的根源。
 */
export function describeSaveState(
  contract: SaveContract,
  state: SaveState,
  errorMessage?: string,
): SaveStatusText {
  if (state === 'saving') {
    return { label: '保存中…', tone: 'pending' }
  }
  if (state === 'error') {
    return {
      label: '保存失败',
      tone: 'danger',
      // 静默失败是原实现最大的问题（大纲字段只 console.error），
      // 这里强制给出可见原因
      hint: errorMessage || '请检查网络后重试；离开此页可能丢失改动',
    }
  }

  switch (contract) {
    case 'autosave':
      return state === 'dirty'
        ? { label: '未保存', tone: 'pending', hint: '停止输入后自动保存' }
        : { label: '已保存', tone: 'success' }

    case 'explicit':
      return state === 'dirty'
        // 这句必须说清后果：explicit 契约下不点按钮真的会丢
        ? { label: '有未保存修改', tone: 'pending', hint: '需点击保存，否则切换后丢失' }
        : { label: '已保存', tone: 'success' }

    case 'immediate':
      // 即时契约没有中间态，dirty 不该出现；出现说明调用方用错了契约
      return { label: '已保存', tone: 'success' }
  }
}

/**
 * 离开当前编辑目标前是否需要先落库。
 *
 * autosave 契约必须 flush —— 否则防抖窗口内的改动会随组件卸载消失，
 * 这正是「创作完成后编辑器显示已保存但内容其实没入库」那类问题的来源。
 * explicit 契约不自动落库（那会违背"必须确认"的语义），但调用方应当拦下切换并提示。
 */
export function needsFlushBeforeLeaving(contract: SaveContract, state: SaveState): boolean {
  return contract === 'autosave' && state === 'dirty'
}

/**
 * 离开时是否应当拦下并让用户确认。
 *
 * explicit 契约下有未保存改动就必须拦 —— 静默丢弃用户手输的内容是最糟的结果。
 */
export function shouldBlockLeaving(contract: SaveContract, state: SaveState): boolean {
  return contract === 'explicit' && state === 'dirty'
}

/** 各契约的用户可见说明，用于在界面上解释「这里怎么保存」 */
export const SAVE_CONTRACT_DESCRIPTION: Record<SaveContract, string> = {
  autosave: '自动保存：停止输入 1.5 秒后落库，切换章节或离开时立即落库',
  explicit: '手动保存：修改后需点击「保存修改」，未保存的改动在切换实体时会丢失',
  immediate: '即时生效：拖拽与双击操作直接写入，无需保存',
}
