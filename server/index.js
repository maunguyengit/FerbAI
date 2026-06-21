import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { PROVIDERS, SYSTEM_PROMPT, envKeyFor } from './providers.js'
import { formatTutorReview, messagesToTranscript, scoreTutorTranscript } from './tutorReview.js'
import {
  appendMemoryEvent,
  finalizeAgent1Session,
  getAgentMemoryPacket,
  writeAgent2ReviewMemory,
} from './memory.js'

const app = express()
const PORT = process.env.PORT || 8787

app.use(cors())
app.use(express.json({ limit: '12mb' })) // board PNGs can be large

// ---- which providers have a key configured (env), for the UI status chips ----
app.get('/api/providers', (_req, res) => {
  const out = {}
  for (const [id, p] of Object.entries(PROVIDERS)) {
    out[id] = { label: p.label, type: p.type, configured: !!envKeyFor(id) }
  }
  res.json(out)
})

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.post('/api/tutor-review', (req, res) => {
  try {
    const { messages = [], transcript, boardState = '', lessonGoal = '', sessionId } = req.body || {}
    const review = scoreTutorTranscript({
      transcript: transcript || messagesToTranscript(messages),
      boardState,
      lessonGoal,
    })
    const summary = formatTutorReview(review)
    if (sessionId) {
      writeAgent2ReviewMemory({ sessionId, review, summary }).catch((err) => {
        console.warn(`[memory] Agent 2 review write failed: ${err?.message || err}`)
      })
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
    const summary = await finalizeAgent1Session({ sessionId, userId, metadata })
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
    const packet = await getAgentMemoryPacket(requestSessionId, {
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

    if (!upstream.ok || !upstream.body) {
      const detail = await readError(upstream)
      appendMemoryEvent(requestSessionId, {
        id: `${requestId}_assistant_failed`,
        sourceAgent: 'agent1',
        type: 'assistant_response_failed',
        payload: { providerId, modelId, error: `${provider.label} ${upstream.status}: ${detail}` },
      }).catch((err) => console.warn(`[memory] failure event write failed: ${err?.message || err}`))
      res.write(`data: ${JSON.stringify({ error: `${provider.label} ${upstream.status}: ${detail}` })}\n\n`)
      return res.end()
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
          else if (evt.type === 'error') res.write(`data: ${JSON.stringify({ error: evt.error?.message || 'stream error' })}\n\n`)
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
