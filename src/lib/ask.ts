// "Ask the recording": stream a focused AI answer, map its annotations to blue
// world-space marks, and synthesize speech for the spoken explanation.

import type { AIAction, Element } from './types'
import type { SnapshotResult } from './recording/snapshot'

const BLUE = 'oklch(58% 0.19 250)'
let annSeq = 0
const aid = () => `ask_${Date.now().toString(36)}_${annSeq++}`

interface AskOpts {
  image: string | null
  transcriptWindow: string
  question: string
  signal?: AbortSignal
  onToken: (delta: string) => void
}

export class AskError extends Error {}

export async function askStream(opts: AskOpts): Promise<void> {
  const res = await fetch('/api/ask', {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: opts.image, transcriptWindow: opts.transcriptWindow, question: opts.question }),
  })
  if (!res.ok || !res.body) {
    let detail = `ask error ${res.status}`
    try { detail = (await res.json()).error || detail } catch { /* */ }
    throw new AskError(detail)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let err: string | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (data === '[DONE]') return
      try { const evt = JSON.parse(data); if (typeof evt.t === 'string') opts.onToken(evt.t); else if (evt.error) err = evt.error } catch { /* */ }
    }
  }
  if (err) throw new AskError(err)
}

/** Deepgram TTS → an object URL the caller can play and later revoke. */
export async function speak(text: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

/** Map the AI's pixel-space draw actions to blue, world-coordinate elements. */
export function toBlueAnnotations(actions: AIAction[], region: SnapshotResult): Element[] {
  const { originX: ox, originY: oy, scale: s } = region
  const X = (v: number) => v / s + ox
  const Y = (v: number) => v / s + oy
  const L = (v: number) => v / s // length/size in world units
  const out: Element[] = []
  for (const a of actions) {
    if (!a || typeof a.kind !== 'string') continue
    const id = aid()
    if (a.kind === 'text' && typeof a.text === 'string' && a.text.trim()) {
      out.push({ id, type: 'text', author: 'ai', color: BLUE, width: 3, x: X(a.x), y: Y(a.y), text: a.text, size: Math.max(16, L(a.size && a.size > 8 ? a.size : 26)) })
    } else if (a.kind === 'line' || a.kind === 'arrow') {
      out.push({ id, type: a.kind, author: 'ai', color: BLUE, width: 3, x1: X(a.x1), y1: Y(a.y1), x2: X(a.x2), y2: Y(a.y2) })
    } else if (a.kind === 'rect' || a.kind === 'ellipse') {
      out.push({ id, type: a.kind, author: 'ai', color: BLUE, width: 3, x: X(a.x), y: Y(a.y), w: L(a.w), h: L(a.h) })
    } else if (a.kind === 'highlight') {
      out.push({ id, type: 'highlight', author: 'ai', color: BLUE, width: 2, x: X(a.x), y: Y(a.y), w: L(a.w), h: L(a.h) })
    }
  }
  return out
}
