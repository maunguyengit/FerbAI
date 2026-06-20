import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import type { AIAction, BoardMeta, Element, Point, Tool, WhiteboardHandle } from '../lib/types'
import './Whiteboard.css'

// Named colors the AI can request, mapped to the Chalk OKLCH tokens.
const INK = 'oklch(27% 0.008 70)'
const CLAY = 'oklch(61% 0.115 42)'
const SAGE = 'oklch(66% 0.05 150)'
const GRID = 'oklch(87% 0.012 88)'
const GRID_AXIS = 'oklch(80% 0.014 88)'
const COLOR_MAP: Record<string, string> = {
  ink: INK,
  clay: CLAY,
  terracotta: CLAY,
  accent: CLAY,
  sage: SAGE,
  green: SAGE,
  red: 'oklch(56% 0.15 33)',
  yellow: 'oklch(80% 0.11 90)',
  brown: 'oklch(54% 0.07 55)',
  navy: 'oklch(42% 0.06 260)',
  blue: 'oklch(42% 0.06 260)',
}
const mapColor = (name?: string) => (name && COLOR_MAP[name.toLowerCase()]) || INK

const MIN_SCALE = 0.1
const MAX_SCALE = 8
const REGION_PAD = 64 // world px of padding around content in AI snapshots

interface Props {
  tool: Tool
  color: string
  width: number
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void
}

let idSeq = 0
const uid = () => `el_${Date.now().toString(36)}_${idSeq++}`

// ------------------------------------------------------------ geometry (world space)
function bbox(el: Element): { x: number; y: number; w: number; h: number } {
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

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function hitsElement(el: Element, p: Point, radius: number): boolean {
  if (el.type === 'path') {
    return el.points.some((pt) => dist(pt, p) < radius + el.width)
  }
  const b = bbox(el)
  return p.x >= b.x - radius && p.x <= b.x + b.w + radius && p.y >= b.y - radius && p.y <= b.y + b.h + radius
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function elementInLasso(el: Element, poly: Point[]): boolean {
  const b = bbox(el)
  const corners: Point[] = [
    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h },
    { x: b.x + b.w / 2, y: b.y + b.h / 2 },
  ]
  return corners.some((c) => pointInPolygon(c, poly))
}

function translate(el: Element, dx: number, dy: number): Element {
  if (el.type === 'path') return { ...el, points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  if (el.type === 'line' || el.type === 'arrow') return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy }
  if (el.type === 'text' || el.type === 'rect' || el.type === 'ellipse' || el.type === 'highlight') return { ...el, x: el.x + dx, y: el.y + dy }
  return el
}

function contentBoundsOf(els: Element[]): { x: number; y: number; w: number; h: number } | null {
  if (!els.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of els) {
    const b = bbox(el)
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// ------------------------------------------------------------ rendering
function drawElement(ctx: CanvasRenderingContext2D, el: Element) {
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

function drawAll(ctx: CanvasRenderingContext2D, els: Element[]) {
  for (const el of els) drawElement(ctx, el)
}

// infinite graph-paper grid in world space
function drawGrid(ctx: CanvasRenderingContext2D, vw: number, vh: number, s: number, px: number, py: number) {
  const wl = -px / s, wt = -py / s, wr = (vw - px) / s, wb = (vh - py) / s
  let step = 28
  while (step * s < 14) step *= 2
  while (step * s > 90) step /= 2
  if (step < 3.5) step = 3.5

  ctx.lineWidth = 1 / s
  ctx.strokeStyle = GRID
  ctx.beginPath()
  for (let x = Math.floor(wl / step) * step; x <= wr; x += step) { ctx.moveTo(x, wt); ctx.lineTo(x, wb) }
  for (let y = Math.floor(wt / step) * step; y <= wb; y += step) { ctx.moveTo(wl, y); ctx.lineTo(wr, y) }
  ctx.stroke()

  // origin axes slightly stronger
  ctx.lineWidth = 1.6 / s
  ctx.strokeStyle = GRID_AXIS
  ctx.beginPath()
  ctx.moveTo(0, wt); ctx.lineTo(0, wb)
  ctx.moveTo(wl, 0); ctx.lineTo(wr, 0)
  ctx.stroke()
}

// ------------------------------------------------------------ component
const Whiteboard = forwardRef<WhiteboardHandle, Props>(function Whiteboard(
  { tool, color, width, onHistoryChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0 })

  // camera (world -> screen: screen = world * scale + pan)
  const scaleRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const captureOriginRef = useRef({ x: 0, y: 0 })
  const spaceRef = useRef(false)
  const panningRef = useRef<{ x: number; y: number } | null>(null)

  const [elements, setElements] = useState<Element[]>([])
  const elementsRef = useRef<Element[]>([])
  elementsRef.current = elements

  const pastRef = useRef<Element[][]>([])
  const futureRef = useRef<Element[][]>([])

  const draftRef = useRef<Element | null>(null)
  const lassoRef = useRef<Point[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const dragRef = useRef<{ last: Point } | null>(null)
  const eraseSnapshotRef = useRef<Element[] | null>(null)

  const revealIdsRef = useRef<Set<string>>(new Set())
  const revealAlphaRef = useRef(1)
  const revealRafRef = useRef<number | null>(null)

  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null)

  const notifyHistory = useCallback(() => {
    onHistoryChange(pastRef.current.length > 0, futureRef.current.length > 0)
  }, [onHistoryChange])

  const worldToScreen = (wx: number, wy: number) => ({
    x: wx * scaleRef.current + panRef.current.x,
    y: wy * scaleRef.current + panRef.current.y,
  })

  // ---- redraw: camera transform, infinite grid, elements, then screen-space overlays
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    const { w: vw, h: vh } = sizeRef.current
    const s = scaleRef.current, px = panRef.current.x, py = panRef.current.y

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    ctx.setTransform(s * dpr, 0, 0, s * dpr, px * dpr, py * dpr)
    drawGrid(ctx, vw, vh, s, px, py)

    for (const el of elementsRef.current) {
      ctx.globalAlpha = revealIdsRef.current.has(el.id) ? revealAlphaRef.current : 1
      drawElement(ctx, el)
    }
    ctx.globalAlpha = 1
    if (draftRef.current) drawElement(ctx, draftRef.current)

    // overlays in screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    if (selectedRef.current.size) {
      ctx.save()
      ctx.strokeStyle = CLAY
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      for (const el of elementsRef.current) {
        if (!selectedRef.current.has(el.id)) continue
        const b = bbox(el)
        const tl = worldToScreen(b.x, b.y)
        const br = worldToScreen(b.x + b.w, b.y + b.h)
        ctx.strokeRect(tl.x - 6, tl.y - 6, br.x - tl.x + 12, br.y - tl.y + 12)
      }
      ctx.restore()
    }

    if (lassoRef.current && lassoRef.current.length > 1) {
      ctx.save()
      ctx.strokeStyle = INK
      ctx.fillStyle = 'oklch(61% 0.115 42 / 0.10)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      const p0 = worldToScreen(lassoRef.current[0].x, lassoRef.current[0].y)
      ctx.moveTo(p0.x, p0.y)
      for (const p of lassoRef.current.slice(1)) {
        const sp = worldToScreen(p.x, p.y)
        ctx.lineTo(sp.x, sp.y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }, [])

  useEffect(redraw, [elements, selected, redraw])

  // ---- size to container, HiDPI
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const apply = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { w: rect.width, h: rect.height }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      redraw()
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(container)
    return () => ro.disconnect()
  }, [redraw])

  // ---- camera ops
  const applyZoom = useCallback((target: number, cx: number, cy: number) => {
    const s0 = scaleRef.current
    const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, target))
    const wx = (cx - panRef.current.x) / s0
    const wy = (cy - panRef.current.y) / s0
    panRef.current = { x: cx - wx * ns, y: cy - wy * ns }
    scaleRef.current = ns
    setZoom(ns)
    redraw()
  }, [redraw])

  const panBy = useCallback((dx: number, dy: number) => {
    panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy }
    redraw()
  }, [redraw])

  const fitView = useCallback(() => {
    const { w: vw, h: vh } = sizeRef.current
    const b = contentBoundsOf(elementsRef.current)
    if (!b) {
      scaleRef.current = 1; panRef.current = { x: 0, y: 0 }; setZoom(1); redraw(); return
    }
    const pad = 80
    const s = Math.max(MIN_SCALE, Math.min(2, Math.min((vw - 2 * pad) / Math.max(b.w, 1), (vh - 2 * pad) / Math.max(b.h, 1))))
    panRef.current = { x: (vw - b.w * s) / 2 - b.x * s, y: (vh - b.h * s) / 2 - b.y * s }
    scaleRef.current = s; setZoom(s); redraw()
  }, [redraw])

  const resetView = useCallback(() => {
    scaleRef.current = 1; panRef.current = { x: 0, y: 0 }; setZoom(1); redraw()
  }, [redraw])

  // ---- wheel: pan (trackpad) / ctrl+wheel zoom (toward cursor)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        applyZoom(scaleRef.current * Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY)
      } else {
        panBy(-e.deltaX, -e.deltaY)
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [applyZoom, panBy])

  // ---- hold space to pan
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
      spaceRef.current = true
    }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceRef.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  // ---- history ops
  const commit = useCallback((next: Element[], prev: Element[]) => {
    pastRef.current.push(prev)
    if (pastRef.current.length > 120) pastRef.current.shift()
    futureRef.current = []
    setElements(next)
    notifyHistory()
  }, [notifyHistory])

  const undo = useCallback(() => {
    if (!pastRef.current.length) return
    const prev = pastRef.current.pop()!
    futureRef.current.push(elementsRef.current)
    setSelected(new Set())
    setElements(prev)
    notifyHistory()
  }, [notifyHistory])

  const redo = useCallback(() => {
    if (!futureRef.current.length) return
    const next = futureRef.current.pop()!
    pastRef.current.push(elementsRef.current)
    setSelected(new Set())
    setElements(next)
    notifyHistory()
  }, [notifyHistory])

  const clear = useCallback(() => {
    if (!elementsRef.current.length) return
    pastRef.current.push(elementsRef.current)
    futureRef.current = []
    setSelected(new Set())
    setElements([])
    notifyHistory()
  }, [notifyHistory])

  // ---- AI reveal animation
  const animateReveal = useCallback((ids: string[]) => {
    revealIdsRef.current = new Set(ids)
    revealAlphaRef.current = 0
    const start = performance.now()
    const DUR = 450
    if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current)
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DUR)
      revealAlphaRef.current = p
      redraw()
      if (p < 1) revealRafRef.current = requestAnimationFrame(tick)
      else { revealIdsRef.current = new Set(); revealRafRef.current = null }
    }
    revealRafRef.current = requestAnimationFrame(tick)
  }, [redraw])

  useEffect(() => () => { if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current) }, [])

  // ---- snapshot region (content bbox + padding) shared by image + meta
  const computeRegion = () => {
    const b = contentBoundsOf(elementsRef.current)
    if (!b) return null
    return { wx: b.x - REGION_PAD, wy: b.y - REGION_PAD, ww: b.w + 2 * REGION_PAD, wh: b.h + 2 * REGION_PAD, content: b }
  }

  // ---- render AI instructions. Incoming coords are relative to the snapshot
  //      region origin (what the AI saw); convert to world by adding that origin.
  const applyAIActions = useCallback((actions: AIAction[]): number => {
    const ox = captureOriginRef.current.x
    const oy = captureOriginRef.current.y
    const made: Element[] = []

    for (const a of actions) {
      if (!a || typeof a.kind !== 'string') continue
      const id = uid()
      if (a.kind === 'text' && typeof a.text === 'string' && a.text.trim()) {
        made.push({ id, type: 'text', author: 'ai', color: mapColor(a.color), width: 3,
          x: a.x + ox, y: a.y + oy, text: a.text, size: a.size && a.size > 8 ? a.size : 26 })
      } else if (a.kind === 'line' || a.kind === 'arrow') {
        made.push({ id, type: a.kind, author: 'ai', color: mapColor(a.color), width: 3,
          x1: a.x1 + ox, y1: a.y1 + oy, x2: a.x2 + ox, y2: a.y2 + oy })
      } else if (a.kind === 'rect' || a.kind === 'ellipse') {
        made.push({ id, type: a.kind, author: 'ai', color: mapColor(a.color), width: 3,
          x: a.x + ox, y: a.y + oy, w: a.w, h: a.h })
      } else if (a.kind === 'highlight') {
        made.push({ id, type: 'highlight', author: 'ai', color: COLOR_MAP.yellow, width: 2,
          x: a.x + ox, y: a.y + oy, w: a.w, h: a.h })
      }
    }

    if (!made.length) return 0
    const prev = elementsRef.current
    const next = [...prev, ...made]
    pastRef.current.push(prev)
    if (pastRef.current.length > 120) pastRef.current.shift()
    futureRef.current = []
    elementsRef.current = next
    setElements(next)
    notifyHistory()
    animateReveal(made.map((m) => m.id))
    fitView() // bring the AI's work into view
    return made.length
  }, [notifyHistory, animateReveal, fitView])

  // ---- imperative handle
  useImperativeHandle(ref, (): WhiteboardHandle => ({
    isEmpty: () => elementsRef.current.length === 0,
    undo, redo, clear, applyAIActions,
    getBoardMeta: (): BoardMeta => {
      const region = computeRegion()
      if (!region) {
        captureOriginRef.current = { x: 0, y: 0 }
        return { width: Math.round(sizeRef.current.w), height: Math.round(sizeRef.current.h), content: null }
      }
      captureOriginRef.current = { x: region.wx, y: region.wy }
      return {
        width: Math.round(region.ww),
        height: Math.round(region.wh),
        content: {
          x: Math.round(region.content.x - region.wx),
          y: Math.round(region.content.y - region.wy),
          w: Math.round(region.content.w),
          h: Math.round(region.content.h),
        },
      }
    },
    getImageDataURL: () => {
      const region = computeRegion()
      if (!region) return null
      const maxDim = 1500
      const outScale = Math.max(0.4, Math.min(2, maxDim / Math.max(region.ww, region.wh)))
      const off = document.createElement('canvas')
      off.width = Math.round(region.ww * outScale)
      off.height = Math.round(region.wh * outScale)
      const ctx = off.getContext('2d')
      if (!ctx) return null
      ctx.scale(outScale, outScale)
      ctx.translate(-region.wx, -region.wy)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(region.wx, region.wy, region.ww, region.wh)
      drawAll(ctx, elementsRef.current)
      return off.toDataURL('image/png')
    },
  }))

  useEffect(() => {
    if (tool !== 'lasso' && selectedRef.current.size) setSelected(new Set())
  }, [tool])

  // pointer -> world
  const pos = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left - panRef.current.x) / scaleRef.current,
      y: (e.clientY - rect.top - panRef.current.y) / scaleRef.current,
    }
  }

  const eraseRadius = () => Math.max(8, width * 1.5) / scaleRef.current

  const onPointerDown = (e: React.PointerEvent) => {
    // pan: middle mouse, space-held, or pan tool
    if (e.button === 1 || spaceRef.current || tool === 'pan') {
      panningRef.current = { x: e.clientX, y: e.clientY }
      try { canvasRef.current?.setPointerCapture(e.pointerId) } catch { /* synthetic */ }
      return
    }
    if (e.button !== 0) return
    if (textInput) return
    const p = pos(e)
    try { canvasRef.current?.setPointerCapture(e.pointerId) } catch { /* synthetic */ }

    if (tool === 'text') { setTextInput({ x: p.x, y: p.y, value: '' }); return }
    if (tool === 'pen') { draftRef.current = { id: uid(), type: 'path', color, width, points: [p] }; redraw(); return }
    if (tool === 'eraser') {
      eraseSnapshotRef.current = elementsRef.current
      const survivors = elementsRef.current.filter((el) => !hitsElement(el, p, eraseRadius()))
      if (survivors.length !== elementsRef.current.length) setElements(survivors)
      return
    }
    if (tool === 'rect' || tool === 'ellipse') {
      draftRef.current = { id: uid(), type: tool, color, width, x: p.x, y: p.y, w: 0, h: 0 }
      return
    }
    if (tool === 'lasso') {
      if (selectedRef.current.size) {
        const grabbing = elementsRef.current.some((el) => selectedRef.current.has(el.id) && hitsElement(el, p, 10 / scaleRef.current))
        if (grabbing) { dragRef.current = { last: p }; eraseSnapshotRef.current = elementsRef.current; return }
      }
      setSelected(new Set())
      lassoRef.current = [p]
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (panningRef.current) {
      const dx = e.clientX - panningRef.current.x
      const dy = e.clientY - panningRef.current.y
      panningRef.current = { x: e.clientX, y: e.clientY }
      panBy(dx, dy)
      return
    }
    const p = pos(e)

    if (tool === 'pen' && draftRef.current?.type === 'path') {
      draftRef.current.points.push(p); redraw(); return
    }
    if (tool === 'eraser' && e.buttons === 1) {
      const survivors = elementsRef.current.filter((el) => !hitsElement(el, p, eraseRadius()))
      if (survivors.length !== elementsRef.current.length) setElements(survivors)
      return
    }
    if ((tool === 'rect' || tool === 'ellipse') && draftRef.current && 'w' in draftRef.current) {
      draftRef.current.w = p.x - draftRef.current.x
      draftRef.current.h = p.y - draftRef.current.y
      redraw(); return
    }
    if (tool === 'lasso') {
      if (dragRef.current) {
        const dx = p.x - dragRef.current.last.x
        const dy = p.y - dragRef.current.last.y
        dragRef.current.last = p
        setElements((prev) => prev.map((el) => (selectedRef.current.has(el.id) ? translate(el, dx, dy) : el)))
        return
      }
      if (lassoRef.current) { lassoRef.current.push(p); redraw() }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    try { canvasRef.current?.releasePointerCapture(e.pointerId) } catch { /* */ }

    if (panningRef.current) { panningRef.current = null; return }

    if ((tool === 'pen' || tool === 'rect' || tool === 'ellipse') && draftRef.current) {
      const draft = draftRef.current
      draftRef.current = null
      if ((draft.type === 'rect' || draft.type === 'ellipse') && Math.abs(draft.w) < 3 && Math.abs(draft.h) < 3) { redraw(); return }
      commit([...elementsRef.current, draft], elementsRef.current)
      return
    }
    if (tool === 'eraser' && eraseSnapshotRef.current) {
      const before = eraseSnapshotRef.current
      eraseSnapshotRef.current = null
      if (before.length !== elementsRef.current.length) {
        pastRef.current.push(before)
        futureRef.current = []
        notifyHistory()
      }
      return
    }
    if (tool === 'lasso') {
      if (dragRef.current) {
        dragRef.current = null
        if (eraseSnapshotRef.current) {
          pastRef.current.push(eraseSnapshotRef.current)
          futureRef.current = []
          eraseSnapshotRef.current = null
          notifyHistory()
        }
        return
      }
      if (lassoRef.current) {
        const poly = lassoRef.current
        lassoRef.current = null
        if (poly.length > 2) {
          const ids = new Set(elementsRef.current.filter((el) => elementInLasso(el, poly)).map((el) => el.id))
          setSelected(ids)
        }
        redraw()
      }
    }
  }

  const commitText = () => {
    if (!textInput) return
    const value = textInput.value.trim()
    if (value) {
      const el: Element = {
        id: uid(), type: 'text', color, width,
        x: textInput.x, y: textInput.y, text: value, size: Math.max(18, width * 7),
      }
      commit([...elementsRef.current, el], elementsRef.current)
    }
    setTextInput(null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current.size) {
        e.preventDefault()
        commit(elementsRef.current.filter((el) => !selectedRef.current.has(el.id)), elementsRef.current)
        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, commit])

  const cursor = panningRef.current ? 'grabbing'
    : tool === 'pan' ? 'grab'
    : tool === 'eraser' ? 'cell'
    : tool === 'text' ? 'text'
    : tool === 'lasso' ? 'pointer'
    : 'crosshair'

  const textScreen = textInput ? worldToScreen(textInput.x, textInput.y) : null
  const textFont = Math.max(18, width * 7) * scaleRef.current

  return (
    <div className="wb" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="wb__canvas"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />
      {textInput && textScreen && (
        <input
          className="wb__textinput"
          autoFocus
          value={textInput.value}
          style={{ left: textScreen.x, top: textScreen.y - textFont, color, fontSize: textFont }}
          onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
          onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Enter') commitText(); if (e.key === 'Escape') setTextInput(null) }}
          placeholder="type…"
        />
      )}

      <div className="wb__zoom">
        <button onClick={() => applyZoom(scaleRef.current / 1.25, sizeRef.current.w / 2, sizeRef.current.h / 2)} title="Zoom out">−</button>
        <button className="wb__zoom-val" onClick={resetView} title="Reset to 100%">{Math.round(zoom * 100)}%</button>
        <button onClick={() => applyZoom(scaleRef.current * 1.25, sizeRef.current.w / 2, sizeRef.current.h / 2)} title="Zoom in">+</button>
        <button onClick={fitView} title="Fit to content">⤢</button>
      </div>

      {elements.length === 0 && !textInput && (
        <div className="wb__empty">
          <span className="wb__empty-badge">INFINITE BOARD</span>
          <p>Draw your problem — the canvas is endless. Scroll to pan, ⌘/Ctrl+scroll to zoom. Then ask the tutor to guide your next step.</p>
        </div>
      )}
    </div>
  )
})

export default Whiteboard
