// Browser-side Deepgram live transcription. Gets a short-lived token from the
// server, opens Deepgram's live WebSocket, and streams a MediaStream to it.
// Word timings come back in seconds from stream start — for a recording, that's
// the recording timeline.

import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'

export interface TWord {
  w: string
  start: number // ms from stream start
  end: number
}

interface Handlers {
  onPartial?: (text: string) => void
  onFinal?: (text: string, words: TWord[]) => void
  onError?: (e: unknown) => void
  onOpen?: () => void
  onClose?: () => void
}

export interface LiveSession {
  stop: () => void
}

let cachedConfigured: boolean | null = null
export async function deepgramConfigured(): Promise<boolean> {
  if (cachedConfigured !== null) return cachedConfigured
  try {
    const res = await fetch('/api/deepgram/status')
    const j = await res.json()
    cachedConfigured = !!j.configured
  } catch {
    cachedConfigured = false
  }
  return cachedConfigured
}

async function getToken(): Promise<string> {
  const res = await fetch('/api/deepgram/token')
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error(j.error || `token error ${res.status}`)
  }
  const j = await res.json()
  return j.key as string
}

/** Start live transcription of a MediaStream. Caller stops via the returned handle. */
export async function startLive(stream: MediaStream, h: Handlers): Promise<LiveSession> {
  const key = await getToken()
  const dg = createClient(key)
  const conn = dg.listen.live({
    model: 'nova-2',
    language: 'en',
    smart_format: true,
    punctuate: true,
    interim_results: true,
    endpointing: 250,
  })

  let recorder: MediaRecorder | null = null
  let stopped = false

  conn.on(LiveTranscriptionEvents.Open, () => {
    h.onOpen?.()
    try {
      recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && conn.getReadyState() === 1) conn.send(e.data)
      }
      recorder.start(250)
    } catch (e) {
      h.onError?.(e)
    }
  })

  conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    const alt = data?.channel?.alternatives?.[0]
    const text: string = alt?.transcript ?? ''
    if (!text) return
    if (data.is_final) {
      const words: TWord[] = (alt.words ?? []).map((w: any) => ({
        w: w.punctuated_word ?? w.word,
        start: Math.round((w.start ?? 0) * 1000),
        end: Math.round((w.end ?? 0) * 1000),
      }))
      h.onFinal?.(text, words)
    } else {
      h.onPartial?.(text)
    }
  })

  conn.on(LiveTranscriptionEvents.Error, (e: unknown) => h.onError?.(e))
  conn.on(LiveTranscriptionEvents.Close, () => h.onClose?.())

  const stop = () => {
    if (stopped) return
    stopped = true
    try { recorder?.state !== 'inactive' && recorder?.stop() } catch { /* */ }
    try { conn.requestClose() } catch { /* */ }
  }

  return { stop }
}
