import { useEffect, useRef } from 'react'
import type { Element } from '../../lib/types'
import { drawAll } from '../../lib/render'

interface Props {
  elements: Element[]
  /** stable world-bounds of the whole recording, so the camera never jumps */
  bounds: { x: number; y: number; w: number; h: number } | null
  /** AI "ask" annotations drawn over the frozen board (blue), with a fade alpha */
  annotations?: Element[]
  annotationAlpha?: number
}

const GRID = 'oklch(87% 0.012 88)'
const GRID_AXIS = 'oklch(80% 0.014 88)'

export default function PlaybackCanvas({ elements, bounds, annotations, annotationAlpha = 1 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
  const camRef = useRef({ s: 1, px: 0, py: 0 })
  const elementsRef = useRef<Element[]>(elements)
  elementsRef.current = elements
  const annRef = useRef<Element[] | undefined>(annotations)
  annRef.current = annotations
  const annAlphaRef = useRef(annotationAlpha)
  annAlphaRef.current = annotationAlpha

  const recomputeCamera = () => {
    const { w, h } = sizeRef.current
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) { camRef.current = { s: 1, px: w / 2, py: h / 2 }; return }
    const pad = 36
    const s = Math.max(0.05, Math.min(3, Math.min((w - 2 * pad) / bounds.w, (h - 2 * pad) / bounds.h)))
    camRef.current = {
      s,
      px: (w - bounds.w * s) / 2 - bounds.x * s,
      py: (h - bounds.h * s) / 2 - bounds.y * s,
    }
  }

  const draw = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    const { w: vw, h: vh } = sizeRef.current
    const { s, px, py } = camRef.current

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(s * dpr, 0, 0, s * dpr, px * dpr, py * dpr)

    // grid
    const wl = -px / s, wt = -py / s, wr = (vw - px) / s, wb = (vh - py) / s
    let step = 28
    while (step * s < 14) step *= 2
    while (step * s > 90) step /= 2
    ctx.lineWidth = 1 / s
    ctx.strokeStyle = GRID
    ctx.beginPath()
    for (let x = Math.floor(wl / step) * step; x <= wr; x += step) { ctx.moveTo(x, wt); ctx.lineTo(x, wb) }
    for (let y = Math.floor(wt / step) * step; y <= wb; y += step) { ctx.moveTo(wl, y); ctx.lineTo(wr, y) }
    ctx.stroke()
    ctx.lineWidth = 1.6 / s
    ctx.strokeStyle = GRID_AXIS
    ctx.beginPath()
    ctx.moveTo(0, wt); ctx.lineTo(0, wb); ctx.moveTo(wl, 0); ctx.lineTo(wr, 0)
    ctx.stroke()

    drawAll(ctx, elementsRef.current)

    // AI "ask" annotations on top, in blue, with fade alpha
    const anns = annRef.current
    if (anns && anns.length) {
      ctx.globalAlpha = annAlphaRef.current
      drawAll(ctx, anns)
      ctx.globalAlpha = 1
    }
  }

  // size to container
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const apply = () => {
      const rect = wrap.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { w: rect.width, h: rect.height }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      recomputeCamera()
      draw()
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // recompute camera when the recording (bounds) changes
  useEffect(() => { recomputeCamera(); draw() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [bounds])

  // redraw whenever the visible elements or annotations change
  useEffect(() => { draw() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [elements, annotations, annotationAlpha])

  return (
    <div className="pbcanvas" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}
