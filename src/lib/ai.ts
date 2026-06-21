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
  sessionId: string
  userId: string
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

export interface TutorReview {
  verdict: string
  averageScore: number
  dimensions: { name: string; score: number; label: string; rationale: string }[]
  strengths: string[]
  risks: string[]
  recommendations: string[]
  evidence: Record<string, unknown>
  note: string
}

export interface AgentMemoryPacket {
  user: { id?: string; preferences: unknown[] }
  session: {
    id: string
    currentGoal?: string
    taskStatus?: string
    activeView?: string | null
    eventCount: number
    compression: { threshold: number; shouldSlideWindow: boolean; recentWindowSize: number }
  }
  summary: { rolling: string; updatedAt: string; status?: string }
  agent2Reviews: unknown[]
  recentEvents: unknown[]
  longTermSummaries: unknown[]
  entities: unknown[]
  decisions: unknown[]
  generatedAt: string
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

export async function reviewTutorSession(opts: {
  sessionId: string
  userId: string
  history: ChatMessage[]
  context: ChatContext
  lessonGoal?: string
  signal?: AbortSignal
}): Promise<{ review: TutorReview; summary: string }> {
  const boardState = JSON.stringify(opts.context)
  const res = await fetch('/api/tutor-review', {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: opts.history.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text, pending: m.pending })),
      boardState,
      lessonGoal: opts.lessonGoal || '',
      sessionId: opts.sessionId,
      userId: opts.userId,
    }),
  })

  if (!res.ok) {
    let detail = `review error ${res.status}`
    try {
      const body = await res.json()
      detail = body?.error || detail
    } catch {
      /* non-JSON */
    }
    throw new AIError(detail)
  }
  return (await res.json()) as { review: TutorReview; summary: string }
}

export async function appendMemoryEvent(opts: {
  sessionId: string
  type: string
  sourceAgent?: 'agent1' | 'agent2'
  payload?: Record<string, unknown>
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}): Promise<void> {
  await fetch(`/api/memory/${encodeURIComponent(opts.sessionId)}/events`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: opts.type,
      sourceAgent: opts.sourceAgent || 'agent1',
      payload: opts.payload || {},
      metadata: opts.metadata || {},
    }),
  }).catch(() => undefined)
}

export async function finalizeMemorySession(opts: {
  sessionId: string
  userId: string
  context: ChatContext
  lessonGoal?: string
  signal?: AbortSignal
}): Promise<{ summary: { rolling: string; currentGoal?: string; taskStatus?: string; nextRecommendedStep?: string } }> {
  const res = await fetch(`/api/memory/session/${encodeURIComponent(opts.sessionId)}/end`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: opts.userId,
      metadata: {
        context: opts.context,
        activeView: opts.context.mode,
        lessonGoal: opts.lessonGoal || '',
      },
    }),
  })
  if (!res.ok) {
    let detail = `memory finalize error ${res.status}`
    try {
      const body = await res.json()
      detail = body?.error || detail
    } catch {
      /* non-JSON */
    }
    throw new AIError(detail)
  }
  return (await res.json()) as { summary: { rolling: string; currentGoal?: string; taskStatus?: string; nextRecommendedStep?: string } }
}

export async function fetchMemoryPacket(sessionId: string, userId: string, signal?: AbortSignal): Promise<AgentMemoryPacket> {
  const params = new URLSearchParams({ userId })
  const res = await fetch(`/api/memory/${encodeURIComponent(sessionId)}/packet?${params.toString()}`, { signal })
  if (!res.ok) throw new AIError(`memory packet error ${res.status}`)
  return (await res.json()) as AgentMemoryPacket
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
      sessionId: opts.sessionId,
      userId: opts.userId,
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
