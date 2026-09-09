export type DesignBoardPresetCategory = 'social' | 'general' | 'print' | 'custom'

export interface DesignBoardPreset {
  id: string
  label: string
  category: Exclude<DesignBoardPresetCategory, 'custom'>
  width: number
  height: number
}

export const DESIGN_BOARD_PRESETS: readonly DesignBoardPreset[] = [
  { id: 'xhs-portrait', label: '小红书竖图 3:4', category: 'social', width: 1080, height: 1440 },
  { id: 'xhs-square', label: '小红书方图 1:1', category: 'social', width: 1080, height: 1080 },
  {
    id: 'vertical-video',
    label: '抖音/竖屏视频 9:16',
    category: 'social',
    width: 1080,
    height: 1920
  },
  { id: 'wechat-cover', label: '公众号首图', category: 'social', width: 900, height: 383 },
  { id: 'x-post', label: 'X/横版帖子', category: 'social', width: 1200, height: 675 },
  { id: 'video-cover', label: '横版视频封面 16:9', category: 'general', width: 1280, height: 720 },
  { id: 'hd', label: 'HD 16:9', category: 'general', width: 1920, height: 1080 },
  { id: 'a4-poster', label: 'A4 海报 @300dpi', category: 'print', width: 2480, height: 3508 }
] as const

export const DEFAULT_DESIGN_BOARD_PRESET_ID = 'xhs-portrait'

export function findDesignBoardPreset(id: string): DesignBoardPreset | undefined {
  return DESIGN_BOARD_PRESETS.find((preset) => preset.id === id)
}
