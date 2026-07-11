declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string
    [key: string]: unknown
  }

  export class JSDOM {
    constructor(html?: string | Buffer, options?: JSDOMOptions)
    readonly window: Window & typeof globalThis
  }
}
