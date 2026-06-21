// Browser-side live transcription. Streams the mic to OUR server (which holds the
// Deepgram key and relays to Deepgram), and receives transcripts back. This works
// with any transcription-capable key — no browser token needed.
// Word timings come back in seconds from stream start.

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

/** Start live transcription of a MediaStream via the server relay. */
export async function startLive(stream: MediaStream, h: Handlers): Promise<LiveSession> {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/api/deepgram/stream`)
  ws.binaryType = 'arraybuffer'

  let recorder: MediaRecorder | null = null
  let stopped = false

  ws.onopen = () => {
    h.onOpen?.()
    try {
      recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(await e.data.arrayBuffer())
        }
      }
      recorder.start(250)
    } catch (e) {
      h.onError?.(e)
    }
  }

  ws.onmessage = (ev) => {
    let msg: any
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.type === 'error') { h.onError?.(msg.error); return }
    if (msg.type !== 'transcript') return
    const alt = msg.data?.channel?.alternatives?.[0]
    const text: string = alt?.transcript ?? ''
    if (!text) return
    if (msg.data.is_final) {
      const words: TWord[] = (alt.words ?? []).map((w: any) => ({
        w: w.punctuated_word ?? w.word,
        start: Math.round((w.start ?? 0) * 1000),
        end: Math.round((w.end ?? 0) * 1000),
      }))
      h.onFinal?.(text, words)
    } else {
      h.onPartial?.(text)
    }
  }

  ws.onerror = (e) => h.onError?.(e)
  ws.onclose = () => h.onClose?.()

  const stop = () => {
    if (stopped) return
    stopped = true
    try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch { /* */ }
    // let the last audio flush, then close
    setTimeout(() => { try { ws.close() } catch { /* */ } }, 250)
  }

  return { stop }
}
