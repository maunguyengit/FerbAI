import 'dotenv/config'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from 'redis'
import { messagesToTranscript } from './tutorReview.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVENT_TTL_SECONDS = Number(process.env.MEMORY_EVENT_TTL_SECONDS || 60 * 60 * 24 * 7)
const RECENT_EVENT_LIMIT = Number(process.env.MEMORY_RECENT_EVENT_LIMIT || 12)
const SUMMARY_COMPRESSION_EVENT_THRESHOLD = Number(process.env.MEMORY_SUMMARY_EVENT_THRESHOLD || 60)
const LONG_TERM_SUMMARY_LIMIT = Number(process.env.MEMORY_LONG_TERM_SUMMARY_LIMIT || 5)
const SIMILARITY_THRESHOLD = Number(process.env.MEMORY_SIMILARITY_THRESHOLD || 0.9)
const SIMILARITY_LIMIT = Number(process.env.MEMORY_SIMILARITY_LIMIT || 3)
const VECTOR_BACKEND = process.env.MEMORY_VECTOR_BACKEND || 'redis-stack'
const DEFAULT_HF_EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'

const fallback = {
  events: new Map(),
  state: new Map(),
  summaries: [],
  facts: new Map(),
}

let redisClient = null
let redisReady = false
let redisConnectPromise = null
const ensuredVectorIndexes = new Set()

function nowIso() {
  return new Date().toISOString()
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

function memoryKey(sessionId, suffix) {
  return `ferbai:memory:session:${sessionId}:${suffix}`
}

function longTermKey(kind) {
  return `ferbai:memory:long:${kind}`
}

function userMemoryKey(userId, kind) {
  return `ferbai:memory:user:${userId || 'local-user'}:${kind}`
}

function vectorIndexName(dim) {
  return `ferbai_summary_vector_idx_${dim}`
}

function vectorSummaryPrefix(dim) {
  return `ferbai:vector:summary:${dim}:`
}

function vectorSummaryKey(dim, recordId) {
  return `${vectorSummaryPrefix(dim)}${recordId}`
}

function safeJson(value, fallbackValue = null) {
  if (value == null) return fallbackValue
  try {
    return JSON.parse(value)
  } catch {
    return fallbackValue
  }
}

function scrubEventPayload(payload = {}) {
  const clone = { ...payload }
  delete clone.clientKey
  delete clone.apiKey
  delete clone.image
  delete clone.imageDataURL
  if (clone.imageAttached) clone.imageAttached = true
  return clone
}

async function getRedis() {
  if (!process.env.REDIS_URL) return null
  if (redisReady && redisClient) return redisClient
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL })
    redisClient.on('error', (err) => {
      redisReady = false
      console.warn(`[memory] Redis unavailable: ${err?.message || err}`)
    })
  }
  if (!redisConnectPromise) {
    redisConnectPromise = redisClient.connect()
      .then(() => {
        redisReady = true
        return redisClient
      })
      .catch((err) => {
        redisReady = false
        redisConnectPromise = null
        console.warn(`[memory] Redis connect failed; using fallback memory: ${err?.message || err}`)
        return null
      })
  }
  return redisConnectPromise
}

async function readEvents(sessionId) {
  const redis = await getRedis()
  if (redis) {
    const rows = await redis.lRange(memoryKey(sessionId, 'events'), 0, -1)
    return rows.map((row) => safeJson(row)).filter(Boolean)
  }
  return fallback.events.get(sessionId) || []
}

async function writeState(sessionId, state) {
  const redis = await getRedis()
  if (redis) {
    await redis.set(memoryKey(sessionId, 'state'), JSON.stringify(state))
    await redis.expire(memoryKey(sessionId, 'state'), EVENT_TTL_SECONDS)
    return
  }
  fallback.state.set(sessionId, state)
}

async function readState(sessionId) {
  const redis = await getRedis()
  if (redis) return safeJson(await redis.get(memoryKey(sessionId, 'state')), {})
  return fallback.state.get(sessionId) || {}
}

async function appendLongTermSummary(summary) {
  const redis = await getRedis()
  if (redis) {
    await redis.lPush(longTermKey('summaries'), JSON.stringify(summary))
    await redis.lTrim(longTermKey('summaries'), 0, 99)
    return
  }
  fallback.summaries.unshift(summary)
  fallback.summaries = fallback.summaries.slice(0, 100)
}

async function readLongTermSummaries(limit = LONG_TERM_SUMMARY_LIMIT) {
  const redis = await getRedis()
  if (redis) {
    const rows = await redis.lRange(longTermKey('summaries'), 0, limit - 1)
    return rows.map((row) => safeJson(row)).filter(Boolean)
  }
  return fallback.summaries.slice(0, limit)
}

async function appendUserSemanticSummary(userId, record) {
  const redis = await getRedis()
  if (redis) {
    await writeVectorSummary(redis, userId, record)
    await redis.lPush(userMemoryKey(userId, 'summary_embeddings'), JSON.stringify(record))
    await redis.lTrim(userMemoryKey(userId, 'summary_embeddings'), 0, 199)
    return
  }
  const key = userId || 'local-user'
  const rows = fallback.facts.get(key) || []
  rows.unshift(record)
  fallback.facts.set(key, rows.slice(0, 200))
}

async function readUserSemanticSummaries(userId) {
  const redis = await getRedis()
  if (redis) {
    const rows = await redis.lRange(userMemoryKey(userId, 'summary_embeddings'), 0, -1)
    return rows.map((row) => safeJson(row)).filter(Boolean)
  }
  return fallback.facts.get(userId || 'local-user') || []
}

function vectorBuffer(vector) {
  const values = new Float32Array(vector.map((value) => Number(value) || 0))
  return Buffer.from(values.buffer)
}

function escapeTag(value) {
  return String(value || 'local-user').replace(/([,.<>{}\[\]"':;!@#$%^&*()\-+=~ ])/g, '\\$1')
}

async function ensureVectorIndex(redis, dim) {
  if (VECTOR_BACKEND !== 'redis-stack') return false
  const index = vectorIndexName(dim)
  if (ensuredVectorIndexes.has(index)) return true
  try {
    await redis.sendCommand(['FT.INFO', index])
    ensuredVectorIndexes.add(index)
    return true
  } catch {
    try {
      await redis.sendCommand([
        'FT.CREATE', index,
        'ON', 'HASH',
        'PREFIX', '1', vectorSummaryPrefix(dim),
        'SCHEMA',
        'userId', 'TAG',
        'sessionId', 'TAG',
        'summaryId', 'TAG',
        'topics', 'TEXT',
        'rolling', 'TEXT',
        'nextRecommendedStep', 'TEXT',
        'createdAt', 'NUMERIC',
        'embedding', 'VECTOR', 'FLAT', '6',
        'TYPE', 'FLOAT32',
        'DIM', String(dim),
        'DISTANCE_METRIC', 'COSINE',
      ])
      ensuredVectorIndexes.add(index)
      return true
    } catch (err) {
      console.warn(`[memory] Redis vector index unavailable; using app-side cosine fallback: ${err?.message || err}`)
      return false
    }
  }
}

async function writeVectorSummary(redis, userId, record) {
  if (!Array.isArray(record.embedding) || record.embedding.length === 0) return false
  const dim = record.embedding.length
  const ready = await ensureVectorIndex(redis, dim)
  if (!ready) return false
  const key = vectorSummaryKey(dim, record.id)
  try {
    await redis.sendCommand([
      'HSET', key,
      'userId', userId || 'local-user',
      'sessionId', record.sessionId,
      'summaryId', record.summaryId,
      'topics', (record.topics || []).join(', '),
      'rolling', record.rolling || '',
      'nextRecommendedStep', record.nextRecommendedStep || '',
      'createdAt', String(Date.parse(record.createdAt || nowIso()) || Date.now()),
      'embedding', vectorBuffer(record.embedding),
    ])
    return true
  } catch (err) {
    console.warn(`[memory] Redis vector write failed; using list fallback: ${err?.message || err}`)
    return false
  }
}

function parseFtSearchRows(rows) {
  const docs = []
  if (rows?.results && Array.isArray(rows.results)) {
    return rows.results.map((result) => result.extra_attributes || {}).filter(Boolean)
  }
  if (!Array.isArray(rows)) return docs
  for (let i = 1; i < rows.length; i += 2) {
    const fields = rows[i + 1]
    if (!Array.isArray(fields)) continue
    const doc = {}
    for (let j = 0; j < fields.length; j += 2) {
      doc[String(fields[j])] = fields[j + 1]
    }
    docs.push(doc)
  }
  return docs
}

async function readSimilarSummariesFromVector(userId, queryEmbedding, {
  threshold = SIMILARITY_THRESHOLD,
  limit = SIMILARITY_LIMIT,
  excludeSessionId = '',
} = {}) {
  const redis = await getRedis()
  if (!redis || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) return null
  const dim = queryEmbedding.length
  const ready = await ensureVectorIndex(redis, dim)
  if (!ready) return null
  const distanceThreshold = Math.max(0, 1 - threshold)
  const candidateLimit = Math.max(limit * 5, limit)
  try {
    const rows = await redis.sendCommand([
      'FT.SEARCH', vectorIndexName(dim),
      `(@userId:{${escapeTag(userId)}})=>[KNN ${candidateLimit} @embedding $BLOB AS vector_score]`,
      'PARAMS', '2', 'BLOB', vectorBuffer(queryEmbedding),
      'SORTBY', 'vector_score', 'ASC',
      'RETURN', '7', 'vector_score', 'summaryId', 'sessionId', 'topics', 'rolling', 'nextRecommendedStep', 'createdAt',
      'DIALECT', '2',
    ])
    return parseFtSearchRows(rows)
      .map((row) => {
        const distance = Number(row.vector_score)
        return {
          score: Number((1 - distance).toFixed(4)),
          distance,
          summaryId: row.summaryId,
          sessionId: row.sessionId,
          topics: String(row.topics || '').split(',').map((topic) => topic.trim()).filter(Boolean),
          rolling: row.rolling || '',
          nextRecommendedStep: row.nextRecommendedStep || '',
        }
      })
      .filter((row) => row.sessionId !== excludeSessionId && row.distance <= distanceThreshold)
      .slice(0, limit)
  } catch (err) {
    console.warn(`[memory] Redis vector search failed; using app-side cosine fallback: ${err?.message || err}`)
    return null
  }
}

function embeddingConfig() {
  const apiKey = process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY || ''
  const baseUrl = (process.env.EMBEDDINGS_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small'
  return { apiKey, baseUrl, model, configured: !!apiKey }
}

async function embedText(text) {
  const backend = (process.env.MEMORY_EMBEDDINGS_BACKEND || 'openai').toLowerCase()
  if (backend === 'none' || backend === 'off' || backend === 'disabled') return null
  if (backend === 'redisvl-hf' || backend === 'hf' || backend === 'sentence-transformers') {
    const embedding = await embedTextWithRedisVl(text)
    if (embedding) return embedding
    if (!embeddingConfig().configured) return null
    console.warn('[memory] falling back to OpenAI-compatible embeddings after local RedisVL embedding failed.')
  }
  return embedTextWithOpenAiCompatible(text)
}

async function embedTextWithOpenAiCompatible(text) {
  const config = embeddingConfig()
  if (!config.configured) return null
  try {
    const res = await fetch(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: text.slice(0, 8000) }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.warn(`[memory] embedding request failed ${res.status}: ${detail.slice(0, 200)}`)
      return null
    }
    const body = await res.json()
    const embedding = body?.data?.[0]?.embedding
    return Array.isArray(embedding) ? embedding : null
  } catch (err) {
    console.warn(`[memory] embedding request failed: ${err?.message || err}`)
    return null
  }
}

async function embedTextWithRedisVl(text) {
  try {
    const result = await runEmbeddingHelper({
      text: text.slice(0, 8000),
      model: process.env.MEMORY_HF_MODEL || DEFAULT_HF_EMBEDDING_MODEL,
    })
    const embedding = result?.embedding
    return Array.isArray(embedding) && embedding.length ? embedding : null
  } catch (err) {
    console.warn(`[memory] local RedisVL embedding failed: ${err?.message || err}`)
    return null
  }
}

function runEmbeddingHelper(payload) {
  const script = join(__dirname, 'redisvl_embed.py')
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(process.env.MEMORY_EMBEDDING_TIMEOUT_MS || 120000)
    const child = spawn(process.env.PYTHON_BIN || 'python', [script], {
      cwd: join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`embedding helper timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error((stderr || stdout || `embedding helper exited with code ${code}`).slice(0, 1000)))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (err) {
        reject(new Error(`embedding helper returned invalid JSON: ${err?.message || err}`))
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]) || 0
    const bv = Number(b[i]) || 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (!normA || !normB) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function findSimilarSummaryMatches(queryEmbedding, records, {
  threshold = SIMILARITY_THRESHOLD,
  limit = SIMILARITY_LIMIT,
  excludeSessionId = '',
} = {}) {
  if (!Array.isArray(queryEmbedding)) return []
  return records
    .filter((record) => record && Array.isArray(record.embedding) && record.sessionId !== excludeSessionId)
    .map((record) => ({ ...record, score: cosineSimilarity(queryEmbedding, record.embedding) }))
    .filter((record) => record.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((record) => ({
      score: Number(record.score.toFixed(4)),
      summaryId: record.summaryId,
      sessionId: record.sessionId,
      topics: record.topics || [],
      rolling: record.rolling,
      nextRecommendedStep: record.nextRecommendedStep || '',
    }))
}

function eventToMessage(event) {
  if (event.type === 'user_message_received') return { role: 'user', text: event.payload?.text || '' }
  if (event.type === 'assistant_response_completed') return { role: 'assistant', text: event.payload?.text || '' }
  return null
}

function buildSessionSummary(sessionId, events, metadata = {}) {
  const messages = events.map(eventToMessage).filter((message) => message && message.text)
  const transcript = messagesToTranscript(messages)
  const userTurns = messages.filter((message) => message.role === 'user')
  const assistantTurns = messages.filter((message) => message.role === 'assistant')
  const lastUser = [...userTurns].reverse()[0]?.text || ''
  const failedTurns = events.filter((event) => event.type === 'assistant_response_failed').length
  const toolResults = events.filter((event) => event.type === 'tool_result')
  const topics = extractTopics(transcript)

  return {
    id: randomId('summary'),
    sessionId,
    sourceAgent: 'agent1',
    type: 'session_summary',
    status: 'canonical',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    eventCount: events.length,
    compression: {
      threshold: SUMMARY_COMPRESSION_EVENT_THRESHOLD,
      exceededThreshold: events.length >= SUMMARY_COMPRESSION_EVENT_THRESHOLD,
      recentWindowSize: RECENT_EVENT_LIMIT,
    },
    currentGoal: metadata.lessonGoal || inferGoal(lastUser),
    taskStatus: failedTurns ? 'completed_with_errors' : 'completed',
    rolling: summarizeTranscript({ transcript, topics, userTurns: userTurns.length, assistantTurns: assistantTurns.length, failedTurns }),
    preferences: extractPreferences(transcript),
    entities: topics.map((topic) => fact('entity', topic, sessionId, 'agent1')),
    decisions: extractDecisions(transcript).map((decision) => fact('decision', decision, sessionId, 'agent1')),
    unresolvedItems: extractUnresolvedItems(events),
    nextRecommendedStep: lastUser ? `Revisit or build on: "${lastUser.slice(0, 160)}"` : 'Start a new tutoring goal.',
    metadata: {
      activeView: metadata.activeView || metadata.context?.mode || null,
      toolResultCount: toolResults.length,
    },
  }
}

function buildAgent2Summary({ sessionId, review, summary }) {
  return {
    id: randomId('agent2_summary'),
    sessionId,
    sourceAgent: 'agent2',
    type: 'review_summary',
    status: 'canonical',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    verdict: review?.verdict || 'unknown',
    confidence: review ? 0.7 : 0.4,
    rolling: summary || 'Agent 2 review completed.',
    findings: [
      ...(review?.risks || []).map((text) => ({ type: 'risk', text })),
      ...(review?.recommendations || []).map((text) => ({ type: 'recommendation', text })),
    ],
    evidence: review?.evidence || {},
    nextRecommendedStep: review?.recommendations?.[0] || 'Use the Agent 2 review before the next tutoring turn.',
  }
}

function summarySemanticText(summary) {
  const topics = (summary.entities || []).map((item) => item.text).filter(Boolean).join(', ')
  const decisions = (summary.decisions || []).map((item) => item.text).filter(Boolean).join(' ')
  return [
    summary.currentGoal,
    topics && `Topics: ${topics}`,
    summary.rolling,
    decisions && `Decisions: ${decisions}`,
    summary.nextRecommendedStep,
  ].filter(Boolean).join('\n')
}

function fact(type, text, sessionId, sourceAgent) {
  return {
    id: randomId(type),
    type,
    text,
    sessionId,
    sourceAgent,
    confidence: 0.6,
    timestamp: nowIso(),
  }
}

function summarizeTranscript({ transcript, topics, userTurns, assistantTurns, failedTurns }) {
  if (!transcript.trim()) return 'No completed tutoring exchange was captured.'
  const topicText = topics.length ? ` Topics/entities: ${topics.slice(0, 6).join(', ')}.` : ''
  const failureText = failedTurns ? ` ${failedTurns} assistant turn(s) failed or were interrupted.` : ''
  return `The session contains ${userTurns} user turn(s) and ${assistantTurns} assistant turn(s).${topicText}${failureText} Recent focus: ${transcript.slice(-500)}`
}

function inferGoal(text) {
  if (!text) return ''
  return text.length > 180 ? text.slice(0, 177) + '...' : text
}

function extractTopics(text) {
  const candidates = new Set()
  const ignored = new Set(['Student', 'Tutor', 'User', 'Assistant', 'Agent', 'Teach', 'What', 'When', 'Where', 'Why', 'How', 'Can'])
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9+-]{2,}\b/g)) {
    if (!ignored.has(match[0])) candidates.add(match[0])
  }
  for (const match of text.matchAll(/\b(board|graph|factor|derivative|integral|binary search|recursion|stoichiometry|photosynthesis|gradient descent)\b/gi)) {
    candidates.add(match[0].toLowerCase())
  }
  return [...candidates].slice(0, 12)
}

function extractPreferences(text) {
  const preferences = []
  const patterns = [
    /\bI prefer ([^.?!]+)/gi,
    /\bI like ([^.?!]+)/gi,
    /\bplease ([^.?!]+)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) preferences.push(fact('preference', match[0], 'unknown', 'agent1'))
  }
  return preferences.slice(0, 8)
}

function extractDecisions(text) {
  const decisions = []
  for (const match of text.matchAll(/\b(we decided|let'?s|we will|next time)\b[^.?!]*/gi)) {
    decisions.push(match[0])
  }
  return decisions.slice(0, 8)
}

function extractUnresolvedItems(events) {
  return events
    .filter((event) => event.type === 'assistant_response_failed')
    .map((event) => event.payload?.error || 'Assistant response failed.')
    .slice(-5)
}

export async function appendMemoryEvent(sessionId, event) {
  if (!sessionId) return null
  const fullEvent = {
    id: event.id || randomId('event'),
    sessionId,
    sourceAgent: event.sourceAgent || 'agent1',
    timestamp: event.timestamp || nowIso(),
    type: event.type,
    payload: scrubEventPayload(event.payload || {}),
    metadata: event.metadata || {},
  }

  try {
    const redis = await getRedis()
    if (redis) {
      await redis.rPush(memoryKey(sessionId, 'events'), JSON.stringify(fullEvent))
      await redis.expire(memoryKey(sessionId, 'events'), EVENT_TTL_SECONDS)
    } else {
      const events = fallback.events.get(sessionId) || []
      events.push(fullEvent)
      fallback.events.set(sessionId, events)
    }
  } catch (err) {
    console.warn(`[memory] append failed: ${err?.message || err}`)
  }
  return fullEvent
}

export async function finalizeAgent1Session({ sessionId, userId = 'local-user', metadata = {} }) {
  const events = await readEvents(sessionId)
  const summary = buildSessionSummary(sessionId, events, metadata)
  const state = {
    ...(await readState(sessionId)),
    sessionId,
    updatedAt: nowIso(),
    status: 'ended',
    summary,
    currentGoal: summary.currentGoal,
    taskStatus: summary.taskStatus,
    preferences: summary.preferences,
    entities: summary.entities,
    decisions: summary.decisions,
  }
  await writeState(sessionId, state)
  await appendLongTermSummary(summary)
  const embedding = await embedText(summarySemanticText(summary))
  if (embedding) {
    await appendUserSemanticSummary(userId, {
      id: randomId('summary_embedding'),
      userId,
      summaryId: summary.id,
      sessionId,
      sourceAgent: 'agent1',
      createdAt: nowIso(),
      topics: (summary.entities || []).map((item) => item.text),
      rolling: summary.rolling,
      nextRecommendedStep: summary.nextRecommendedStep,
      embedding,
    })
  }
  await appendMemoryEvent(sessionId, {
    sourceAgent: 'agent1',
    type: 'memory_summary_updated',
    payload: { summaryId: summary.id, status: 'canonical', eventCount: events.length },
  })
  return summary
}

export async function writeAgent2ReviewMemory({ sessionId, review, summary }) {
  const reviewSummary = buildAgent2Summary({ sessionId, review, summary })
  const state = await readState(sessionId)
  const reviews = [...(state.agent2Reviews || []), reviewSummary].slice(-10)
  await writeState(sessionId, { ...state, sessionId, updatedAt: nowIso(), agent2Reviews: reviews })
  await appendLongTermSummary(reviewSummary)
  await appendMemoryEvent(sessionId, {
    sourceAgent: 'agent2',
    type: 'agent2_review_completed',
    payload: {
      summaryId: reviewSummary.id,
      verdict: reviewSummary.verdict,
      findingCount: reviewSummary.findings.length,
    },
  })
  return reviewSummary
}

export async function getAgentMemoryPacket(sessionId, filters = {}) {
  const userId = filters.userId || 'local-user'
  const [events, state, longTermSummaries] = await Promise.all([
    readEvents(sessionId),
    readState(sessionId),
    readLongTermSummaries(filters.longTermLimit || LONG_TERM_SUMMARY_LIMIT),
  ])
  let similarSummaries = []
  const queryText = [filters.queryText, filters.topic, filters.activeView].filter(Boolean).join('\n')
  if (queryText.trim()) {
    const queryEmbedding = await embedText(queryText)
    if (queryEmbedding) {
      similarSummaries = await readSimilarSummariesFromVector(userId, queryEmbedding, {
        threshold: Number(filters.threshold || SIMILARITY_THRESHOLD),
        limit: Number(filters.similarityLimit || SIMILARITY_LIMIT),
        excludeSessionId: sessionId,
      })
      if (!similarSummaries) {
        const records = await readUserSemanticSummaries(userId)
        similarSummaries = findSimilarSummaryMatches(queryEmbedding, records, {
          threshold: Number(filters.threshold || SIMILARITY_THRESHOLD),
          limit: Number(filters.similarityLimit || SIMILARITY_LIMIT),
          excludeSessionId: sessionId,
        })
      }
    }
  }
  const recentEvents = events.slice(-(filters.recentLimit || RECENT_EVENT_LIMIT))
  const fallbackSummary = {
    rolling: events.length
      ? 'Session is active. Canonical summary will be created when the user ends the session.'
      : 'No session memory has been written yet.',
    updatedAt: nowIso(),
    status: 'provisional',
  }
  return {
    user: {
      id: userId,
      preferences: state.preferences || [],
    },
    session: {
      id: sessionId,
      currentGoal: state.currentGoal || '',
      taskStatus: state.taskStatus || (state.status === 'ended' ? 'completed' : 'active'),
      activeView: state.summary?.metadata?.activeView || filters.activeView || null,
      eventCount: events.length,
      compression: {
        threshold: SUMMARY_COMPRESSION_EVENT_THRESHOLD,
        shouldSlideWindow: events.length >= SUMMARY_COMPRESSION_EVENT_THRESHOLD,
        recentWindowSize: filters.recentLimit || RECENT_EVENT_LIMIT,
      },
    },
    summary: state.summary || fallbackSummary,
    agent2Reviews: state.agent2Reviews || [],
    agent2Guidance: buildAgent2Guidance(state.agent2Reviews || []),
    similarSummaries,
    recentEvents,
    longTermSummaries: longTermSummaries.filter((item) => item.sessionId === sessionId || !filters.sessionOnly),
    entities: state.entities || [],
    decisions: state.decisions || [],
    generatedAt: nowIso(),
  }
}

function buildAgent2Guidance(reviews) {
  return reviews
    .slice(-3)
    .flatMap((review) =>
      (review.findings || []).map((finding) => ({
        type: finding.type,
        text: finding.text,
        verdict: review.verdict,
        confidence: review.confidence,
        reviewId: review.id,
        createdAt: review.createdAt,
      })),
    )
    .slice(-8)
}
