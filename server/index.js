import './instrumentation.mjs'
import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import { PROVIDERS, SYSTEM_PROMPT, ASK_SYSTEM_PROMPT, envKeyFor } from './providers.js'
import { WebSocketServer } from 'ws'
import { LiveTranscriptionEvents } from '@deepgram/sdk'
import { supabaseAdmin, supabaseEnabled, AUDIO_BUCKET } from './supabase.js'
import { deepgramEnabled, dgClient, LIVE_OPTIONS } from './deepgram.js'
import { formatTutorReview, messagesToTranscript, scoreTutorTranscript } from './tutorReview.js'
import {
  appendMemoryEvent,
  finalizeAgent1Session,
  getAgentMemoryPacket,
  getSessionReviewContext,
  warmEmbeddingCache,
  writeAgent2ReviewMemory,
} from './memory.js'
import { getTracingStatus, setSpanAttributes, shutdownTracing, truncate, withSpan } from './instrumentation.mjs'

const app = express()
const PORT = process.env.PORT || 8787
const CHAT_MEMORY_PACKET_TIMEOUT_MS = Number(process.env.CHAT_MEMORY_PACKET_TIMEOUT_MS || 1200)
const DEV_SHUTDOWN_ENABLED = process.env.NODE_ENV !== 'production' && process.env.DEV_SHUTDOWN_ON_CLOSE !== 'false'
let devShutdownTimer = null

app.use(cors())
app.use(express.json({ limit: '12mb' })) // board PNGs can be large

if (process.env.MEMORY_WARM_EMBEDDINGS_ON_START !== 'false') {
  warmEmbeddingCache()
    .then((ready) => {
      if (ready) console.info('[memory] local embedding worker warmed.')
    })
    .catch((err) => console.warn(`[memory] local embedding warmup skipped: ${err?.message || err}`))
}

// ---- Deepgram: configured check (the audio relay is a WebSocket, see below) ----
app.get('/api/deepgram/status', (_req, res) => res.json({ configured: deepgramEnabled }))

// ---- Ask the recording: student paused a lesson + asked a question ----
app.post('/api/ask', async (req, res) => {
  const { image, transcriptWindow, question, sessionId, recordingId, activeView } = req.body || {}
  const apiKey = envKeyFor('claude-code')
  if (!apiKey) return res.status(503).json({ error: 'No Claude key configured.' })

  const content = []
  if (image) {
    try { const { mediaType, base64 } = splitDataUrl(image); content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }) } catch { /* skip image */ }
  }
  content.push({
    type: 'text',
    text: askInputText(transcriptWindow, question),
  })

  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.flushHeaders?.()
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })

  try {
    const streamed = await withSpan('agent1.ask_recording', {
      'openinference.span.kind': 'LLM',
      'attributes.openinference.span.kind': 'LLM',
      'llm.model_name': 'claude-sonnet-4-6',
      'attributes.llm.model_name': 'claude-sonnet-4-6',
      'input.value': truncate(content.find((item) => item.type === 'text')?.text),
      'attributes.input.value': truncate(content.find((item) => item.type === 'text')?.text),
      'session.id': sessionId,
      'recording.id': recordingId,
      'board.active_view': activeView,
      'board.used': !!image,
      'board.image_attached': !!image,
    }, async (span) => {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: abort.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: ASK_SYSTEM_PROMPT, stream: true, messages: [{ role: 'user', content }] }),
      })
      setSpanAttributes(span, { 'http.response.status_code': upstream.status })
      if (!upstream.ok || !upstream.body) {
        const detail = await readError(upstream)
        setSpanAttributes(span, {
          'output.value': `Claude ${upstream.status}: ${detail}`,
          'attributes.output.value': `Claude ${upstream.status}: ${detail}`,
        })
        res.write(`data: ${JSON.stringify({ error: `Claude ${upstream.status}: ${detail}` })}\n\n`)
        res.end()
        return false
      }
      let answerText = ''
      await pumpSSE(upstream.body, (data) => {
        if (data === '[DONE]') return
        try {
          const evt = JSON.parse(data)
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            answerText += evt.delta.text
            res.write(`data: ${JSON.stringify({ t: evt.delta.text })}\n\n`)
          } else if (evt.type === 'error') {
            const message = evt.error?.message || 'stream error'
            setSpanAttributes(span, { 'llm.stream.error': message })
            res.write(`data: ${JSON.stringify({ error: message })}\n\n`)
          }
        } catch { /* */ }
      })
      setSpanAttributes(span, {
        'output.value': truncate(answerText),
        'attributes.output.value': truncate(answerText),
      })
      return true
    })
    if (!streamed) return
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (e) {
    if (abort.signal.aborted) return res.end()
    res.write(`data: ${JSON.stringify({ error: e?.message || 'ask error' })}\n\n`)
    res.end()
  }
})

// ---- Text-to-speech (Deepgram Speak) for the AI's spoken answer ----
app.post('/api/tts', async (req, res) => {
  if (!deepgramEnabled) return res.status(503).json({ error: 'TTS not configured.' })
  const text = (req.body?.text || '').toString().slice(0, 1800).trim()
  if (!text) return res.status(400).json({ error: 'No text.' })
  try {
    const r = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mp3', {
      method: 'POST',
      headers: { authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!r.ok || !r.body) { const t = await r.text().catch(() => ''); return res.status(500).json({ error: t.slice(0, 200) || 'tts failed' }) }
    res.set('content-type', 'audio/mpeg')
    const reader = r.body.getReader()
    for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(Buffer.from(value)) }
    res.end()
  } catch (e) {
    res.status(500).json({ error: e?.message || 'tts error' })
  }
})

// ---- auto-chapters: Claude segments a finished transcript into chapters ----
app.post('/api/chapters', async (req, res) => {
  const words = Array.isArray(req.body?.transcript) ? req.body.transcript : []
  if (!words.length) return res.json({ chapters: [] })
  const apiKey = envKeyFor('claude-code')
  if (!apiKey) return res.json({ chapters: [] }) // no model key → skip chaptering

  // build transcript text with [t=<ms>] markers ~ every 8s of speech
  let text = ''
  let lastStamp = -99999
  for (const w of words) {
    if (typeof w?.start !== 'number') continue
    if (w.start - lastStamp > 8000) { text += ` [t=${Math.round(w.start)}]`; lastStamp = w.start }
    text += ' ' + (w.w ?? '')
  }
  text = text.trim().slice(0, 16000)

  const prompt = `You segment a lesson transcript into chapters, like Zoom. The transcript has [t=<ms>] time markers.
Return ONLY JSON: {"chapters":[{"t":<ms integer>,"title":"<2-5 word topic>"}]}.
Rules: 3-8 chapters, in time order, the first starting at t=0. Each "t" is a millisecond integer at or near a [t=] marker. Titles are short and describe that segment's topic.

Transcript:
${text}`

  try {
    const chapters = await withSpan('agent1.generate_chapters', {
      'openinference.span.kind': 'LLM',
      'attributes.openinference.span.kind': 'LLM',
      'llm.model_name': 'claude-haiku-4-5-20251001',
      'attributes.llm.model_name': 'claude-haiku-4-5-20251001',
      'input.value': truncate(prompt),
      'attributes.input.value': truncate(prompt),
      'transcript.word_count': words.length,
      'session.id': req.body?.sessionId,
      'recording.id': req.body?.recordingId,
    }, async (span) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      })
      setSpanAttributes(span, { 'http.response.status_code': r.status })
      if (!r.ok) return []
      const body = await r.json()
      const raw = body?.content?.[0]?.text ?? ''
      setSpanAttributes(span, { 'llm.raw_output': truncate(raw) })
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) return []
      const parsed = JSON.parse(m[0])
      const chapters = Array.isArray(parsed?.chapters)
        ? parsed.chapters.filter((c) => typeof c?.t === 'number' && typeof c?.title === 'string').sort((a, b) => a.t - b.t)
        : []
      setSpanAttributes(span, {
        'output.value': truncate({ chapters }),
        'attributes.output.value': truncate({ chapters }),
      })
      return chapters
    })
    res.json({ chapters })
  } catch (e) {
    res.json({ chapters: [], error: e?.message })
  }
})

// ---- signed URL for a recording's audio (after verifying the listener) ----
// The browser can read the recording row (RLS allows owner or shared), but the
// audio bucket is private. This endpoint verifies the caller's Supabase token,
// re-checks owner/shared with service_role, then issues a short-lived URL.
app.post('/api/recordings/audio-url', async (req, res) => {
  if (!supabaseEnabled || !supabaseAdmin) return res.status(503).json({ error: 'Storage not configured.' })
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const recordingId = req.body?.recordingId
  if (!token) return res.status(401).json({ error: 'Not signed in.' })
  if (!recordingId) return res.status(400).json({ error: 'Missing recordingId.' })
  try {
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session.' })
    const uid = userData.user.id

    const { data: rec, error: recErr } = await supabaseAdmin
      .from('recordings').select('owner, shared, audio_path').eq('id', recordingId).single()
    if (recErr || !rec) return res.status(404).json({ error: 'Recording not found.' })
    if (rec.owner !== uid && !rec.shared) return res.status(403).json({ error: 'Not allowed.' })
    if (!rec.audio_path) return res.json({ url: null }) // silent recording

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage.from(AUDIO_BUCKET).createSignedUrl(rec.audio_path, 3600)
    if (signErr) return res.status(500).json({ error: signErr.message })
    res.json({ url: signed.signedUrl })
  } catch (e) {
    res.status(500).json({ error: e?.message || 'audio url error' })
  }
})

// ---- which providers have a key configured (env), for the UI status chips ----
app.get('/api/providers', (_req, res) => {
  const out = {}
  for (const [id, p] of Object.entries(PROVIDERS)) {
    out[id] = { label: p.label, type: p.type, configured: !!envKeyFor(id) }
  }
  res.json(out)
})

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.get('/api/tracing/status', (_req, res) => res.json(getTracingStatus()))

app.post('/api/dev/shutdown', (req, res) => {
  if (!DEV_SHUTDOWN_ENABLED) return res.status(404).json({ error: 'Dev shutdown is disabled.' })
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Dev shutdown only accepts local requests.' })
  const requestedDelay = Number(req.body?.delayMs ?? req.query?.delayMs ?? 5000)
  const delayMs = Math.min(15000, Math.max(1000, Number.isFinite(requestedDelay) ? requestedDelay : 5000))
  scheduleDevShutdown(delayMs)
  res.json({ scheduled: true, delayMs })
})

app.post('/api/dev/shutdown/cancel', (req, res) => {
  if (!DEV_SHUTDOWN_ENABLED) return res.status(404).json({ error: 'Dev shutdown is disabled.' })
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Dev shutdown only accepts local requests.' })
  const canceled = cancelDevShutdown()
  res.json({ canceled })
})

app.post('/api/tutor-review', async (req, res) => {
  try {
    const { messages = [], transcript, boardState = '', lessonGoal = '', sessionId, userId, recordingId } = req.body || {}
    const review = scoreTutorTranscript({
      transcript: transcript || messagesToTranscript(messages),
      boardState,
      lessonGoal,
      sessionId,
      userId,
      recordingId,
    })
    const summary = formatTutorReview(review)
    if (sessionId) {
      await writeAgent2ReviewMemory({ sessionId, review, summary })
    }
    res.json({ review, summary })
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Could not review the tutoring session.' })
  }
})

app.post('/api/memory/session/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params
    const { metadata = {}, userId = 'local-user' } = req.body || {}
    const summary = await withSpan('tutoring_session', {
      'openinference.span.kind': 'CHAIN',
      'attributes.openinference.span.kind': 'CHAIN',
      'session.id': sessionId,
      'user.id': userId,
      'recording.id': metadata?.recordingId,
      'lesson.goal': metadata?.lessonGoal,
      'input.value': truncate({ sessionId, metadata }),
      'attributes.input.value': truncate({ sessionId, metadata }),
    }, async (span) => {
      const agent2 = await ensureAgent2ReviewForEndedSession({ sessionId, userId, metadata })
      setSpanAttributes(span, {
        'agent2.auto_review.triggered': agent2.triggered,
        'agent2.auto_review.skipped_reason': agent2.skippedReason,
        'agent2.auto_review.verdict': agent2.review?.verdict,
      })
      const summary = await finalizeAgent1Session({ sessionId, userId, metadata })
      setSpanAttributes(span, {
        'output.value': truncate(summary),
        'attributes.output.value': truncate(summary),
        'memory.summary.created': !!summary,
      })
      return summary
    })
    res.json({ summary })
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Could not finalize session memory.' })
  }
})

app.get('/api/memory/:sessionId/packet', async (req, res) => {
  try {
    const packet = await getAgentMemoryPacket(req.params.sessionId, req.query || {})
    res.json(packet)
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Could not read memory packet.' })
  }
})

app.post('/api/memory/:sessionId/events', async (req, res) => {
  try {
    const event = await appendMemoryEvent(req.params.sessionId, req.body || {})
    res.json({ event })
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Could not append memory event.' })
  }
})

// ---- streaming chat proxy ----
app.post('/api/chat', async (req, res) => {
  const { providerId, modelId, messages = [], image, clientKey, baseUrl, context, wantAct, sessionId, userId = 'local-user' } = req.body || {}
  const provider = PROVIDERS[providerId]
  const model = provider?.models[modelId]
  const requestSessionId = sessionId || `session_${Date.now().toString(36)}`
  const requestId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  const fail = (status, message) => {
    if (!res.headersSent) {
      res.status(status).set('content-type', 'application/json').end(JSON.stringify({ error: message }))
    } else {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`)
      res.end()
    }
  }

  if (!provider || !model) return fail(400, 'Unknown model selection.')

  const apiKey = (clientKey && clientKey.trim()) || envKeyFor(providerId)
  if (!apiKey) {
    return fail(401, `No API key for ${provider.label}. Add it to .env (${provider.envKey}) or paste it in Settings.`)
  }

  const base = (baseUrl?.trim() || provider.defaultBaseUrl).replace(/\/+$/, '')
  const sendImage = !!image && model.vision

  // Attach the board geometry to the latest user turn so the model can place
  // its writing accurately (where the empty space is) instead of guessing.
  const mode = context?.mode === 'graph' ? 'graph' : context?.mode === 'viz' ? 'viz' : 'board'
  const note = mode === 'graph' ? graphNote(context?.graph)
    : mode === 'viz' ? vizNote(context?.viz)
    : boardNote(context?.boardMeta)
  const directive = !wantAct ? '' : mode === 'graph'
    ? `\n\n[GRAPH IT: For THIS turn you MUST include exactly one ferbai-graph block with the requested function(s). Keep spoken guidance short and outside the block.]`
    : mode === 'viz'
    ? `\n\n[BUILD IT: For THIS turn you MUST include exactly one ferbai-viz block selecting the most fitting widget (prefer a built-in over custom). Keep spoken guidance short and outside the block.]`
    : `\n\n[ACT ON THE BOARD: For THIS turn you MUST include exactly one ferbai-draw block that writes your next step in the empty space (do not overlap their work). Keep spoken guidance short and outside the block.]`
  const turns = messages.map((m) => ({ ...m }))
  const latestUserTurn = [...turns].reverse().find((turn) => turn.role === 'user')
  appendMemoryEvent(requestSessionId, {
    id: `${requestId}_user`,
    sourceAgent: 'agent1',
    type: 'user_message_received',
    payload: {
      text: latestUserTurn?.text || '',
      userId,
      providerId,
      modelId,
      context,
      wantAct: !!wantAct,
      imageAttached: !!image,
    },
  }).catch((err) => console.warn(`[memory] user event write failed: ${err?.message || err}`))
  let memoryNote = ''
  try {
    const packet = await getChatMemoryPacket(requestSessionId, {
      userId,
      queryText: latestUserTurn?.text || '',
      activeView: mode,
    })
    memoryNote = formatAgentMemoryGuidance(packet)
  } catch (err) {
    console.warn(`[memory] packet read failed: ${err?.message || err}`)
  }
  const suffix = `${memoryNote}${note}${directive}`
  if (suffix) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user') {
        turns[i].text = `${turns[i].text || ''}${suffix}`
        break
      }
    }
  }

  // open the SSE stream to the browser
  res.set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()

  const abort = new AbortController()
  // Abort the upstream only if the CLIENT disconnects before we finish.
  // (Listening on req 'close' is wrong — it fires as soon as Express finishes
  //  reading the request body, which would abort every request immediately.)
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })

  try {
    const streamed = await withSpan('agent1.chat', {
      'openinference.span.kind': 'LLM',
      'attributes.openinference.span.kind': 'LLM',
      'llm.provider': providerId,
      'llm.model_name': modelId,
      'attributes.llm.model_name': modelId,
      'input.value': truncate(latestUserTurn?.text || ''),
      'attributes.input.value': truncate(latestUserTurn?.text || ''),
      'session.id': requestSessionId,
      'user.id': userId,
      'request.id': requestId,
      'board.active_view': mode,
      'board.used': !!image,
      'board.image_attached': !!image,
      'agent1.want_act': !!wantAct,
      'memory.context_attached': !!memoryNote,
    }, async (span) => {
      await appendMemoryEvent(requestSessionId, {
        id: `${requestId}_assistant_started`,
        sourceAgent: 'agent1',
        type: 'assistant_response_started',
        payload: { providerId, modelId, mode },
      })
      const upstream =
        provider.type === 'anthropic'
          ? await callAnthropic({ base, apiKey, model: modelId, messages: turns, image, sendImage, signal: abort.signal })
          : await callOpenAI({ base, apiKey, model: modelId, messages: turns, image, sendImage, signal: abort.signal })

      setSpanAttributes(span, { 'http.response.status_code': upstream.status })

      if (!upstream.ok || !upstream.body) {
        const detail = await readError(upstream)
        const message = `${provider.label} ${upstream.status}: ${detail}`
        setSpanAttributes(span, {
          'output.value': message,
          'attributes.output.value': message,
        })
        appendMemoryEvent(requestSessionId, {
          id: `${requestId}_assistant_failed`,
          sourceAgent: 'agent1',
          type: 'assistant_response_failed',
          payload: { providerId, modelId, error: message },
        }).catch((err) => console.warn(`[memory] failure event write failed: ${err?.message || err}`))
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`)
        res.end()
        return false
      }

      let assistantText = ''
      const emit = (text) => {
        assistantText += text
        res.write(`data: ${JSON.stringify({ t: text })}\n\n`)
      }
      await pumpSSE(upstream.body, (data) => {
        if (data === '[DONE]') return
        try {
          const evt = JSON.parse(data)
          if (provider.type === 'anthropic') {
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') emit(evt.delta.text)
            else if (evt.type === 'error') {
              const message = evt.error?.message || 'stream error'
              setSpanAttributes(span, { 'llm.stream.error': message })
              res.write(`data: ${JSON.stringify({ error: message })}\n\n`)
            }
          } else {
            const delta = evt.choices?.[0]?.delta?.content
            if (typeof delta === 'string') emit(delta)
          }
        } catch {
          /* keep-alive / partial json */
        }
      })
      await appendMemoryEvent(requestSessionId, {
        id: `${requestId}_assistant_completed`,
        sourceAgent: 'agent1',
        type: 'assistant_response_completed',
        payload: { providerId, modelId, text: assistantText, mode },
      })
      setSpanAttributes(span, {
        'output.value': truncate(assistantText),
        'attributes.output.value': truncate(assistantText),
        'llm.response.length': assistantText.length,
      })
      return true
    })
    if (!streamed) return

    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    if (abort.signal.aborted) return res.end()
    appendMemoryEvent(requestSessionId, {
      id: `${requestId}_assistant_failed`,
      sourceAgent: 'agent1',
      type: 'assistant_response_failed',
      payload: { providerId, modelId, error: err?.message || 'proxy error' },
    }).catch((writeErr) => console.warn(`[memory] failure event write failed: ${writeErr?.message || writeErr}`))
    res.write(`data: ${JSON.stringify({ error: err?.message || 'proxy error' })}\n\n`)
    res.end()
  }
})

// Compact, factual description of the board geometry for the model.
function boardNote(meta) {
  if (!meta || !meta.width || !meta.height) return ''
  const { width, height, content } = meta
  if (!content) {
    return `\n\n[BOARD: ${width}x${height}px, origin top-left, y down. The board is currently EMPTY — start writing near the top-left, e.g. around x=40, y=60.]`
  }
  const right = content.x + content.w
  const bottom = content.y + content.h
  const belowY = Math.min(height - 30, bottom + 40)
  const rightX = Math.min(width - 30, right + 40)
  return (
    `\n\n[BOARD: ${width}x${height}px, origin top-left, y down. ` +
    `Student's work occupies x[${content.x}..${right}] y[${content.y}..${bottom}]. ` +
    `EMPTY space is below (y>=${bottom + 24}) and to the right (x>=${right + 24}). ` +
    `Place your writing there — e.g. a new line at x=${content.x}, y=${belowY}, or to the right at x=${rightX}, y=${content.y}. ` +
    `Do NOT overlap the student's work.]`
  )
}

// Compact description of the graph window for the model.
function graphNote(graph) {
  const dim = graph?.dim === '3d' ? '3D' : '2D'
  const eqs = Array.isArray(graph?.equations) ? graph.equations : []
  const list = eqs.length ? eqs.map((e) => `"${e}"`).join(', ') : 'none yet'
  return (
    `\n\n[GRAPH VIEW is active (${dim}). Currently plotted: ${list}. ` +
    `To plot, emit a ferbai-graph JSON block: {"equations":[{"eq":"y=x^3+3x^2","color":"clay","label":"f"}]}. ` +
    `Syntax: explicit y=f(x); 3D surface z=f(x,y); implicit relations like x^2+y^2+z^2=9 (uses z => 3D). ` +
    `Use ^ for powers and * for multiplication. Compute any derivative/integral/intersection YOURSELF and emit the resulting function(s). ` +
    `Your equations are ADDED to whatever is already plotted; only restate an existing one if asked to change it.]`
  )
}

// Describe the Learn/visualization view + the menu of reusable widgets.
function vizNote(viz) {
  const cur = viz?.current
    ? `Currently showing the "${viz.current.widget}" interactive ("${viz.current.title}").`
    : 'Nothing is shown yet.'
  const catalog = viz?.catalog || '(no widget catalog provided)'
  return (
    `\n\n[LEARN VIEW is active. ${cur}\n` +
    `Build an interactive lesson by emitting a ferbai-viz JSON block: ` +
    `{"widget":"<key>","title":"...","intro":"1-2 sentences","data":{...},"narration":["step 1","step 2"]}.\n` +
    `STRONGLY PREFER a built-in widget below — they are pre-built, bug-free, and fully interactive (the user can step, edit, drag). ` +
    `Only fall back to "custom" when nothing fits, and then put the raw HTML in a SEPARATE ferbai-html block (not inside the JSON).\n` +
    `Available widgets:\n${catalog}\n` +
    `Pick the best-fitting widget, fill in its data, and write a short intro. Keep your spoken guidance OUTSIDE the block.]`
  )
}

function formatAgentMemoryGuidance(packet) {
  const notes = []
  const guidance = Array.isArray(packet?.agent2Guidance) ? packet.agent2Guidance : []
  const similar = Array.isArray(packet?.similarSummaries) ? packet.similarSummaries : []

  if (guidance.length) {
    const lines = guidance
      .slice(-5)
      .map((item) => `- ${item.type || 'note'} (${item.verdict || 'review'}, confidence ${item.confidence ?? 'n/a'}): ${String(item.text || '').slice(0, 220)}`)
    notes.push(`Agent 2 coaching notes are advisory, not hard rules:\n${lines.join('\n')}`)
  }

  if (similar.length) {
    const lines = similar
      .slice(0, 3)
      .map((item) => {
        const topics = item.topics?.length ? ` topics=${item.topics.slice(0, 5).join(', ')}` : ''
        return `- score ${item.score}:${topics} ${String(item.rolling || '').slice(0, 240)}`
      })
    notes.push(`Similar prior session summaries for this user:\n${lines.join('\n')}`)
  }

  if (!notes.length) return ''
  return `\n\n[MEMORY CONTEXT FOR AGENT 1:\n${notes.join('\n\n')}\nUse this to adapt your tutoring style and avoid repeated mistakes. Do not mention this memory block unless the user asks.]`
}

// ---------------------------------------------------------------- upstream calls
function buildHistory(messages, image, sendImage, shape) {
  return messages
    .filter((m) => m && m.text !== undefined)
    .map((m, i, arr) => {
      const isLast = i === arr.length - 1
      const attach = m.role === 'user' && isLast && sendImage && image
      if (shape === 'anthropic') {
        if (attach) {
          const { mediaType, base64 } = splitDataUrl(image)
          return {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: m.text || 'Here is my whiteboard. What should I do next?' },
            ],
          }
        }
        return { role: m.role, content: m.text }
      }
      // openai
      if (attach) {
        return {
          role: 'user',
          content: [
            { type: 'text', text: m.text || 'Here is my whiteboard. What should I do next?' },
            { type: 'image_url', image_url: { url: image } },
          ],
        }
      }
      return { role: m.role, content: m.text }
    })
}

function callAnthropic({ base, apiKey, model, messages, image, sendImage, signal }) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      stream: true,
      messages: buildHistory(messages, image, sendImage, 'anthropic'),
    }),
  })
}

function callOpenAI({ base, apiKey, model, messages, image, sendImage, signal }) {
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 4096,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...buildHistory(messages, image, sendImage, 'openai')],
    }),
  })
}

// ---------------------------------------------------------------- helpers
function askInputText(transcriptWindow, question) {
  return `Teacher's explanation around this moment:\n"""\n${(transcriptWindow || '(no transcript available for this moment)').slice(0, 4000)}\n"""\n\nStudent's question: "${(question || '').slice(0, 600)}"`
}

async function ensureAgent2ReviewForEndedSession({ sessionId, userId, metadata = {} }) {
  const context = await getSessionReviewContext(sessionId)
  if (context.hasAgent2Review) return { triggered: false, skippedReason: 'already_reviewed' }
  if (!context.hasSubstantiveQuestion) return { triggered: false, skippedReason: 'no_substantive_student_turn' }
  if (!context.transcript.trim()) return { triggered: false, skippedReason: 'empty_transcript' }

  const review = scoreTutorTranscript({
    transcript: context.transcript,
    boardState: JSON.stringify(metadata.context || metadata.boardState || ''),
    lessonGoal: metadata.lessonGoal || '',
    sessionId,
    userId,
    recordingId: metadata.recordingId,
  })
  const summary = formatTutorReview(review)
  await writeAgent2ReviewMemory({ sessionId, review, summary })
  return { triggered: true, review, summary }
}

async function getChatMemoryPacket(sessionId, filters) {
  const fullPacket = getAgentMemoryPacket(sessionId, filters)
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), CHAT_MEMORY_PACKET_TIMEOUT_MS)
  })
  const packet = await Promise.race([fullPacket, timeout])
  if (packet) return packet

  console.warn(`[memory] semantic packet timed out after ${CHAT_MEMORY_PACKET_TIMEOUT_MS}ms; using fast session memory.`)
  return getAgentMemoryPacket(sessionId, { ...filters, includeSemantic: false })
}

async function pumpSSE(body, onData) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('data:')) onData(t.slice(5).trim())
    }
  }
}

function splitDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl)
  if (!m) throw new Error('Could not read the board image.')
  return { mediaType: m[1], base64: m[2] }
}

async function readError(res) {
  try {
    const body = await res.json()
    return body?.error?.message || body?.message || JSON.stringify(body)
  } catch {
    return (await res.text().catch(() => '')) || 'request failed'
  }
}

const httpServer = createServer(app)
httpServer.on('error', handleServerError)

// ---- Deepgram audio relay ----
// The browser streams mic audio here; we forward it to Deepgram with the
// server-held key and relay transcripts back. Avoids needing browser tokens.
const dgWss = new WebSocketServer({ server: httpServer, path: '/api/deepgram/stream' })
dgWss.on('error', handleServerError)
dgWss.on('connection', (client) => {
  if (!deepgramEnabled || !dgClient) { client.close(); return }
  const dg = dgClient.listen.live(LIVE_OPTIONS)
  let dgOpen = false
  const queue = []
  const flush = () => { while (queue.length) dg.send(queue.shift()) }

  dg.on(LiveTranscriptionEvents.Open, () => { dgOpen = true; flush(); safeSend(client, { type: 'open' }) })
  dg.on(LiveTranscriptionEvents.Transcript, (data) => safeSend(client, { type: 'transcript', data }))
  dg.on(LiveTranscriptionEvents.Error, (e) => safeSend(client, { type: 'error', error: String(e?.message || e) }))
  dg.on(LiveTranscriptionEvents.Close, () => { try { client.close() } catch { /* */ } })

  client.on('message', (chunk) => {
    if (dgOpen) dg.send(chunk)
    else queue.push(chunk)
  })
  client.on('close', () => { try { dg.requestClose() } catch { /* */ } })
  client.on('error', () => { try { dg.requestClose() } catch { /* */ } })
})
function safeSend(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)) } catch { /* */ } }

function isLocalRequest(req) {
  const remote = req.ip || req.socket?.remoteAddress || ''
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || remote.endsWith(':127.0.0.1')
}

function cancelDevShutdown() {
  if (!devShutdownTimer) return false
  clearTimeout(devShutdownTimer)
  devShutdownTimer = null
  console.info('[dev] canceled tab-close shutdown.')
  return true
}

function scheduleDevShutdown(delayMs) {
  cancelDevShutdown()
  console.info(`[dev] tab-close shutdown scheduled in ${delayMs}ms.`)
  devShutdownTimer = setTimeout(() => {
    console.info('[dev] shutting down API after browser tab close.')
    dgWss.close(() => {
      httpServer.close(async () => {
        await shutdownTracing()
        process.exit(0)
      })
    })
    setTimeout(async () => {
      await shutdownTracing()
      process.exit(0)
    }, 3000).unref()
  }, delayMs)
  devShutdownTimer.unref?.()
}

function handleServerError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  ✗ Port ${PORT} is already in use — another FerbAI proxy is probably still running.\n` +
        `    Stop it, or set a different port:  $env:PORT=8788; $env:VITE_API_TARGET='http://localhost:8788'; npm run dev\n` +
        `    (Windows: find it with  netstat -ano | findstr :${PORT}  then  taskkill /PID <pid> /F)\n`,
    )
    process.exit(1)
  }
  throw err
}

httpServer.listen(PORT, () => {
  const configured = Object.keys(PROVIDERS).filter((id) => envKeyFor(id))
  console.log(`\n  FerbAI proxy -> http://localhost:${PORT}`)
  console.log(`  keys from .env: ${configured.length ? configured.join(', ') : '(none - paste in Settings)'}\n`)
})
