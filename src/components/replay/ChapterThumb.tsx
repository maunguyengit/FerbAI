import { useEffect, useRef } from 'react'
import { sceneAt, type Recording } from '../../lib/recording/types'
import { contentBoundsOf, drawAll } from '../../lib/render'

// A tiny thumbnail of the board/scene at a given timestamp, for the chapter list.
export default function ChapterThumb({ rec, t }: { rec: Recording; t: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const W = 72, H = 46, dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr; canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#f5f2ea'
    ctx.fillRect(0, 0, W, H)

    const scene = sceneAt(rec, t)
    if (scene.view === 'board') {
      const b = contentBoundsOf(scene.elements)
      if (b) {
        const pad = 5
        const s = Math.min((W - 2 * pad) / Math.max(b.w, 1), (H - 2 * pad) / Math.max(b.h, 1), 3)
        ctx.save()
        ctx.translate((W - b.w * s) / 2 - b.x * s, (H - b.h * s) / 2 - b.y * s)
        ctx.scale(s, s)
        drawAll(ctx, scene.elements)
        ctx.restore()
      }
    } else {
      ctx.fillStyle = scene.view === 'graph' ? '#3e6bb0' : '#c4694a'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#fff'
      ctx.font = "700 10px 'JetBrains Mono', monospace"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(scene.view === 'graph' ? 'GRAPH' : 'LEARN', W / 2, H / 2)
    }
  }, [rec, t])

  return <canvas ref={ref} className="chapthumb" width={72} height={46} />
}
