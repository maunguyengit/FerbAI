// Frontend AI client. Talks to the thin backend proxy (server/index.js) which
// holds the keys and normalizes the stream — so the browser never makes a
// cross-origin call to a model provider and never needs CORS workarounds.
//
// The proxy emits a normalized SSE stream: `data: {"t": "<delta>"}` per token,
// `data: {"error": "<message>"}` on failure, and `data: [DONE]` at the end.

import { getApiKey, getBaseUrl } from './storage'
import type { ChatContext, ChatMessage } from './types'

export class AIError extends Error {}

interface ChatOptions {
  providerId: string
  modelId: string
  history: ChatMessage[]
  imageDataURL?: string | null
  /** which left-panel view is active + its content (board geometry or graph eqs) */
  context: ChatContext
  /** force the model to act on the active view (draw or graph) this turn */
  wantAct?: boolean
  signal?: AbortSignal
  onToken: (delta: string) => void
}

export interface ProviderStatus {
  [providerId: string]: { label: string; type: string; configured: boolean }
}

/** Which providers have a key configured in the backend `.env`. */
export async function fetchProviderStatus(signal?: AbortSignal): Promise<ProviderStatus> {
  try {
    const res = await fetch('/api/providers', { signal })
    if (!res.ok) return {}
    return (await res.json()) as ProviderStatus
  } catch {
    return {}
  }
}

export async function streamChat(opts: ChatOptions): Promise<void> {
  // A key pasted in the UI overrides the server's env key for this request only.
  const clientKey = getApiKey(opts.providerId) || undefined
  const baseUrl = getBaseUrl(opts.providerId) || undefined

  const res = await fetch('/api/chat', {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: opts.providerId,
      modelId: opts.modelId,
      image: opts.imageDataURL ?? null,
      context: opts.context,
      wantAct: opts.wantAct ?? false,
      clientKey,
      baseUrl,
      messages: opts.history.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text })),
    }),
  })

  if (!res.ok) {
    let detail = `proxy error ${res.status}`
    try {
      const body = await res.json()
      detail = body?.error || detail
    } catch {
      /* non-JSON */
    }
    if (res.status === 0) {
      throw new AIError('Backend not reachable. Is the API server running? (npm run dev starts both.)')
    }
    throw new AIError(detail)
  }
  if (!res.body) throw new AIError('No response stream from backend.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let streamError: string | null = null

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const evt = JSON.parse(data)
        if (typeof evt.t === 'string') opts.onToken(evt.t)
        else if (evt.error) streamError = evt.error
      } catch {
        /* ignore partial json */
      }
    }
  }

  if (streamError) throw new AIError(streamError)
}
