import { useEffect, useMemo, useRef, useState } from 'react'
import PlaybackStage from './PlaybackStage'
import ChapterThumb from './ChapterThumb'
import { sceneAt, EMPTY_SCENE, type Recording, type Scene } from '../../lib/recording/types'
import { contentBoundsOf } from '../../lib/render'
import { snapshotScene } from '../../lib/recording/snapshot'
import { startLive, type LiveSession } from '../../lib/deepgram/live'
import { askStream, speak, toBlueAnnotations, AskError } from '../../lib/ask'
import { parseReply } from '../../lib/drawblock'
import type { Element } from '../../lib/types'
import './ReplayView.css'

type AskState = 'idle' | 'listening' | 'thinking' | 'answering'

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

  const [search, setSearch] = useState('')

  const bounds = useMemo(() => (rec ? recordingBounds(rec) : null), [rec])
  const duration = rec ? rec.durationMs : 0
  const hasAudio = !!audioSrc

  const transcript = useMemo(() => rec?.transcript ?? [], [rec])
  const chapters = useMemo(() => rec?.chapters ?? [], [rec])

  // live caption: a sliding window of the most recent spoken words up to `now`
  const caption = useMemo(() => {
    if (!transcript.length) return ''
    const upto = []
    for (const w of transcript) { if (w.start <= curMs + 250) upto.push(w.w); else break }
    return upto.slice(-14).join(' ')
  }, [transcript, curMs])

  // transcript search → clickable timestamps with a 10-word context snippet
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q.length < 2 || !transcript.length) return []
    const out: { t: number; snippet: string }[] = []
    for (let i = 0; i < transcript.length; i++) {
      if (transcript[i].w.toLowerCase().includes(q)) {
        const from = Math.max(0, i - 5), to = Math.min(transcript.length, i + 6)
        const snippet = transcript.slice(from, to).map((w, j) => (from + j === i ? `‹${w.w}›` : w.w)).join(' ')
        out.push({ t: transcript[i].start, snippet })
        if (out.length >= 40) break
      }
    }
    return out
  }, [search, transcript])

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

  // ───────────── ask the recording ─────────────
  const [askState, setAskState] = useState<AskState>('idle')
  const [askQ, setAskQ] = useState('')
  const [askAnswer, setAskAnswer] = useState('')
  const [askAnns, setAskAnns] = useState<Element[]>([])
  const [annAlpha, setAnnAlpha] = useState(1)
  const [askErr, setAskErr] = useState<string | null>(null)
  const sttRef = useRef<LiveSession | null>(null)
  const sttStreamRef = useRef<MediaStream | null>(null)
  const qFinalsRef = useRef('')
  const askAbortRef = useRef<AbortController | null>(null)
  const ttsRef = useRef<HTMLAudioElement | null>(null)
  const ttsUrlRef = useRef<string | null>(null)
  const fadeRafRef = useRef<number | null>(null)

  const stopStt = () => {
    try { sttRef.current?.stop() } catch { /* */ }
    sttStreamRef.current?.getTracks().forEach((t) => t.stop())
    sttRef.current = null; sttStreamRef.current = null
  }
  const stopTts = () => {
    try { ttsRef.current?.pause() } catch { /* */ }
    if (ttsUrlRef.current) { URL.revokeObjectURL(ttsUrlRef.current); ttsUrlRef.current = null }
    ttsRef.current = null
  }

  const startAsk = async () => {
    if (!rec || askState !== 'idle') return
    doPause()
    setAskErr(null); setAskQ(''); qFinalsRef.current = ''; setAskAnswer(''); setAskAnns([]); setAnnAlpha(1)
    setAskState('listening') // panel opens; mic streams in if available, else type
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      sttStreamRef.current = stream
      sttRef.current = await startLive(stream, {
        onPartial: (t) => setAskQ((qFinalsRef.current + ' ' + t).trim()),
        onFinal: (t) => { qFinalsRef.current = (qFinalsRef.current + ' ' + t).trim(); setAskQ(qFinalsRef.current) },
        onError: () => setAskErr('Voice error — you can type your question instead.'),
      })
    } catch {
      setAskErr('Mic unavailable — type your question below.')
    }
  }

  const sendQuestion = async () => {
    if (!rec) return
    stopStt()
    const question = askQ.trim()
    if (!question) { setAskErr('Type or speak a question first.'); return }
    setAskState('thinking'); setAskAnswer(''); setAskErr(null)

    const sc = sceneAt(rec, curMs)
    const snap = sc.view === 'board' ? snapshotScene(sc.elements) : null
    const win = transcript.filter((w) => w.start >= curMs - 30000 && w.start <= curMs + 30000).map((w) => w.w).join(' ')

    const controller = new AbortController()
    askAbortRef.current = controller
    let full = ''
    try {
      await askStream({
        image: snap?.dataUrl ?? null, transcriptWindow: win, question, signal: controller.signal,
        onToken: (d) => { full += d; setAskAnswer(parseReply(full).clean) },
      })
      const { clean, actions } = parseReply(full)
      setAskAnswer(clean)
      if (actions?.length && snap) setAskAnns(toBlueAnnotations(actions, snap))
      setAskState('answering')
      if (clean) {
        const url = await speak(clean, controller.signal)
        if (url) { ttsUrlRef.current = url; const a = new Audio(url); ttsRef.current = a; a.play().catch(() => {}) }
      }
    } catch (e) {
      setAskErr(e instanceof AskError ? e.message : 'Could not get an answer.')
      setAskState('answering')
    }
  }

  const resumeFromAsk = () => {
    stopTts()
    // fade the blue annotations out, then clear
    if (fadeRafRef.current) cancelAnimationFrame(fadeRafRef.current)
    const start = performance.now(); const DUR = 450
    const fade = (now: number) => {
      const p = Math.min(1, (now - start) / DUR)
      setAnnAlpha(1 - p)
      if (p < 1) fadeRafRef.current = requestAnimationFrame(fade)
      else { setAskAnns([]); setAnnAlpha(1) }
    }
    fadeRafRef.current = requestAnimationFrame(fade)
    setAskState('idle'); setAskQ(''); setAskAnswer('')
    doPlay()
  }

  const cancelAsk = () => {
    stopStt(); stopTts()
    try { askAbortRef.current?.abort() } catch { /* */ }
    setAskAnns([]); setAnnAlpha(1); setAskState('idle'); setAskQ(''); setAskAnswer(''); setAskErr(null)
  }

  // load a recording (+ resolve its audio source)
  useEffect(() => {
    stopLoop(); playingRef.current = false; setPlaying(false)
    virt.current = { playing: false, base: 0, wall: 0 }
    lastCountRef.current = -1; setCurMs(0); setShareLink(null); setAudioSrc(null)
    // reset any in-flight ask when switching recordings
    stopStt(); stopTts()
    setAskState('idle'); setAskQ(''); setAskAnswer(''); setAskAnns([]); setAnnAlpha(1); setAskErr(null)
    if (rec) {
      setScene(sceneAt(rec, 0))
      resolveAudio(rec).then((src) => setAudioSrc(src))
    } else setScene(EMPTY_SCENE)
    return stopLoop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id])

  // "Ask" hotkey: A to ask, Escape to cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement
      if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA') return
      if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey && askState === 'idle' && rec) { e.preventDefault(); startAsk() }
      else if (e.key === 'Escape' && askState !== 'idle') { e.preventDefault(); cancelAsk() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askState, rec?.id])

  // cleanup on unmount
  useEffect(() => () => { stopStt(); stopTts(); if (fadeRafRef.current) cancelAnimationFrame(fadeRafRef.current) }, [])

  // explicit select request from the app (just-recorded, or newest on login).
  // apply only when selectId actually changes, so it doesn't fight manual clicks.
  const appliedSelectRef = useRef<string | null>(null)
  useEffect(() => {
    if (selectId && selectId !== appliedSelectRef.current && recordings.some((r) => r.id === selectId)) {
      appliedSelectRef.current = selectId
      setSelId(selectId)
    }
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
              <PlaybackStage scene={scene} boardBounds={bounds} annotations={askAnns} annotationAlpha={annAlpha} />
              {askState !== 'idle' && <span className="replay__frozen">⏸ frozen</span>}
              {caption && askState === 'idle' && <div className="replay__caption">{caption}</div>}
              {audioSrc && <audio ref={audioRef} src={audioSrc} preload="auto" onEnded={() => doPause(true)} />}
            </div>
            <div className="replay__transport">
              <button className="btn btn--accent replay__play" onClick={() => (playing ? doPause() : doPlay())}>{playing ? '❚❚' : '▶'}</button>
              <span className="replay__time caption">{fmt(curMs)}</span>
              <input className="replay__scrub" type="range" min={0} max={duration} step={50}
                value={Math.min(curMs, duration)} onChange={(e) => seekTo(Number(e.target.value))} aria-label="seek" />
              <span className="replay__time caption">{fmt(duration)}</span>
              {askState === 'idle' && (
                <button className="btn btn--accent replay__ask" onClick={startAsk} title="Pause and ask a question (A)">✦ Ask</button>
              )}
              {canShare && rec.mine && (
                <button className="btn replay__share" onClick={doShare} title="Share this recording">⇪ Share</button>
              )}
            </div>

            {askState !== 'idle' && (
              <div className="replay__askpanel">
                {askState === 'listening' && (
                  <>
                    <div className="replay__askhead"><span className="replay__asklive">●</span> Ask your question — speak or type</div>
                    <input
                      className="replay__askinput"
                      value={askQ}
                      autoFocus
                      placeholder="e.g. why did you take the square root of both sides?"
                      onChange={(e) => { qFinalsRef.current = e.target.value; setAskQ(e.target.value) }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && askQ.trim()) sendQuestion() }}
                    />
                    <div className="replay__askbtns">
                      <button className="btn btn--accent" onClick={sendQuestion} disabled={!askQ.trim()}>Ask the AI →</button>
                      <button className="btn" onClick={cancelAsk}>Cancel</button>
                    </div>
                  </>
                )}
                {askState === 'thinking' && (
                  <>
                    <div className="replay__askhead">✦ Thinking…</div>
                    <p className="replay__askq">“{askQ}”</p>
                    {askAnswer && <p className="replay__askans">{askAnswer}</p>}
                  </>
                )}
                {askState === 'answering' && (
                  <>
                    <div className="replay__askhead">✦ AI assistant{askAnns.length ? ' · drew on the board in blue' : ''}</div>
                    <p className="replay__askq">“{askQ}”</p>
                    <p className="replay__askans">{askAnswer}</p>
                    <div className="replay__askbtns">
                      <button className="btn btn--accent" onClick={resumeFromAsk}>▶ Resume</button>
                    </div>
                  </>
                )}
                {askErr && <p className="replay__askerr">{askErr}</p>}
              </div>
            )}
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

      {rec && (
        <aside className="replay__chapters">
          <h3 className="replay__title">Chapters</h3>
          {chapters.length ? (
            <ul className="chaplist">
              {chapters.map((c, i) => (
                <li key={i}>
                  <button className="chap" onClick={() => seekTo(c.t)}>
                    <ChapterThumb rec={rec} t={c.t} />
                    <span className="chap__meta">
                      <span className="chap__title">{c.title}</span>
                      <span className="chap__time caption">{fmt(c.t)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="replay__chapters-empty caption">No chapters — record with a mic (Deepgram on) to get an auto-transcript + chapters.</p>
          )}

          <div className="replay__search">
            <span className="caption" style={{ display: 'block', marginBottom: 4 }}>Search transcript</span>
            <input className="replay__searchinput" value={search} placeholder="find a word…"
              onChange={(e) => setSearch(e.target.value)} disabled={!transcript.length} />
            {searchResults.length > 0 && (
              <ul className="searchres">
                {searchResults.map((r, i) => (
                  <li key={i}>
                    <button className="sres" onClick={() => seekTo(r.t)}>
                      <span className="sres__time caption">{fmt(r.t)}</span>
                      <span className="sres__snip">{r.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {search.trim().length >= 2 && searchResults.length === 0 && transcript.length > 0 && (
              <p className="caption" style={{ marginTop: 6 }}>no matches</p>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
