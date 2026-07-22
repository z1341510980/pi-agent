export interface SubtrackPopoverPoint {
  x: number
  y: number
}

export interface SubtrackPopoverSize {
  width: number
  height: number
}

export interface SubtrackPopoverViewport {
  width: number
  height: number
}

export function computeSubtrackPopoverPosition(
  anchor: SubtrackPopoverPoint,
  size: SubtrackPopoverSize,
  viewport: SubtrackPopoverViewport,
): { left: number; top: number } {
  return {
    left: Math.max(12, Math.min(anchor.x + 12, viewport.width - size.width - 52)),
    top: Math.max(12, Math.min(anchor.y + 12, viewport.height - size.height - 52)),
  }
}
