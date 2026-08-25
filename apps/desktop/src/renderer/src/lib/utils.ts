import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// main.css @theme 里的自定义字号（text-nano/micro/caption/body/heading/display）
// 必须注册进 font-size 组：否则 tailwind-merge 会把它们当成文字色，
// 与 text-primary-foreground / text-hint 等互相冲突吞类（黑底按钮黑字、提示色丢失的根源）。
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'heading', 'body', 'caption', 'micro', 'nano'] }]
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
