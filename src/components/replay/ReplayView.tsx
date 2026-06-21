import { useEffect, useMemo, useRef, useState } from 'react'
import PlaybackCanvas from './PlaybackCanvas'
import { stateAt, type Recording } from '../../lib/recording/types'
import { contentBoundsOf } from '../../lib/render'
import type { Element } from '../../lib/types'
import './ReplayView.css'

interface Props {
  recordings: Recording[]
  onDelete: (id: string) => void
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// union bounds of every element that ever appears, so the camera never jumps
function recordingBounds(rec: Recording) {
  const all: Element[] = []
  for (const s of rec.snapshots) all.push(...s.elements)
  for (const ev of rec.events) {
    if (ev.type === 'add') all.push(ev.element)
    else if (ev.type === 'addMany' || ev.type === 'set') all.push(...ev.elements)
  }
  return contentBoundsOf(all)
}

function countEventsLE(rec: Recording, t: number) {
  let lo = 0, hi = rec.events.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (rec.events[m].t <= t) lo = m + 1; else hi = m }
  return lo
}

export default function ReplayView({ recordings, onDelete }: Props) {
  const [selId, setSelId] = useState<string | null>(null)
  const rec = useMemo(() => recordings.find((r) => r.id === selId) ?? null, [recordings, selId])

  const [playing, setPlaying] = useState(false)
  const [curMs, setCurMs] = useState(0)
  const [elements, setElements] = useState<Element[]>([])

  const audioRef = useRef<HTMLAudioElement>(null)
  const virt = useRef({ playing: false, base: 0, wall: 0 })
  const rafRef = useRef<number | null>(null)
  const playingRef = useRef(false)
  const lastCountRef = useRef(-1)

  const bounds = useMemo(() => (rec ? recordingBounds(rec) : null), [rec])
  const duration = rec ? rec.durationMs : 0

  const getNow = () => {
    if (rec?.audioUrl && audioRef.current) return audioRef.current.currentTime * 1000
    const v = virt.current
    return v.playing ? v.base + (performance.now() - v.wall) : v.base
  }

  const applyAt = (ms: number) => {
    if (!rec) return
    setElements(stateAt(rec, ms))
    lastCountRef.current = countEventsLE(rec, ms)
  }

  const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }

  const loop = () => {
    if (!rec) return
    const nowMs = getNow()
    const count = countEventsLE(rec, nowMs)
    if (count !== lastCountRef.current) { lastCountRef.current = count; setElements(stateAt(rec, nowMs)) }
    setCurMs(Math.min(nowMs, duration))
    if (nowMs >= duration) { doPause(true); return }
    if (playingRef.current) rafRef.current = requestAnimationFrame(loop)
  }

  const doPlay = () => {
    if (!rec) return
    if (getNow() >= duration) seekTo(0)
    if (rec.audioUrl && audioRef.current) { audioRef.current.play().catch(() => {}) }
    else { virt.current.playing = true; virt.current.wall = performance.now() }
    playingRef.current = true
    setPlaying(true)
    stopLoop()
    rafRef.current = requestAnimationFrame(loop)
  }

  const doPause = (atEnd = false) => {
    if (rec?.audioUrl && audioRef.current) audioRef.current.pause()
    else { virt.current.base = atEnd ? duration : getNow(); virt.current.playing = false }
    playingRef.current = false
    setPlaying(false)
    stopLoop()
    if (atEnd) setCurMs(duration)
  }

  const seekTo = (ms: number) => {
    if (!rec) return
    const clamped = Math.max(0, Math.min(duration, ms))
    if (rec.audioUrl && audioRef.current) audioRef.current.currentTime = clamped / 1000
    else { virt.current.base = clamped; virt.current.wall = performance.now() }
    setCurMs(clamped)
    applyAt(clamped)
  }

  // load a recording
  useEffect(() => {
    stopLoop()
    playingRef.current = false
    setPlaying(false)
    virt.current = { playing: false, base: 0, wall: 0 }
    lastCountRef.current = -1
    setCurMs(0)
    if (rec) { setElements(stateAt(rec, 0)); if (audioRef.current) audioRef.current.currentTime = 0 }
    else setElements([])
    return stopLoop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id])

  // auto-select newest, and keep selection valid
  useEffect(() => {
    if (recordings.length && (!selId || !recordings.some((r) => r.id === selId))) setSelId(recordings[0].id)
    if (!recordings.length) setSelId(null)
  }, [recordings, selId])

  return (
    <div className="replay">
      <aside className="replay__list">
        <div className="replay__list-head">
          <h3 className="replay__title">Recordings</h3>
          <span className="caption">{recordings.length}</span>
        </div>
        {recordings.length === 0 ? (
          <p className="replay__empty caption">No recordings yet. Hit <b>● Record</b> on the board to capture a lesson.</p>
        ) : (
          <ul className="replay__items">
            {recordings.map((r) => (
              <li key={r.id}>
                <button className={`rec ${r.id === selId ? 'rec--on' : ''}`} onClick={() => setSelId(r.id)}>
                  <span className="rec__name">{r.title}{r.demo && <span className="rec__tag">demo</span>}</span>
                  <span className="rec__meta caption">{fmt(r.durationMs)} · {r.audioUrl ? '🎙' : 'silent'} · {r.events.length} ev</span>
                </button>
                {!r.demo && <button className="rec__del" onClick={() => onDelete(r.id)} title="Delete" aria-label="delete">×</button>}
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="replay__player">
        {rec ? (
          <>
            <div className="replay__stage">
              <PlaybackCanvas elements={elements} bounds={bounds} />
              {rec.audioUrl && <audio ref={audioRef} src={rec.audioUrl} preload="auto" onEnded={() => doPause(true)} />}
            </div>
            <div className="replay__transport">
              <button className="btn btn--accent replay__play" onClick={() => (playing ? doPause() : doPlay())}>
                {playing ? '❚❚' : '▶'}
              </button>
              <span className="replay__time caption">{fmt(curMs)}</span>
              <input
                className="replay__scrub"
                type="range" min={0} max={duration} step={50}
                value={Math.min(curMs, duration)}
                onChange={(e) => seekTo(Number(e.target.value))}
                aria-label="seek"
              />
              <span className="replay__time caption">{fmt(duration)}</span>
              <span className={`replay__src caption ${rec.audioUrl ? 'is-audio' : ''}`}>{rec.audioUrl ? 'audio-synced' : 'silent'}</span>
            </div>
          </>
        ) : (
          <div className="replay__placeholder">
            <p className="replay__placeholder-big">Replay a lesson</p>
            <p>Record yourself teaching on the board — strokes, text, and the AI's
              annotations replay in sync with your voice. Select a recording on the left.</p>
          </div>
        )}
      </div>
    </div>
  )
}
