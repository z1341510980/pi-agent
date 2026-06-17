export interface ConfigLayers {
  global?: Record<string, unknown>
  project?: Record<string, unknown>
  session?: Record<string, unknown>
}

/**
 * ConfigCoordinator：三层配置合并
 *
 * 合并顺序：global → project → session
 * 后层覆盖前层的同名键
 */
export class ConfigCoordinator {
  private readonly layers: ConfigLayers

  constructor(layers: ConfigLayers) {
    this.layers = layers
  }

  /** 合并三层配置，返回最终配置 */
  resolve(): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    // 按优先级从低到高合并
    const { global, project, session } = this.layers

    if (global) {
      Object.assign(result, global)
    }
    if (project) {
      Object.assign(result, project)
    }
    if (session) {
      Object.assign(result, session)
    }

    return result
  }
}
