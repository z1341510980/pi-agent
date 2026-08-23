/**
 * Host-owned registry for plugin background work observation.
 *
 * The registry deliberately exposes observation only. It does not start,
 * cancel, or otherwise control work owned by a plugin.
 */
export interface BackgroundWorkItem {
  id: string
  [key: string]: unknown
}

export interface BackgroundWorkProvider {
  listActive(): BackgroundWorkItem[]
}

export class BackgroundWorkRegistry {
  private readonly providers = new Map<string, BackgroundWorkProvider>()

  register(name: string, provider: BackgroundWorkProvider): () => void {
    const previous = this.providers.get(name)
    this.providers.set(name, provider)
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.providers.get(name) === provider) {
        if (previous) this.providers.set(name, previous)
        else this.providers.delete(name)
      }
    }
  }

  listActive(): BackgroundWorkItem[] {
    const result: BackgroundWorkItem[] = []
    for (const [providerName, provider] of this.providers) {
      try {
        for (const item of provider.listActive()) {
          result.push({ provider: providerName, ...item })
        }
      } catch {
        // Observation must not take down the host because one provider failed.
      }
    }
    return result
  }
}
