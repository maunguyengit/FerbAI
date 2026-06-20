// Graph engine: turn equation strings into Plotly traces.
//
// Supports:
//   explicit 2D      y = x^2 + 9      ·  f(x) = ...      ·  bare "x^2+9"
//   explicit surface z = x^2 - y^2    ·  f(x,y) = ...
//   implicit 2D      x^2 + y^2 = 9    (curve)
//   implicit 3D      x^2+y^2+z^2 = 9  (surface — anything using z)
//
// Dimension is 3D if ANY equation references z or is z=f(x,y); otherwise 2D.
// In 3D mode, plain y=f(x) curves are lifted onto the z=0 plane.

import { compile } from 'mathjs'
import type { GraphDim, GraphEquation } from './types'

const DOMAIN = 10 // plot x,y,z over [-DOMAIN, DOMAIN]

export const PALETTE = [
  '#c4694a', // clay
  '#3e6bb0', // blue
  '#5b9c6b', // green
  '#9c6b47', // brown
  '#7a5ba6', // purple
  '#cda13a', // gold
  '#3e4c6b', // navy
  '#c0553c', // red
]

const NAMED: Record<string, string> = {
  clay: '#c4694a', terracotta: '#c4694a', accent: '#c4694a', orange: '#c4694a',
  sage: '#5b9c6b', green: '#5b9c6b',
  red: '#c0553c',
  blue: '#3e6bb0', navy: '#3e4c6b',
  brown: '#9c6b47', purple: '#7a5ba6', violet: '#7a5ba6',
  gold: '#cda13a', yellow: '#cda13a',
  ink: '#2c2823', black: '#2c2823',
}

export function resolveColor(name: string | undefined, index: number): string {
  if (name) {
    const n = name.toLowerCase().trim()
    if (NAMED[n]) return NAMED[n]
    if (/^#?[0-9a-f]{6}$/i.test(n)) return n.startsWith('#') ? n : `#${n}`
  }
  return PALETTE[index % PALETTE.length]
}

type Kind = 'explicit-y' | 'explicit-z' | 'implicit-2d' | 'implicit-3d' | 'empty' | 'invalid'

interface Parsed {
  kind: Kind
  expr: string // RHS for explicit; (lhs)-(rhs) for implicit
  reason?: string
}

const hasVar = (s: string, v: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])${v}([^A-Za-z0-9_]|$)`).test(s)

export function classify(raw: string): Parsed {
  const s = raw.trim()
  if (!s) return { kind: 'empty', expr: '' }
  const usesZ = hasVar(s, 'z')

  const eq = s.indexOf('=')
  if (eq < 0) {
    if (usesZ) return { kind: 'invalid', expr: s, reason: 'use "=" for a relation with z' }
    return { kind: 'explicit-y', expr: s }
  }
  const lhs = s.slice(0, eq).trim()
  const rhs = s.slice(eq + 1).trim()
  const lc = lhs.replace(/\s/g, '')

  if (lc === 'y') return usesZ ? { kind: 'invalid', expr: s, reason: 'y= cannot use z' } : { kind: 'explicit-y', expr: rhs }
  if (lc === 'z') return { kind: 'explicit-z', expr: rhs }
  if (lc === 'f(x)') return { kind: 'explicit-y', expr: rhs }
  if (lc === 'f(x,y)') return { kind: 'explicit-z', expr: rhs }

  const F = `(${lhs})-(${rhs})`
  return usesZ ? { kind: 'implicit-3d', expr: F } : { kind: 'implicit-2d', expr: F }
}

export function dimensionFor(equations: { raw: string; visible: boolean }[]): GraphDim {
  for (const e of equations) {
    if (!e.visible) continue
    const k = classify(e.raw).kind
    if (k === 'explicit-z' || k === 'implicit-3d') return '3d'
  }
  return '2d'
}

function linspace(a: number, b: number, n: number): number[] {
  const out = new Array(n)
  const step = (b - a) / (n - 1)
  for (let i = 0; i < n; i++) out[i] = a + i * step
  return out
}

function compileSafe(expr: string): ((scope: Record<string, number>) => number) | string {
  try {
    const c = compile(expr)
    // probe once to surface obvious syntax errors
    c.evaluate({ x: 1, y: 1, z: 1 })
    return (scope) => {
      try {
        const v = c.evaluate(scope)
        return typeof v === 'number' ? v : NaN
      } catch {
        return NaN
      }
    }
  } catch (e) {
    return e instanceof Error ? e.message : 'parse error'
  }
}

export interface BuiltPlot {
  data: unknown[]
  layout: Record<string, unknown>
  dim: GraphDim
  errors: Record<string, string> // equation id -> message
}

export function buildPlot(equations: GraphEquation[]): BuiltPlot {
  const dim = dimensionFor(equations)
  const data: unknown[] = []
  const errors: Record<string, string> = {}

  for (const eq of equations) {
    if (!eq.visible) continue
    const p = classify(eq.raw)
    if (p.kind === 'empty') continue
    if (p.kind === 'invalid') { errors[eq.id] = p.reason || 'invalid' ; continue }

    const fn = compileSafe(p.expr)
    if (typeof fn === 'string') { errors[eq.id] = fn; continue }

    if (p.kind === 'explicit-y') {
      const N = 600
      const xs = linspace(-DOMAIN, DOMAIN, N)
      const ys = xs.map((x) => {
        const v = fn({ x, y: 0, z: 0 })
        return Number.isFinite(v) ? v : null
      })
      if (dim === '2d') {
        data.push({ type: 'scatter', mode: 'lines', x: xs, y: ys, name: eq.raw,
          line: { color: eq.color, width: 3 }, connectgaps: false, hoverinfo: 'x+y' })
      } else {
        data.push({ type: 'scatter3d', mode: 'lines', x: xs, y: ys, z: xs.map(() => 0),
          name: eq.raw, line: { color: eq.color, width: 5 } })
      }
    } else if (p.kind === 'explicit-z') {
      const N = 60
      const xs = linspace(-DOMAIN, DOMAIN, N)
      const ys = linspace(-DOMAIN, DOMAIN, N)
      const zs = ys.map((y) => xs.map((x) => {
        const v = fn({ x, y, z: 0 })
        return Number.isFinite(v) ? v : null
      }))
      data.push({ type: 'surface', x: xs, y: ys, z: zs, name: eq.raw, showscale: false,
        colorscale: [[0, eq.color], [1, eq.color]], opacity: 0.92,
        contours: { z: { show: false } }, hoverinfo: 'x+y+z' })
    } else if (p.kind === 'implicit-2d') {
      const N = 200
      const xs = linspace(-DOMAIN, DOMAIN, N)
      const ys = linspace(-DOMAIN, DOMAIN, N)
      const zs = ys.map((y) => xs.map((x) => fn({ x, y, z: 0 })))
      data.push({ type: 'contour', x: xs, y: ys, z: zs, name: eq.raw, showscale: false,
        autocontour: false, contours: { start: 0, end: 0, size: 1, coloring: 'none' },
        line: { color: eq.color, width: 3 }, hoverinfo: 'skip' })
    } else if (p.kind === 'implicit-3d') {
      const N = 30
      const ax = linspace(-DOMAIN, DOMAIN, N)
      const X: number[] = [], Y: number[] = [], Z: number[] = [], V: number[] = []
      for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        X.push(ax[i]); Y.push(ax[j]); Z.push(ax[k])
        V.push(fn({ x: ax[i], y: ax[j], z: ax[k] }))
      }
      data.push({ type: 'isosurface', x: X, y: Y, z: Z, value: V, name: eq.raw,
        isomin: 0, isomax: 0, surface: { count: 1 }, showscale: false,
        colorscale: [[0, eq.color], [1, eq.color]], opacity: 0.85,
        caps: { x: { show: false }, y: { show: false }, z: { show: false } } })
    }
  }

  return { data, layout: buildLayout(dim), dim, errors }
}

const PAPER = '#f1eee7'
const INK = '#2c2823'
const GRID = '#d8d3c6'

function buildLayout(dim: GraphDim): Record<string, unknown> {
  const font = { family: 'JetBrains Mono, monospace', size: 11, color: INK }
  if (dim === '2d') {
    const axis = {
      range: [-DOMAIN, DOMAIN], zeroline: true, zerolinecolor: INK, zerolinewidth: 1.5,
      gridcolor: GRID, color: INK, ticks: 'outside' as const,
    }
    return {
      paper_bgcolor: PAPER, plot_bgcolor: PAPER, font, showlegend: false,
      margin: { l: 36, r: 12, t: 12, b: 28 },
      xaxis: { ...axis, title: '' },
      yaxis: { ...axis, title: '', scaleanchor: 'x', scaleratio: 1 },
    }
  }
  const sceneAxis = {
    range: [-DOMAIN, DOMAIN], gridcolor: GRID, color: INK,
    backgroundcolor: PAPER, showbackground: true, zerolinecolor: INK,
  }
  return {
    paper_bgcolor: PAPER, font, showlegend: false,
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      xaxis: { ...sceneAxis, title: 'x' },
      yaxis: { ...sceneAxis, title: 'y' },
      zaxis: { ...sceneAxis, title: 'z' },
      aspectmode: 'cube',
      camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } },
    },
  }
}

export const PLOT_CONFIG = {
  responsive: true,
  displimodebar: true,
  displaylogo: false,
  scrollZoom: true,
  modeBarButtonsToRemove: ['sendDataToCloud', 'toImage', 'select2d', 'lasso2d'],
}
