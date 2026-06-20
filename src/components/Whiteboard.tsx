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
// default AI writing is chalk-dark; the model picks clay/sage/red for emphasis
const mapColor = (name?: string) => (name && COLOR_MAP[name.toLowerCase()]) || INK

interface Props {
  tool: Tool
  color: string
  width: number
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void
}

let idSeq = 0
const uid = () => `el_${Date.now().toString(36)}_${idSeq++}`

// ------------------------------------------------------------ geometry
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
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function elementInLasso(el: Element, poly: Point[]): boolean {
  const b = bbox(el)
  const corners: Point[] = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x, y: b.y + b.h },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x + b.w / 2, y: b.y + b.h / 2 },
  ]
  return corners.some((c) => pointInPolygon(c, poly))
}

function translate(el: Element, dx: number, dy: number): Element {
  if (el.type === 'path') {
    return { ...el, points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  }
  if (el.type === 'line' || el.type === 'arrow') {
    return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy }
  }
  if (el.type === 'text' || el.type === 'rect' || el.type === 'ellipse' || el.type === 'highlight') {
    return { ...el, x: el.x + dx, y: el.y + dy }
  }
  return el
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
      const prev = el.points[i - 1]
      const cur = el.points[i]
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
    if (el.author === 'ai') {
      // AI writes in a chalk/handwriting face — Caveat runs small, so scale up
      ctx.font = `600 ${Math.round(el.size * 1.25)}px 'Caveat', cursive`
    } else {
      ctx.font = `600 ${el.size}px 'Inter', system-ui, sans-serif`
    }
    ctx.fillText(el.text, el.x, el.y)
  }
}

function drawAll(ctx: CanvasRenderingContext2D, els: Element[]) {
  for (const el of els) drawElement(ctx, el)
}

// ------------------------------------------------------------ component
const Whiteboard = forwardRef<WhiteboardHandle, Props>(function Whiteboard(
  { tool, color, width, onHistoryChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0 })

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

  // AI draw-on reveal animation
  const revealIdsRef = useRef<Set<string>>(new Set())
  const revealAlphaRef = useRef(1)
  const revealRafRef = useRef<number | null>(null)

  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null)

  const notifyHistory = useCallback(() => {
    onHistoryChange(pastRef.current.length > 0, futureRef.current.length > 0)
  }, [onHistoryChange])

  // ---- redraw the whole board (committed + live draft + lasso + selection)
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, sizeRef.current.w, sizeRef.current.h)

    for (const el of elementsRef.current) {
      ctx.globalAlpha = revealIdsRef.current.has(el.id) ? revealAlphaRef.current : 1
      drawElement(ctx, el)
    }
    ctx.globalAlpha = 1
    if (draftRef.current) drawElement(ctx, draftRef.current)

    // selection halos
    if (selectedRef.current.size) {
      ctx.save()
      ctx.strokeStyle = CLAY
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      for (const el of elementsRef.current) {
        if (selectedRef.current.has(el.id)) {
          const b = bbox(el)
          ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12)
        }
      }
      ctx.restore()
    }

    // lasso outline
    if (lassoRef.current && lassoRef.current.length > 1) {
      ctx.save()
      ctx.strokeStyle = INK
      ctx.fillStyle = 'oklch(61% 0.115 42 / 0.10)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(lassoRef.current[0].x, lassoRef.current[0].y)
      for (const p of lassoRef.current.slice(1)) ctx.lineTo(p.x, p.y)
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

  // ---- history ops
  const commit = useCallback(
    (next: Element[], prev: Element[]) => {
      pastRef.current.push(prev)
      if (pastRef.current.length > 120) pastRef.current.shift()
      futureRef.current = []
      setElements(next)
      notifyHistory()
    },
    [notifyHistory],
  )

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

  // ---- fade-in animation for freshly drawn AI elements
  const animateReveal = useCallback(
    (ids: string[]) => {
      revealIdsRef.current = new Set(ids)
      revealAlphaRef.current = 0
      const start = performance.now()
      const DUR = 450
      if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current)
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / DUR)
        revealAlphaRef.current = p
        redraw()
        if (p < 1) {
          revealRafRef.current = requestAnimationFrame(tick)
        } else {
          revealIdsRef.current = new Set()
          revealRafRef.current = null
        }
      }
      revealRafRef.current = requestAnimationFrame(tick)
    },
    [redraw],
  )

  useEffect(() => {
    return () => {
      if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current)
    }
  }, [])

  // ---- render AI drawing instructions as real board elements
  const applyAIActions = useCallback(
    (actions: AIAction[]): number => {
      const { w, h } = sizeRef.current
      const clampX = (v: number) => Math.max(0, Math.min(w || 9999, v))
      const clampY = (v: number) => Math.max(0, Math.min(h || 9999, v))
      const made: Element[] = []

      for (const a of actions) {
        if (!a || typeof a.kind !== 'string') continue
        const id = uid()
        if (a.kind === 'text' && typeof a.text === 'string' && a.text.trim()) {
          made.push({
            id, type: 'text', author: 'ai', color: mapColor(a.color), width: 3,
            x: clampX(a.x), y: clampY(a.y), text: a.text, size: a.size && a.size > 8 ? a.size : 26,
          })
        } else if (a.kind === 'line' || a.kind === 'arrow') {
          made.push({
            id, type: a.kind, author: 'ai', color: mapColor(a.color), width: 3,
            x1: clampX(a.x1), y1: clampY(a.y1), x2: clampX(a.x2), y2: clampY(a.y2),
          })
        } else if (a.kind === 'rect' || a.kind === 'ellipse') {
          made.push({
            id, type: a.kind, author: 'ai', color: mapColor(a.color), width: 3,
            x: clampX(a.x), y: clampY(a.y), w: a.w, h: a.h,
          })
        } else if (a.kind === 'highlight') {
          made.push({
            id, type: 'highlight', author: 'ai', color: COLOR_MAP.yellow, width: 2,
            x: clampX(a.x), y: clampY(a.y), w: a.w, h: a.h,
          })
        }
      }

      if (!made.length) return 0
      const prev = elementsRef.current
      pastRef.current.push(prev)
      if (pastRef.current.length > 120) pastRef.current.shift()
      futureRef.current = []
      setElements([...prev, ...made])
      notifyHistory()
      animateReveal(made.map((m) => m.id))
      return made.length
    },
    [notifyHistory, animateReveal],
  )

  // ---- imperative handle (export, used by chat panel)
  useImperativeHandle(
    ref,
    (): WhiteboardHandle => ({
      isEmpty: () => elementsRef.current.length === 0,
      undo,
      redo,
      clear,
      applyAIActions,
      getBoardMeta: (): BoardMeta => {
        const { w, h } = sizeRef.current
        const els = elementsRef.current
        let content: BoardMeta['content'] = null
        if (els.length) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
          for (const el of els) {
            const b = bbox(el)
            minX = Math.min(minX, b.x)
            minY = Math.min(minY, b.y)
            maxX = Math.max(maxX, b.x + b.w)
            maxY = Math.max(maxY, b.y + b.h)
          }
          content = {
            x: Math.round(minX), y: Math.round(minY),
            w: Math.round(maxX - minX), h: Math.round(maxY - minY),
          }
        }
        return { width: Math.round(w), height: Math.round(h), content }
      },
      getImageDataURL: () => {
        const { w, h } = sizeRef.current
        if (!w || !h) return null
        const scale = 2
        const off = document.createElement('canvas')
        off.width = w * scale
        off.height = h * scale
        const ctx = off.getContext('2d')
        if (!ctx) return null
        ctx.scale(scale, scale)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        drawAll(ctx, elementsRef.current)
        return off.toDataURL('image/png')
      },
    }),
  )

  // ---- clear selection when leaving lasso tool
  useEffect(() => {
    if (tool !== 'lasso' && selectedRef.current.size) setSelected(new Set())
  }, [tool])

  // ---- pointer position in CSS px
  const pos = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (textInput) return
    const p = pos(e)
    try {
      canvasRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* no active pointer (e.g. synthetic events) */
    }

    if (tool === 'text') {
      setTextInput({ x: p.x, y: p.y, value: '' })
      return
    }

    if (tool === 'pen') {
      draftRef.current = { id: uid(), type: 'path', color, width, points: [p] }
      redraw()
      return
    }

    if (tool === 'eraser') {
      eraseSnapshotRef.current = elementsRef.current
      const survivors = elementsRef.current.filter((el) => !hitsElement(el, p, Math.max(8, width * 1.5)))
      if (survivors.length !== elementsRef.current.length) setElements(survivors)
      return
    }

    if (tool === 'rect' || tool === 'ellipse') {
      draftRef.current = { id: uid(), type: tool, color, width, x: p.x, y: p.y, w: 0, h: 0 }
      return
    }

    if (tool === 'lasso') {
      // drag existing selection if grabbing inside its bbox
      if (selectedRef.current.size) {
        const grabbing = elementsRef.current.some(
          (el) => selectedRef.current.has(el.id) && hitsElement(el, p, 10),
        )
        if (grabbing) {
          dragRef.current = { last: p }
          eraseSnapshotRef.current = elementsRef.current
          return
        }
      }
      setSelected(new Set())
      lassoRef.current = [p]
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pos(e)

    if (tool === 'pen' && draftRef.current?.type === 'path') {
      draftRef.current.points.push(p)
      redraw()
      return
    }

    if (tool === 'eraser' && e.buttons === 1) {
      const survivors = elementsRef.current.filter((el) => !hitsElement(el, p, Math.max(8, width * 1.5)))
      if (survivors.length !== elementsRef.current.length) setElements(survivors)
      return
    }

    if ((tool === 'rect' || tool === 'ellipse') && draftRef.current && 'w' in draftRef.current) {
      draftRef.current.w = p.x - draftRef.current.x
      draftRef.current.h = p.y - draftRef.current.y
      redraw()
      return
    }

    if (tool === 'lasso') {
      if (dragRef.current) {
        const dx = p.x - dragRef.current.last.x
        const dy = p.y - dragRef.current.last.y
        dragRef.current.last = p
        setElements((prev) =>
          prev.map((el) => (selectedRef.current.has(el.id) ? translate(el, dx, dy) : el)),
        )
        return
      }
      if (lassoRef.current) {
        lassoRef.current.push(p)
        redraw()
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* pointer may not be captured */
    }

    if ((tool === 'pen' || tool === 'rect' || tool === 'ellipse') && draftRef.current) {
      const draft = draftRef.current
      draftRef.current = null
      // ignore zero-size shapes
      if ((draft.type === 'rect' || draft.type === 'ellipse') && Math.abs(draft.w) < 3 && Math.abs(draft.h) < 3) {
        redraw()
        return
      }
      commit([...elementsRef.current, draft], elementsRef.current)
      return
    }

    if (tool === 'eraser' && eraseSnapshotRef.current) {
      const before = eraseSnapshotRef.current
      eraseSnapshotRef.current = null
      if (before.length !== elementsRef.current.length) {
        const after = elementsRef.current
        pastRef.current.push(before)
        futureRef.current = []
        elementsRef.current = after
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
          const ids = new Set(
            elementsRef.current.filter((el) => elementInLasso(el, poly)).map((el) => el.id),
          )
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
        id: uid(),
        type: 'text',
        color,
        width,
        x: textInput.x,
        y: textInput.y,
        text: value,
        size: Math.max(18, width * 7),
      }
      commit([...elementsRef.current, el], elementsRef.current)
    }
    setTextInput(null)
  }

  // keyboard: delete selection, ctrl+z / ctrl+shift+z
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current.size) {
        e.preventDefault()
        commit(
          elementsRef.current.filter((el) => !selectedRef.current.has(el.id)),
          elementsRef.current,
        )
        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, commit])

  const cursor =
    tool === 'pen'
      ? 'crosshair'
      : tool === 'eraser'
        ? 'cell'
        : tool === 'text'
          ? 'text'
          : tool === 'lasso'
            ? 'pointer'
            : 'crosshair'

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
      {textInput && (
        <input
          className="wb__textinput"
          autoFocus
          value={textInput.value}
          style={{
            left: textInput.x,
            top: textInput.y - Math.max(18, width * 7),
            color,
            fontSize: Math.max(18, width * 7),
          }}
          onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
            if (e.key === 'Escape') setTextInput(null)
          }}
          placeholder="type…"
        />
      )}
      {elements.length === 0 && !textInput && (
        <div className="wb__empty">
          <span className="wb__empty-badge">EMPTY BOARD</span>
          <p>Draw your problem. Then hit <b>ASK FERBAI →</b> and the AI reads your board to guide the next step.</p>
        </div>
      )}
    </div>
  )
})

export default Whiteboard
