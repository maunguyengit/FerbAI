import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { PROVIDERS, SYSTEM_PROMPT, envKeyFor } from './providers.js'
import { WebSocketServer } from 'ws'
import { LiveTranscriptionEvents } from '@deepgram/sdk'
import { supabaseAdmin, supabaseEnabled, AUDIO_BUCKET } from './supabase.js'
import { deepgramEnabled, dgClient, LIVE_OPTIONS } from './deepgram.js'

const app = express()
const PORT = process.env.PORT || 8787

app.use(cors())
app.use(express.json({ limit: '12mb' })) // board PNGs can be large

// ---- Deepgram: configured check (the audio relay is a WebSocket, see below) ----
app.get('/api/deepgram/status', (_req, res) => res.json({ configured: deepgramEnabled }))

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
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!r.ok) return res.json({ chapters: [] })
    const body = await r.json()
    const raw = body?.content?.[0]?.text ?? ''
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return res.json({ chapters: [] })
    const parsed = JSON.parse(m[0])
    const chapters = Array.isArray(parsed?.chapters)
      ? parsed.chapters.filter((c) => typeof c?.t === 'number' && typeof c?.title === 'string').sort((a, b) => a.t - b.t)
      : []
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

// ---- streaming chat proxy ----
app.post('/api/chat', async (req, res) => {
  const { providerId, modelId, messages = [], image, clientKey, baseUrl, context, wantAct } = req.body || {}
  const provider = PROVIDERS[providerId]
  const model = provider?.models[modelId]

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
  const suffix = `${note}${directive}`
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
    const upstream =
      provider.type === 'anthropic'
        ? await callAnthropic({ base, apiKey, model: modelId, messages: turns, image, sendImage, signal: abort.signal })
        : await callOpenAI({ base, apiKey, model: modelId, messages: turns, image, sendImage, signal: abort.signal })

    if (!upstream.ok || !upstream.body) {
      const detail = await readError(upstream)
      res.write(`data: ${JSON.stringify({ error: `${provider.label} ${upstream.status}: ${detail}` })}\n\n`)
      return res.end()
    }

    const emit = (text) => res.write(`data: ${JSON.stringify({ t: text })}\n\n`)
    await pumpSSE(upstream.body, (data) => {
      if (data === '[DONE]') return
      try {
        const evt = JSON.parse(data)
        if (provider.type === 'anthropic') {
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') emit(evt.delta.text)
          else if (evt.type === 'error') res.write(`data: ${JSON.stringify({ error: evt.error?.message || 'stream error' })}\n\n`)
        } else {
          const delta = evt.choices?.[0]?.delta?.content
          if (typeof delta === 'string') emit(delta)
        }
      } catch {
        /* keep-alive / partial json */
      }
    })

    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    if (abort.signal.aborted) return res.end()
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

const httpServer = app.listen(PORT, () => {
  const configured = Object.keys(PROVIDERS).filter((id) => envKeyFor(id))
  console.log(`\n  FerbAI proxy → http://localhost:${PORT}`)
  console.log(`  keys from .env: ${configured.length ? configured.join(', ') : '(none — paste in Settings)'}\n`)
})

// ---- Deepgram audio relay ----
// The browser streams mic audio here; we forward it to Deepgram with the
// server-held key and relay transcripts back. Avoids needing browser tokens.
const dgWss = new WebSocketServer({ server: httpServer, path: '/api/deepgram/stream' })
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

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  ✗ Port ${PORT} is already in use — another FerbAI proxy is probably still running.\n` +
        `    Stop it, or set a different port:  PORT=8788 npm run dev\n` +
        `    (Windows: find it with  netstat -ano | findstr :${PORT}  then  taskkill /PID <pid> /F)\n`,
    )
    process.exit(1)
  }
  throw err
})
