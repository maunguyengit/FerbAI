// Render a set of board elements to a PNG for the AI, and return the mapping
// (origin + scale) so the AI's pixel coordinates can be converted back to world
// coordinates for the blue annotation overlay.

import { contentBoundsOf, drawAll } from '../render'
import type { Element } from '../types'

export interface SnapshotResult {
  dataUrl: string
  originX: number
  originY: number
  scale: number // image px per world px
}

export function snapshotScene(elements: Element[]): SnapshotResult | null {
  const b = contentBoundsOf(elements)
  if (!b) return null
  const pad = 64
  const wx = b.x - pad, wy = b.y - pad, ww = b.w + 2 * pad, wh = b.h + 2 * pad
  const maxDim = 1400
  const scale = Math.max(0.4, Math.min(2, maxDim / Math.max(ww, wh)))

  const off = document.createElement('canvas')
  off.width = Math.round(ww * scale)
  off.height = Math.round(wh * scale)
  const ctx = off.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)
  ctx.translate(-wx, -wy)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(wx, wy, ww, wh)
  drawAll(ctx, elements)

  return { dataUrl: off.toDataURL('image/png'), originX: wx, originY: wy, scale }
}
