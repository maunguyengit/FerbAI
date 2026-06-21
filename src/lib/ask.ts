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

/** Convert the AI's written answer into something a TTS voice reads naturally:
 *  strip markdown, and speak math notation as words ("x squared", "plus or
 *  minus", "equals") instead of symbols ("x caret 2", "star star"). */
const SUP: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' }
export function speakableText(input: string): string {
  let t = input
  t = t.replace(/```[\s\S]*?```/g, ' ')                  // code fences
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')                 // **bold**
  t = t.replace(/__([^_]+)__/g, '$1')                     // __bold__
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1$2') // *italic*
  t = t.replace(/[`_#>]/g, ' ')                           // stray markdown (keep * for multiply)
  t = t.replace(/^\s{0,3}[-•]\s+/gm, '')                  // bullet markers

  // exponents
  t = t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => { const n = [...m].map((c) => SUP[c] ?? '').join(''); return n === '2' ? ' squared' : n === '3' ? ' cubed' : ` to the power ${n}` })
  t = t.replace(/\^\(([^)]+)\)/g, ' to the power ($1)')
  t = t.replace(/\^-?2(?!\d)/g, ' squared').replace(/\^-?3(?!\d)/g, ' cubed')
  t = t.replace(/\^(-?\d+)/g, ' to the power $1').replace(/\^([a-zA-Z])/g, ' to the power $1')

  // symbols → words
  t = t.replace(/±/g, ' plus or minus ').replace(/√\s*/g, ' square root of ')
    .replace(/≈/g, ' approximately ').replace(/≤/g, ' less than or equal to ')
    .replace(/≥/g, ' greater than or equal to ').replace(/≠/g, ' not equal to ')
    .replace(/×/g, ' times ').replace(/÷/g, ' divided by ').replace(/·/g, ' times ')
    .replace(/π/g, ' pi ').replace(/∞/g, ' infinity ').replace(/°/g, ' degrees ').replace(/→/g, ' to ')
  t = t.replace(/=/g, ' equals ')
  t = t.replace(/([\w)\]])\s*\*\s*(?=[\w([])/g, '$1 times ').replace(/\*/g, ' ')       // multiplication (chained)
  t = t.replace(/(\d)\s*\(/g, '$1 times (')                                            // 4(3) → 4 times (3)
  t = t.replace(/([\w)\]])\s*\/\s*([\w([])/g, '$1 over $2')                            // fractions
  t = t.replace(/\+/g, ' plus ')
  t = t.replace(/\s-\s/g, ' minus ').replace(/(\d)\s*-\s*(\d)/g, '$1 minus $2').replace(/\(\s*-\s*/g, '(negative ')

  return t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim()
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
