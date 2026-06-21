import { useCallback, useEffect, useRef, useState } from 'react'
import type { RawSceneEvent, Recording, RecorderStatus, Scene, SceneEvent, Snapshot } from './types'
import { EMPTY_SCENE } from './types'
import { DEMO_RECORDING } from './demoRecording'

const SNAPSHOT_EVERY_MS = 30_000
let recSeq = 0
const rid = () => `rec_${Date.now().toString(36)}_${recSeq++}`

interface StartOpts {
  title: string
  getScene: () => Scene
}

export interface RecorderApi {
  status: RecorderStatus
  recordings: Recording[]
  elapsedMs: number
  hasAudio: boolean
  error: string | null
  start: (opts: StartOpts) => Promise<void>
  stop: () => Promise<Recording | null>
  /** called for every content change (board/graph/viz/view) — recorded only while active */
  recordEvent: (ev: RawSceneEvent) => void
  remove: (id: string) => void
}

export function useRecorder(): RecorderApi {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  // the bundled demo is always present so there's a recording to replay on open
  const [recordings, setRecordings] = useState<Recording[]>([DEMO_RECORDING])
  const [elapsedMs, setElapsedMs] = useState(0)
  const [hasAudio, setHasAudio] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startTimeRef = useRef(0)
  const eventsRef = useRef<SceneEvent[]>([])
  const snapsRef = useRef<Snapshot[]>([])
  const getSceneRef = useRef<() => Scene>(() => EMPTY_SCENE)
  const titleRef = useRef('Recording')

  const mediaRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const snapTimerRef = useRef<number | null>(null)
  const elapsedTimerRef = useRef<number | null>(null)

  const now = () => Date.now() - startTimeRef.current

  const recordEvent = useCallback((ev: RawSceneEvent) => {
    if (startTimeRef.current === 0) return // not recording
    eventsRef.current.push({ ...ev, t: now() } as SceneEvent)
  }, [])

  const snapScene = (t: number): Snapshot => {
    const s = getSceneRef.current()
    return { t, elements: s.elements, view: s.view, equations: s.equations, viz: s.viz }
  }

  const start = useCallback(async ({ title, getScene }: StartOpts) => {
    setError(null)
    getSceneRef.current = getScene
    titleRef.current = title
    eventsRef.current = []
    snapsRef.current = []
    chunksRef.current = []

    // try audio — optional, so playback still works without a mic
    let audioOk = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mr = new MediaRecorder(stream)
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data) }
      mediaRef.current = mr
      mr.start(1000)
      audioOk = true
    } catch (e) {
      audioOk = false
      setError(e instanceof Error ? `Mic unavailable — recording strokes only (${e.name})` : 'Mic unavailable')
    }
    setHasAudio(audioOk)

    startTimeRef.current = Date.now()
    snapsRef.current.push(snapScene(0)) // initial scene
    setStatus('recording')
    setElapsedMs(0)

    snapTimerRef.current = window.setInterval(() => {
      snapsRef.current.push(snapScene(now()))
    }, SNAPSHOT_EVERY_MS)
    elapsedTimerRef.current = window.setInterval(() => setElapsedMs(now()), 250)
  }, [])

  const stop = useCallback(async (): Promise<Recording | null> => {
    if (startTimeRef.current === 0) return null
    const durationMs = now()
    if (snapTimerRef.current) { clearInterval(snapTimerRef.current); snapTimerRef.current = null }
    if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null }
    // final snapshot
    snapsRef.current.push(snapScene(durationMs))

    // finalize audio
    let audioUrl: string | undefined
    let audioMime: string | undefined
    let audioBlob: Blob | undefined
    const mr = mediaRef.current
    if (mr && mr.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        mr.onstop = () => resolve()
        mr.stop()
      })
      if (chunksRef.current.length) {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
        audioUrl = URL.createObjectURL(blob)
        audioMime = blob.type
        audioBlob = blob // kept transiently so it can be uploaded to storage
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    mediaRef.current = null

    const rec: Recording = {
      id: rid(),
      title: titleRef.current,
      createdAt: Date.now(),
      durationMs,
      events: eventsRef.current,
      snapshots: snapsRef.current,
      audioUrl,
      audioMime,
      audioBlob,
      mine: true,
    }
    setRecordings((rs) => [rec, ...rs])

    startTimeRef.current = 0
    setStatus('idle')
    setElapsedMs(0)
    return rec
  }, [])

  const remove = useCallback((id: string) => {
    setRecordings((rs) => {
      const r = rs.find((x) => x.id === id)
      if (r?.audioUrl) URL.revokeObjectURL(r.audioUrl)
      return rs.filter((x) => x.id !== id)
    })
  }, [])

  useEffect(() => () => {
    if (snapTimerRef.current) clearInterval(snapTimerRef.current)
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
  }, [])

  return { status, recordings, elapsedMs, hasAudio, error, start, stop, recordEvent, remove }
}
