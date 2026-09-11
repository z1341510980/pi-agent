import type { Tour, TourId } from '../types'
import { homeTour } from './home-tour'
import { novelTour } from './novel-tour'
import { chatTour } from './chat-tour'
import { settingsTour } from './settings-tour'
import { shortcutsTour } from './shortcuts-tour'
import { canvasTour } from './canvas-tour'

export const tours: Record<TourId, Tour> = {
  'home-tour': homeTour,
  'novel-tour': novelTour,
  'chat-tour': chatTour,
  'settings-tour': settingsTour,
  'shortcuts-tour': shortcutsTour,
  'canvas-tour': canvasTour,
}
