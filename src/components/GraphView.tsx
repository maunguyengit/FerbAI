import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import Plotly from 'plotly.js-dist-min'
import { buildPlot, classify, PALETTE, PLOT_CONFIG, resolveColor } from '../lib/graph'
import type { AIGraphEquation, GraphEquation, GraphHandle } from '../lib/types'
import type { GraphEqSnap } from '../lib/recording/types'
import './GraphView.css'

interface GraphProps {
  /** report equation changes so a recording can capture the graph window */
  onEquationsChange?: (eqs: GraphEqSnap[]) => void
}

let gid = 0
const uid = () => `g_${Date.now().toString(36)}_${gid++}`

const SAMPLES: { label: string; raw: string }[] = [
  { label: 'parabola', raw: 'y = x^2 + 9' },
  { label: 'cubic', raw: 'y = x^3 + 3x^2' },
  { label: 'sphere (3D)', raw: 'x^2 + y^2 + z^2 = 9' },
  { label: 'saddle (3D)', raw: 'z = x^2 - y^2' },
]

const GraphView = forwardRef<GraphHandle, GraphProps>(function GraphView({ onEquationsChange }, ref) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [equations, setEquations] = useState<GraphEquation[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const equationsRef = useRef<GraphEquation[]>([])
  equationsRef.current = equations
  const onEqChangeRef = useRef(onEquationsChange)
  onEqChangeRef.current = onEquationsChange

  // report the current equation set (raw + color) whenever it changes
  useEffect(() => {
    onEqChangeRef.current?.(equations.filter((e) => e.visible).map((e) => ({ raw: e.raw, color: e.color })))
  }, [equations])

  // (re)render the plot whenever equations change
  useEffect(() => {
    const el = plotRef.current
    if (!el) return
    const { data, layout, errors: errs } = buildPlot(equations)
    Plotly.react(el, data, layout, PLOT_CONFIG)
    setErrors((prev) => (sameErrors(prev, errs) ? prev : errs))
  }, [equations])

  // resize plot with its container
  useEffect(() => {
    const el = plotRef.current
    if (!el) return
    const ro = new ResizeObserver(() => Plotly.Plots.resize(el))
    ro.observe(el)
    return () => { ro.disconnect(); Plotly.purge(el) }
  }, [])

  const addRaw = (raw: string, color?: string, author?: 'ai' | 'user') => {
    const trimmed = raw.trim()
    if (!trimmed) return
    setEquations((prev) => [
      ...prev,
      { id: uid(), raw: trimmed, color: resolveColor(color, prev.length), visible: true, author, error: null },
    ])
  }

  const submitDraft = () => {
    if (!draft.trim()) return
    addRaw(draft)
    setDraft('')
  }

  const update = (id: string, raw: string) =>
    setEquations((prev) => prev.map((e) => (e.id === id ? { ...e, raw } : e)))
  const remove = (id: string) =>
    setEquations((prev) => prev.filter((e) => e.id !== id))
  const toggle = (id: string) =>
    setEquations((prev) => prev.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)))
  const cycleColor = (id: string) =>
    setEquations((prev) => prev.map((e) => {
      if (e.id !== id) return e
      const i = (PALETTE.indexOf(e.color) + 1) % PALETTE.length
      return { ...e, color: PALETTE[i] }
    }))

  useImperativeHandle(ref, (): GraphHandle => ({
    isEmpty: () => equationsRef.current.length === 0,
    getEquations: () => equationsRef.current.filter((e) => e.visible).map((e) => e.raw),
    getDimension: () =>
      equationsRef.current.some((e) => {
        const k = classify(e.raw).kind
        return e.visible && (k === 'explicit-z' || k === 'implicit-3d')
      }) ? '3d' : '2d',
    getImageDataURL: async () => {
      const el = plotRef.current
      if (!el) return null
      try {
        return await Plotly.toImage(el, { format: 'png', width: 760, height: 600 })
      } catch {
        return null
      }
    },
    addEquations: (eqs: AIGraphEquation[]) => {
      const clean = eqs.filter((e) => e && typeof e.eq === 'string' && e.eq.trim())
      if (!clean.length) return 0
      setEquations((prev) => {
        const base = prev.length
        const made = clean.map((e, i) => ({
          id: uid(), raw: e.eq.trim(), color: resolveColor(e.color, base + i),
          visible: true, author: 'ai' as const, error: null,
        }))
        return [...prev, ...made]
      })
      return clean.length
    },
  }))

  return (
    <div className="graph">
      <div className="graph__side">
        <div className="graph__head">
          <h3 className="graph__title">Graph</h3>
          {equations.length > 0 && (
            <button className="graph__clear" onClick={() => setEquations([])}>Clear</button>
          )}
        </div>

        <div className="graph__list">
          {equations.map((e) => (
            <div key={e.id} className={`eqrow ${errors[e.id] ? 'eqrow--err' : ''}`}>
              <button
                className="eqrow__dot"
                style={{ background: e.visible ? e.color : 'transparent', borderColor: e.color }}
                onClick={() => toggle(e.id)}
                onDoubleClick={() => cycleColor(e.id)}
                title="Click: show/hide · double-click: color"
                aria-label="toggle visibility"
              />
              <input
                className="eqrow__input"
                value={e.raw}
                spellCheck={false}
                onChange={(ev) => update(e.id, ev.target.value)}
              />
              {e.author === 'ai' && <span className="eqrow__ai" title="added by AI">✦</span>}
              <button className="eqrow__del" onClick={() => remove(e.id)} aria-label="delete">×</button>
              {errors[e.id] && <span className="eqrow__msg">{errors[e.id]}</span>}
            </div>
          ))}

          <div className="eqrow eqrow--add">
            <span className="eqrow__plus" aria-hidden>+</span>
            <input
              className="eqrow__input"
              value={draft}
              spellCheck={false}
              placeholder="f(x) = x^2 + 9"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitDraft() }}
              onBlur={submitDraft}
            />
          </div>

          {equations.length === 0 && (
            <div className="graph__samples">
              <span className="caption">try one</span>
              {SAMPLES.map((s) => (
                <button key={s.raw} className="graph__sample" onClick={() => addRaw(s.raw)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <p className="graph__hint caption">
          y=f(x) · z=f(x,y) · implicit like x²+y²+z²=9 · drag to rotate 3D
        </p>
      </div>

      <div className="graph__plot" ref={plotRef} />
    </div>
  )
})

function sameErrors(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => a[k] === b[k])
}

export default GraphView
