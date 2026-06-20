import { useEffect, useMemo, useState } from 'react'
import type { VizWidgetProps } from '../../lib/viz/types'

// Interactive Binary Search Tree.
// spec.data: { values?: number[] }  — initial insert order.
//
// All interaction lives here; the AI only supplies the initial values + narration.

interface Node {
  id: number
  value: number
  left: Node | null
  right: Node | null
}

interface Frame {
  current: number | null      // node id being compared / visited
  visited: number[]           // node ids already visited
  caption: string
  seq?: number[]              // accumulated traversal output
  newId?: number              // node revealed at this frame (insert)
}

let nodeSeq = 1
const mk = (value: number): Node => ({ id: nodeSeq++, value, left: null, right: null })

function clone(n: Node | null): Node | null {
  return n ? { id: n.id, value: n.value, left: clone(n.left), right: clone(n.right) } : null
}

function insertValue(root: Node | null, value: number): { root: Node; path: number[]; newId: number } {
  const node = mk(value)
  if (!root) return { root: node, path: [], newId: node.id }
  const path: number[] = []
  let cur: Node = root
  for (;;) {
    path.push(cur.id)
    if (value < cur.value) {
      if (!cur.left) { cur.left = node; break }
      cur = cur.left
    } else {
      if (!cur.right) { cur.right = node; break }
      cur = cur.right
    }
  }
  return { root, path, newId: node.id }
}

function findValue(root: Node | null, value: number): { path: number[]; found: boolean } {
  const path: number[] = []
  let cur = root
  while (cur) {
    path.push(cur.id)
    if (value === cur.value) return { path, found: true }
    cur = value < cur.value ? cur.left : cur.right
  }
  return { path, found: false }
}

function removeValue(root: Node | null, value: number): Node | null {
  if (!root) return null
  if (value < root.value) { root.left = removeValue(root.left, value); return root }
  if (value > root.value) { root.right = removeValue(root.right, value); return root }
  if (!root.left) return root.right
  if (!root.right) return root.left
  let succ = root.right
  while (succ.left) succ = succ.left
  root.value = succ.value
  root.right = removeValue(root.right, succ.value)
  return root
}

function layout(root: Node | null): { pos: Record<number, { x: number; y: number }>; cols: number; rows: number } {
  const pos: Record<number, { x: number; y: number }> = {}
  let i = 0
  let maxDepth = 0
  const walk = (n: Node | null, d: number) => {
    if (!n) return
    walk(n.left, d + 1)
    pos[n.id] = { x: i++, y: d }
    maxDepth = Math.max(maxDepth, d)
    walk(n.right, d + 1)
  }
  walk(root, 0)
  return { pos, cols: i, rows: maxDepth + 1 }
}

function traverse(root: Node | null, order: 'in' | 'pre' | 'post'): { id: number; value: number }[] {
  const out: { id: number; value: number }[] = []
  const walk = (n: Node | null) => {
    if (!n) return
    if (order === 'pre') out.push({ id: n.id, value: n.value })
    walk(n.left)
    if (order === 'in') out.push({ id: n.id, value: n.value })
    walk(n.right)
    if (order === 'post') out.push({ id: n.id, value: n.value })
  }
  walk(root)
  return out
}

export default function BstWidget({ spec }: VizWidgetProps) {
  const initial = useMemo(() => {
    const vals = (spec.data?.values as number[] | undefined)?.filter((v) => typeof v === 'number')
    const list = vals && vals.length ? vals : [8, 3, 10, 1, 6, 14, 4, 7, 13]
    let root: Node | null = null
    for (const v of list) root = insertValue(root, v).root
    return root
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec])

  const [tree, setTree] = useState<Node | null>(initial)
  const [pre, setPre] = useState<Node | null>(initial)   // tree shown before a pending mutation commits
  const [frames, setFrames] = useState<Frame[]>([])
  const [idx, setIdx] = useState(0)
  const [committed, setCommitted] = useState<Node | null>(null) // applied at final frame
  const [input, setInput] = useState('5')
  const [playing, setPlaying] = useState(false)

  useEffect(() => { setTree(initial); setPre(initial); setFrames([]); setIdx(0) }, [initial])

  // autoplay
  useEffect(() => {
    if (!playing) return
    if (idx >= frames.length - 1) { setPlaying(false); return }
    const t = setTimeout(() => setIdx((i) => Math.min(frames.length - 1, i + 1)), 700)
    return () => clearTimeout(t)
  }, [playing, idx, frames.length])

  // when reaching the final frame of a mutate run, commit it
  useEffect(() => {
    if (frames.length && idx === frames.length - 1 && committed !== null) setTree(committed)
    else if (frames.length && idx < frames.length - 1 && committed !== null) setTree(pre)
  }, [idx, frames.length, committed, pre])

  const displayTree = tree
  const { pos, cols, rows } = useMemo(() => layout(displayTree), [displayTree, idx])
  const frame = frames[idx]

  const startRun = (newFrames: Frame[], finalTree: Node | null, mutates: boolean) => {
    setPre(tree)
    setFrames(newFrames)
    setIdx(0)
    setCommitted(mutates ? finalTree : null)
    setPlaying(newFrames.length > 1)
  }

  const doInsert = () => {
    const v = Number(input)
    if (!Number.isFinite(v)) return
    const working = clone(tree)
    const { root, path, newId } = insertValue(working, v)
    const fr: Frame[] = path.map((id, k) => ({
      current: id, visited: path.slice(0, k),
      caption: `Compare ${v} with ${nodeVal(working, id)} → go ${v < nodeVal(working, id)! ? 'left' : 'right'}`,
    }))
    fr.push({ current: newId, visited: path, caption: `Inserted ${v} as a new leaf.`, newId })
    startRun(fr, root, true)
  }

  const doFind = () => {
    const v = Number(input)
    if (!Number.isFinite(v)) return
    const { path, found } = findValue(tree, v)
    const fr: Frame[] = path.map((id, k) => ({
      current: id, visited: path.slice(0, k),
      caption: id === path[path.length - 1] && found
        ? `Found ${v}! ✓`
        : `Compare ${v} with ${nodeVal(tree, id)} → go ${v < nodeVal(tree, id)! ? 'left' : 'right'}`,
    }))
    if (!found) fr.push({ current: null, visited: path, caption: `${v} is not in the tree.` })
    startRun(fr.length ? fr : [{ current: null, visited: [], caption: 'Tree is empty.' }], null, false)
  }

  const doRemove = () => {
    const v = Number(input)
    if (!Number.isFinite(v)) return
    const { path, found } = findValue(tree, v)
    if (!found) { startRun([{ current: null, visited: path, caption: `${v} is not in the tree.` }], null, false); return }
    const working = clone(tree)
    const next = removeValue(working, v)
    const fr: Frame[] = path.map((id, k) => ({ current: id, visited: path.slice(0, k), caption: `Searching for ${v}…` }))
    fr.push({ current: null, visited: path, caption: `Removed ${v} (tree re-linked).` })
    startRun(fr, next, true)
  }

  const doTraverse = (order: 'in' | 'pre' | 'post') => {
    const visit = traverse(tree, order)
    const label = order === 'in' ? 'In-order' : order === 'pre' ? 'Pre-order' : 'Post-order'
    const fr: Frame[] = visit.map((v, k) => ({
      current: v.id, visited: visit.slice(0, k).map((x) => x.id),
      caption: `${label}: visit ${v.value}`, seq: visit.slice(0, k + 1).map((x) => x.value),
    }))
    startRun(fr.length ? fr : [{ current: null, visited: [], caption: 'Tree is empty.' }], null, false)
  }

  const reset = () => { nodeSeq = Math.max(nodeSeq, 1); setTree(initial); setPre(initial); setFrames([]); setIdx(0); setCommitted(null); setPlaying(false) }

  const GAPX = 56, GAPY = 70, R = 18, M = 30
  const w = Math.max(cols, 1) * GAPX + M * 2
  const h = Math.max(rows, 1) * GAPY + M * 2
  const cx = (id: number) => pos[id].x * GAPX + M + R
  const cy = (id: number) => pos[id].y * GAPY + M + R

  const edges: { x1: number; y1: number; x2: number; y2: number }[] = []
  const collectEdges = (n: Node | null) => {
    if (!n) return
    for (const c of [n.left, n.right]) {
      if (c) { edges.push({ x1: cx(n.id), y1: cy(n.id), x2: cx(c.id), y2: cy(c.id) }); collectEdges(c) }
    }
  }
  collectEdges(displayTree)
  const nodes: Node[] = []
  const collectNodes = (n: Node | null) => { if (!n) return; nodes.push(n); collectNodes(n.left); collectNodes(n.right) }
  collectNodes(displayTree)

  return (
    <div className="viz">
      <div className="viz__stage">
        {displayTree ? (
          <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} style={{ maxWidth: '100%', height: 'auto' }}>
            {edges.map((e, i) => (
              <line key={i} className="node-edge" x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
            ))}
            {nodes.map((n) => {
              const active = frame?.current === n.id
              const isNew = frame?.newId === n.id
              const visited = frame?.visited.includes(n.id)
              const cls = isNew ? 'node-circle--new' : active ? 'node-circle--active' : visited ? 'node-circle--visited' : ''
              return (
                <g key={n.id}>
                  <circle className={`node-circle ${cls}`} cx={cx(n.id)} cy={cy(n.id)} r={R} />
                  <text className="node-text" x={cx(n.id)} y={cy(n.id) + 5} textAnchor="middle">{n.value}</text>
                </g>
              )
            })}
          </svg>
        ) : <span className="viz-label">empty tree — insert a value</span>}
      </div>

      <div className="viz-caption">{frame?.caption ?? 'Insert, find, remove, or traverse the tree. Step through each comparison.'}</div>

      {frame?.seq && frame.seq.length > 0 && (
        <div className="viz-seq">
          <span className="viz-label">output</span>
          {frame.seq.map((v, i) => <span key={i} className="viz-seq__item">{v}</span>)}
        </div>
      )}

      <div className="viz__controls">
        <input className="viz-input" value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doInsert() }} aria-label="value" />
        <button className="viz-btn viz-btn--accent" onClick={doInsert}>Insert</button>
        <button className="viz-btn" onClick={doFind}>Find</button>
        <button className="viz-btn" onClick={doRemove}>Remove</button>
        <span className="viz__spacer" />
        <button className="viz-btn viz-btn--ghost" onClick={() => doTraverse('in')}>In-order</button>
        <button className="viz-btn viz-btn--ghost" onClick={() => doTraverse('pre')}>Pre-order</button>
        <button className="viz-btn viz-btn--ghost" onClick={() => doTraverse('post')}>Post-order</button>
      </div>

      <div className="viz__controls">
        <button className="viz-btn viz-btn--icon" onClick={() => { setPlaying(false); setIdx((i) => Math.max(0, i - 1)) }} disabled={idx <= 0} title="Previous step">◀</button>
        <button className="viz-btn viz-btn--icon" onClick={() => setPlaying((p) => !p)} disabled={frames.length <= 1} title="Play / pause">{playing ? '❚❚' : '▶'}</button>
        <button className="viz-btn viz-btn--icon" onClick={() => { setPlaying(false); setIdx((i) => Math.min(frames.length - 1, i + 1)) }} disabled={idx >= frames.length - 1} title="Next step">▶</button>
        <span className="viz-label">{frames.length ? `step ${idx + 1} / ${frames.length}` : 'ready'}</span>
        <span className="viz__spacer" />
        <button className="viz-btn viz-btn--ghost" onClick={reset} title="Reset to start">↺ Reset</button>
      </div>
    </div>
  )
}

function nodeVal(root: Node | null, id: number): number | null {
  let found: number | null = null
  const walk = (n: Node | null) => { if (!n || found !== null) return; if (n.id === id) { found = n.value; return } walk(n.left); walk(n.right) }
  walk(root)
  return found
}
