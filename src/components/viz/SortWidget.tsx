import { useEffect, useMemo, useState } from 'react'
import type { VizWidgetProps } from '../../lib/viz/types'

// Interactive sorting visualizer.
// spec.data: { array?: number[] }   spec.config: { algorithm?: 'bubble'|'selection'|'insertion' }

type Algo = 'bubble' | 'selection' | 'insertion'

interface Frame {
  arr: number[]
  compare: [number, number] | null
  sortedFrom: number // indices >= this are final
  caption: string
}

function genBubble(a: number[]): Frame[] {
  const arr = [...a]
  const frames: Frame[] = [{ arr: [...arr], compare: null, sortedFrom: arr.length, caption: 'Bubble sort: repeatedly swap adjacent out-of-order pairs.' }]
  for (let i = 0; i < arr.length - 1; i++) {
    for (let j = 0; j < arr.length - 1 - i; j++) {
      frames.push({ arr: [...arr], compare: [j, j + 1], sortedFrom: arr.length - i, caption: `Compare ${arr[j]} and ${arr[j + 1]}` })
      if (arr[j] > arr[j + 1]) {
        ;[arr[j], arr[j + 1]] = [arr[j + 1], arr[j]]
        frames.push({ arr: [...arr], compare: [j, j + 1], sortedFrom: arr.length - i, caption: `Swap → ${arr[j]}, ${arr[j + 1]}` })
      }
    }
  }
  frames.push({ arr: [...arr], compare: null, sortedFrom: 0, caption: 'Sorted! ✓' })
  return frames
}

function genSelection(a: number[]): Frame[] {
  const arr = [...a]
  const frames: Frame[] = [{ arr: [...arr], compare: null, sortedFrom: arr.length, caption: 'Selection sort: pick the smallest remaining, move it to front.' }]
  for (let i = 0; i < arr.length; i++) {
    let min = i
    for (let j = i + 1; j < arr.length; j++) {
      frames.push({ arr: [...arr], compare: [min, j], sortedFrom: i, caption: `Min so far ${arr[min]}; check ${arr[j]}` })
      if (arr[j] < arr[min]) min = j
    }
    if (min !== i) { ;[arr[i], arr[min]] = [arr[min], arr[i]] }
    frames.push({ arr: [...arr], compare: [i, min], sortedFrom: i, caption: `Place ${arr[i]} at position ${i + 1}` })
  }
  frames.push({ arr: [...arr], compare: null, sortedFrom: 0, caption: 'Sorted! ✓' })
  return frames
}

function genInsertion(a: number[]): Frame[] {
  const arr = [...a]
  const frames: Frame[] = [{ arr: [...arr], compare: null, sortedFrom: arr.length, caption: 'Insertion sort: grow a sorted prefix, insert each new item into place.' }]
  for (let i = 1; i < arr.length; i++) {
    let j = i
    while (j > 0) {
      frames.push({ arr: [...arr], compare: [j - 1, j], sortedFrom: arr.length, caption: `Compare ${arr[j - 1]} and ${arr[j]}` })
      if (arr[j - 1] > arr[j]) { ;[arr[j - 1], arr[j]] = [arr[j], arr[j - 1]]; j-- }
      else break
    }
  }
  frames.push({ arr: [...arr], compare: null, sortedFrom: 0, caption: 'Sorted! ✓' })
  return frames
}

const GEN: Record<Algo, (a: number[]) => Frame[]> = { bubble: genBubble, selection: genSelection, insertion: genInsertion }

export default function SortWidget({ spec }: VizWidgetProps) {
  const initialArr = useMemo(() => {
    const a = (spec.data?.array as number[] | undefined)?.filter((v) => typeof v === 'number')
    return a && a.length ? a.slice(0, 24) : [5, 2, 8, 1, 9, 3, 7, 4, 6]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec])

  const [algo, setAlgo] = useState<Algo>(((spec.config?.algorithm as Algo) ?? 'bubble'))
  const [array, setArray] = useState<number[]>(initialArr)
  const [edit, setEdit] = useState(initialArr.join(', '))
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  const frames = useMemo(() => GEN[algo](array), [algo, array])
  const frame = frames[Math.min(idx, frames.length - 1)]
  const max = Math.max(...array, 1)

  useEffect(() => { setIdx(0); setPlaying(false) }, [algo, array])

  useEffect(() => {
    if (!playing) return
    if (idx >= frames.length - 1) { setPlaying(false); return }
    const t = setTimeout(() => setIdx((i) => Math.min(frames.length - 1, i + 1)), 520 / speed)
    return () => clearTimeout(t)
  }, [playing, idx, frames.length, speed])

  const apply = () => {
    const nums = edit.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n)).slice(0, 24)
    if (nums.length) setArray(nums)
  }
  const shuffle = () => {
    const a = [...array]
    for (let i = a.length - 1; i > 0; i--) { const j = ((i * 2654435761) % (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
    setArray(a); setEdit(a.join(', '))
  }

  return (
    <div className="viz">
      <div className="viz__stage">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: '100%', width: '100%', justifyContent: 'center' }}>
          {frame.arr.map((v, i) => {
            const inCompare = frame.compare && (frame.compare[0] === i || frame.compare[1] === i)
            const sorted = i >= frame.sortedFrom
            const bg = sorted ? 'var(--color-sage)' : inCompare ? 'var(--color-accent)' : 'var(--color-ink)'
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                <div style={{
                  width: `clamp(14px, ${Math.max(60 / frame.arr.length, 2)}vw, 40px)`,
                  height: `${(v / max) * 100}%`, minHeight: 4, background: bg,
                  border: '2px solid var(--color-ink)', borderRadius: '4px 4px 0 0', transition: 'height 160ms ease, background 160ms ease',
                }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>{v}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="viz-caption">{frame.caption}</div>

      <div className="viz__controls">
        <span className="viz-label">algorithm</span>
        {(['bubble', 'selection', 'insertion'] as Algo[]).map((a) => (
          <button key={a} className={`viz-btn ${algo === a ? 'viz-btn--accent' : 'viz-btn--ghost'}`} onClick={() => setAlgo(a)}>{a}</button>
        ))}
        <span className="viz__spacer" />
        <input className="viz-input viz-input--wide" value={edit} onChange={(e) => setEdit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply() }} aria-label="array values" />
        <button className="viz-btn" onClick={apply}>Set</button>
        <button className="viz-btn viz-btn--ghost" onClick={shuffle}>Shuffle</button>
      </div>

      <div className="viz__controls">
        <button className="viz-btn viz-btn--icon" onClick={() => { setPlaying(false); setIdx((i) => Math.max(0, i - 1)) }} disabled={idx <= 0}>◀</button>
        <button className="viz-btn viz-btn--icon" onClick={() => setPlaying((p) => !p)} disabled={frames.length <= 1}>{playing ? '❚❚' : '▶'}</button>
        <button className="viz-btn viz-btn--icon" onClick={() => { setPlaying(false); setIdx((i) => Math.min(frames.length - 1, i + 1)) }} disabled={idx >= frames.length - 1}>▶</button>
        <span className="viz-label">step {Math.min(idx + 1, frames.length)} / {frames.length}</span>
        <span className="viz__spacer" />
        <span className="viz-label">speed</span>
        <input type="range" min={0.5} max={4} step={0.5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        <button className="viz-btn viz-btn--ghost" onClick={() => { setIdx(0); setPlaying(false) }}>↺ Reset</button>
      </div>
    </div>
  )
}
