import { type TargetPlatform } from '@/api/novel-client'

// ── 风格模板预设 ──

export interface StyleTemplate {
  id: string
  name: string
  description: string
  emoji: string
  platform: TargetPlatform | null
  rhythmModelId: string
  targetWords: string
  genre: string
}

export const STYLE_TEMPLATES: StyleTemplate[] = [
  {
    id: 'fanqie',
    name: '番茄爽文',
    description: '节奏快、爽感强，每章必有小高潮',
    emoji: '🔥',
    platform: 'fanqie',
    rhythmModelId: 'webnovel',
    targetWords: '2000000',
    genre: '玄幻',
  },
  {
    id: 'qidian',
    name: '起点精品',
    description: '世界观完整、伏笔系统性强',
    emoji: '📚',
    platform: 'qidian',
    rhythmModelId: 'default',
    targetWords: '1000000',
    genre: '玄幻',
  },
  {
    id: 'zhihu',
    name: '知乎短篇',
    description: '开篇抓人、反转精巧、篇幅精炼',
    emoji: '✍️',
    platform: 'zhihu_yanyan',
    rhythmModelId: 'default',
    targetWords: '50000',
    genre: '悬疑',
  },
  {
    id: 'custom',
    name: '自定义',
    description: '不预设，手动填写所有字段',
    emoji: '⚙️',
    platform: null,
    rhythmModelId: 'default',
    targetWords: '300000',
    genre: '',
  },
]
