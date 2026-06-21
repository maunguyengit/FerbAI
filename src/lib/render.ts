// Pure element rendering + geometry, shared by the live Whiteboard and the
// playback canvas so a recording replays pixel-identically.

import type { Element } from './types'

export function bbox(el: Element): { x: number; y: number; w: number; h: number } {
  if (el.type === 'path') {
    const xs = el.points.map((p) => p.x)
    const ys = el.points.map((p) => p.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  if (el.type === 'text') {
    return { x: el.x, y: el.y - el.size, w: el.text.length * el.size * 0.6 + 8, h: el.size * 1.4 }
  }
  if (el.type === 'line' || el.type === 'arrow') {
    const x = Math.min(el.x1, el.x2)
    const y = Math.min(el.y1, el.y2)
    return { x, y, w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) }
  }
  if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'highlight') {
    const x = Math.min(el.x, el.x + el.w)
    const y = Math.min(el.y, el.y + el.h)
    return { x, y, w: Math.abs(el.w), h: Math.abs(el.h) }
  }
  return { x: 0, y: 0, w: 0, h: 0 }
}

export function contentBoundsOf(els: Element[]): { x: number; y: number; w: number; h: number } | null {
  if (!els.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of els) {
    const b = bbox(el)
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function drawElement(ctx: CanvasRenderingContext2D, el: Element) {
  ctx.strokeStyle = el.color
  ctx.fillStyle = el.color
  ctx.lineWidth = el.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (el.type === 'path') {
    if (el.points.length === 1) {
      ctx.beginPath()
      ctx.arc(el.points[0].x, el.points[0].y, el.width / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    ctx.beginPath()
    ctx.moveTo(el.points[0].x, el.points[0].y)
    for (let i = 1; i < el.points.length; i++) {
      const prev = el.points[i - 1], cur = el.points[i]
      ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + cur.x) / 2, (prev.y + cur.y) / 2)
    }
    ctx.stroke()
  } else if (el.type === 'line' || el.type === 'arrow') {
    ctx.beginPath()
    ctx.moveTo(el.x1, el.y1)
    ctx.lineTo(el.x2, el.y2)
    ctx.stroke()
    if (el.type === 'arrow') {
      const ang = Math.atan2(el.y2 - el.y1, el.x2 - el.x1)
      const head = Math.max(10, el.width * 3)
      ctx.beginPath()
      ctx.moveTo(el.x2, el.y2)
      ctx.lineTo(el.x2 - head * Math.cos(ang - 0.4), el.y2 - head * Math.sin(ang - 0.4))
      ctx.moveTo(el.x2, el.y2)
      ctx.lineTo(el.x2 - head * Math.cos(ang + 0.4), el.y2 - head * Math.sin(ang + 0.4))
      ctx.stroke()
    }
  } else if (el.type === 'highlight') {
    const a = ctx.globalAlpha
    ctx.globalAlpha = a * 0.22
    ctx.fillStyle = el.color
    ctx.fillRect(el.x, el.y, el.w, el.h)
    ctx.globalAlpha = a
    ctx.strokeStyle = el.color
    ctx.lineWidth = 2
    ctx.strokeRect(el.x, el.y, el.w, el.h)
  } else if (el.type === 'rect') {
    ctx.strokeRect(el.x, el.y, el.w, el.h)
  } else if (el.type === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (el.type === 'text') {
    ctx.textBaseline = 'alphabetic'
    ctx.font = el.author === 'ai'
      ? `600 ${Math.round(el.size * 1.25)}px 'Caveat', cursive`
      : `600 ${el.size}px 'Inter', system-ui, sans-serif`
    ctx.fillText(el.text, el.x, el.y)
  }
}

export function drawAll(ctx: CanvasRenderingContext2D, els: Element[]) {
  for (const el of els) drawElement(ctx, el)
}
