import { useEffect, useMemo, useRef, useState } from 'react'
import PlaybackStage from './PlaybackStage'
import { sceneAt, EMPTY_SCENE, type Recording, type Scene } from '../../lib/recording/types'
import { contentBoundsOf } from '../../lib/render'
import type { Element } from '../../lib/types'
import './ReplayView.css'

interface Props {
  recordings: Recording[]
  canShare: boolean
  loggedIn: boolean
  notice: string | null
  selectId: string | null
  onDelete: (id: string) => void | Promise<void>
  onShare: (id: string) => Promise<string | null>
  onOpenLink: (text: string) => Promise<{ ok: boolean; id?: string; error?: string }>
  resolveAudio: (rec: Recording) => Promise<string | null>
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

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

export default function ReplayView({ recordings, canShare, loggedIn, notice, selectId, onDelete, onShare, onOpenLink, resolveAudio }: Props) {
  const [selId, setSelId] = useState<string | null>(null)
  const rec = useMemo(() => recordings.find((r) => r.id === selId) ?? null, [recordings, selId])

  const [playing, setPlaying] = useState(false)
  const [curMs, setCurMs] = useState(0)
  const [scene, setScene] = useState<Scene>(EMPTY_SCENE)
  const [audioSrc, setAudioSrc] = useState<string | null>(null)
  const [linkInput, setLinkInput] = useState('')
  const [linkMsg, setLinkMsg] = useState<string | null>(null)
  const [shareLink, setShareLink] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement>(null)
  const virt = useRef({ playing: false, base: 0, wall: 0 })
  const rafRef = useRef<number | null>(null)
  const playingRef = useRef(false)
  const lastCountRef = useRef(-1)

  const bounds = useMemo(() => (rec ? recordingBounds(rec) : null), [rec])
  const duration = rec ? rec.durationMs : 0
  const hasAudio = !!audioSrc

  const getNow = () => {
    if (hasAudio && audioRef.current) return audioRef.current.currentTime * 1000
    const v = virt.current
    return v.playing ? v.base + (performance.now() - v.wall) : v.base
  }
  const applyAt = (ms: number) => { if (rec) { setScene(sceneAt(rec, ms)); lastCountRef.current = countEventsLE(rec, ms) } }
  const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }

  const loop = () => {
    if (!rec) return
    const nowMs = getNow()
    const count = countEventsLE(rec, nowMs)
    if (count !== lastCountRef.current) { lastCountRef.current = count; setScene(sceneAt(rec, nowMs)) }
    setCurMs(Math.min(nowMs, duration))
    if (nowMs >= duration) { doPause(true); return }
    if (playingRef.current) rafRef.current = requestAnimationFrame(loop)
  }

  const doPlay = () => {
    if (!rec) return
    if (getNow() >= duration) seekTo(0)
    if (hasAudio && audioRef.current) audioRef.current.play().catch(() => {})
    else { virt.current.playing = true; virt.current.wall = performance.now() }
    playingRef.current = true; setPlaying(true)
    stopLoop(); rafRef.current = requestAnimationFrame(loop)
  }
  const doPause = (atEnd = false) => {
    if (hasAudio && audioRef.current) audioRef.current.pause()
    else { virt.current.base = atEnd ? duration : getNow(); virt.current.playing = false }
    playingRef.current = false; setPlaying(false); stopLoop()
    if (atEnd) setCurMs(duration)
  }
  const seekTo = (ms: number) => {
    if (!rec) return
    const clamped = Math.max(0, Math.min(duration, ms))
    if (hasAudio && audioRef.current) audioRef.current.currentTime = clamped / 1000
    else { virt.current.base = clamped; virt.current.wall = performance.now() }
    setCurMs(clamped); applyAt(clamped)
  }

  // load a recording (+ resolve its audio source)
  useEffect(() => {
    stopLoop(); playingRef.current = false; setPlaying(false)
    virt.current = { playing: false, base: 0, wall: 0 }
    lastCountRef.current = -1; setCurMs(0); setShareLink(null); setAudioSrc(null)
    if (rec) {
      setScene(sceneAt(rec, 0))
      resolveAudio(rec).then((src) => setAudioSrc(src))
    } else setScene(EMPTY_SCENE)
    return stopLoop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id])

  // explicit select request from the app (just-recorded, or newest on login)
  useEffect(() => {
    if (selectId && recordings.some((r) => r.id === selectId)) setSelId(selectId)
  }, [selectId, recordings])

  // keep selection valid; default to the first recording if none chosen
  useEffect(() => {
    if (recordings.length && (!selId || !recordings.some((r) => r.id === selId))) setSelId(recordings[0].id)
    if (!recordings.length) setSelId(null)
  }, [recordings, selId])

  const doShare = async () => {
    if (!rec) return
    const link = await onShare(rec.id)
    if (link) {
      setShareLink(link)
      try { await navigator.clipboard.writeText(link) } catch { /* clipboard may be blocked */ }
    }
  }

  const submitLink = async (e: React.FormEvent) => {
    e.preventDefault()
    setLinkMsg(null)
    const res = await onOpenLink(linkInput)
    if (res.ok && res.id) { setSelId(res.id); setLinkInput(''); setLinkMsg(null) }
    else setLinkMsg(res.error ?? 'Could not open that link.')
  }

  return (
    <div className="replay">
      <aside className="replay__list">
        <div className="replay__list-head">
          <h3 className="replay__title">Recordings</h3>
          <span className="caption">{recordings.length}</span>
        </div>

        {notice && <p className="replay__notice">{notice}</p>}

        <div className="replay__items-wrap">
          {recordings.length === 0 ? (
            <p className="replay__empty caption">No recordings yet. Hit <b>● Record</b> on the board to capture a lesson.</p>
          ) : (
            <ul className="replay__items">
              {recordings.map((r) => (
                <li key={r.id}>
                  <button className={`rec ${r.id === selId ? 'rec--on' : ''}`} onClick={() => setSelId(r.id)}>
                    <span className="rec__name">
                      {r.title}
                      {r.demo && <span className="rec__tag">demo</span>}
                      {loggedIn && !r.demo && !r.remote && <span className="rec__tag rec__tag--unsaved">unsaved</span>}
                      {r.shared && <span className="rec__tag rec__tag--shared">shared</span>}
                      {r.remote && !r.mine && <span className="rec__tag rec__tag--shared">shared with you</span>}
                    </span>
                    <span className="rec__meta caption">{fmt(r.durationMs)} · {r.audioPath || r.audioUrl ? '🎙' : 'silent'} · {r.events.length} ev</span>
                  </button>
                  {!r.demo && (r.mine || !r.remote) && <button className="rec__del" onClick={() => onDelete(r.id)} title="Delete" aria-label="delete">×</button>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <form className="replay__linkbar" onSubmit={submitLink}>
          <span className="caption" style={{ display: 'block', marginBottom: 4 }}>Open a shared link</span>
          <div className="replay__linkrow">
            <input className="replay__linkinput" value={linkInput} placeholder="paste recording link…"
              onChange={(e) => { setLinkInput(e.target.value); setLinkMsg(null) }} />
            <button className="btn" type="submit">Open</button>
          </div>
          {linkMsg && <span className="replay__linkmsg">{linkMsg}</span>}
        </form>
      </aside>

      <div className="replay__player">
        {rec ? (
          <>
            <div className="replay__stage">
              <PlaybackStage scene={scene} boardBounds={bounds} />
              {audioSrc && <audio ref={audioRef} src={audioSrc} preload="auto" onEnded={() => doPause(true)} />}
            </div>
            <div className="replay__transport">
              <button className="btn btn--accent replay__play" onClick={() => (playing ? doPause() : doPlay())}>{playing ? '❚❚' : '▶'}</button>
              <span className="replay__time caption">{fmt(curMs)}</span>
              <input className="replay__scrub" type="range" min={0} max={duration} step={50}
                value={Math.min(curMs, duration)} onChange={(e) => seekTo(Number(e.target.value))} aria-label="seek" />
              <span className="replay__time caption">{fmt(duration)}</span>
              {canShare && rec.mine && (
                <button className="btn replay__share" onClick={doShare} title="Share this recording">⇪ Share</button>
              )}
            </div>
            {shareLink && (
              <div className="replay__sharebar">
                <span className="caption">link copied — anyone signed in can watch</span>
                <input className="replay__linkinput" readOnly value={shareLink} onFocus={(e) => e.currentTarget.select()} />
              </div>
            )}
          </>
        ) : (
          <div className="replay__placeholder">
            <p className="replay__placeholder-big">Replay a lesson</p>
            <p>Record yourself teaching on the board — strokes, text, and the AI's
              annotations replay in sync with your voice. Select a recording, or paste a shared link.</p>
          </div>
        )}
      </div>
    </div>
  )
}
