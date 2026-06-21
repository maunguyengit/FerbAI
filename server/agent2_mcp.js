#!/usr/bin/env node
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { getAgentMemoryPacket, writeAgent2ReviewMemory } from './memory.js'
import { formatTutorReview, messagesToTranscript, scoreTutorTranscript } from './tutorReview.js'

const SERVER_INFO = { name: 'ferbai-agent2', version: '0.1.0' }
let inputBuffer = Buffer.alloc(0)

const tools = [
  {
    name: 'agent2.review_transcript',
    description: 'Run Agent 2 tutor-quality review over an explicit transcript and optionally persist it to FerbAI memory.',
    inputSchema: {
      type: 'object',
      properties: {
        transcript: { type: 'string', description: 'Transcript text to review.' },
        sessionId: { type: 'string', description: 'Optional FerbAI session id. Required when persist is true.' },
        boardState: { type: 'string', description: 'Optional board/graph/lesson context JSON or text.' },
        lessonGoal: { type: 'string', description: 'Optional learning goal for the session.' },
        persist: { type: 'boolean', description: 'Whether to write Agent 2 review memory for sessionId.', default: false },
      },
      required: ['transcript'],
    },
  },
  {
    name: 'agent2.review_agent1_session',
    description: 'Load Agent 1 session events from FerbAI memory, run Agent 2 review, and persist the review guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'FerbAI Agent 1 session id.' },
        userId: { type: 'string', description: 'FerbAI user id for memory scoping.', default: 'local-user' },
        boardState: { type: 'string', description: 'Optional board/graph/lesson context JSON or text.' },
        lessonGoal: { type: 'string', description: 'Optional learning goal for the session.' },
        recentLimit: { type: 'number', description: 'Maximum recent events to read from memory.', default: 200 },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'arize_evaluator.agent1_session',
    description: 'Prepare or trigger an Arize evaluator task for Agent 1 session traces. Requires Arize traces/tasks to already exist.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['plan', 'trigger'], default: 'plan' },
        sessionId: { type: 'string', description: 'Agent 1 session id to evaluate.' },
        taskId: { type: 'string', description: 'Arize evaluation task id/name. Required for trigger mode.' },
        dataStartTime: { type: 'string', description: 'Run window start, e.g. 2026-03-21T09:00:00.' },
        dataEndTime: { type: 'string', description: 'Run window end, e.g. 2026-03-21T10:00:00.' },
        maxSpans: { type: 'number', description: 'Optional maximum spans for Arize trigger-run.' },
        wait: { type: 'boolean', description: 'Whether ax should wait for completion.', default: true },
      },
      required: ['sessionId'],
    },
  },
]

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk])
  for (;;) {
    const parsed = readMessage()
    if (!parsed) break
    handleMessage(parsed).catch((err) => {
      if (parsed.id != null) sendError(parsed.id, -32603, err?.message || 'Internal error')
    })
  }
})

process.stdin.resume()

function readMessage() {
  const sep = inputBuffer.indexOf('\r\n\r\n')
  if (sep === -1) return null
  const header = inputBuffer.subarray(0, sep).toString('utf8')
  const lengthMatch = /content-length:\s*(\d+)/i.exec(header)
  if (!lengthMatch) {
    inputBuffer = inputBuffer.subarray(sep + 4)
    return null
  }
  const length = Number(lengthMatch[1])
  const start = sep + 4
  const end = start + length
  if (inputBuffer.length < end) return null
  const body = inputBuffer.subarray(start, end).toString('utf8')
  inputBuffer = inputBuffer.subarray(end)
  return JSON.parse(body)
}

async function handleMessage(message) {
  if (message.method === 'initialize') {
    return sendResult(message.id, {
      protocolVersion: message.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
  }
  if (message.method === 'tools/list') return sendResult(message.id, { tools })
  if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params || {}
    const result = await callTool(name, args)
    return sendResult(message.id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    })
  }
  if (message.id != null) sendError(message.id, -32601, `Unknown method: ${message.method}`)
}

async function callTool(name, args) {
  if (name === 'agent2.review_transcript') return reviewTranscript(args)
  if (name === 'agent2.review_agent1_session') return reviewAgent1Session(args)
  if (name === 'arize_evaluator.agent1_session') return arizeEvaluatorForAgent1Session(args)
  throw new Error(`Unknown tool: ${name}`)
}

async function reviewTranscript(args) {
  const transcript = String(args.transcript || '').trim()
  if (!transcript) throw new Error('transcript is required')
  const review = scoreTutorTranscript({
    transcript,
    boardState: args.boardState || '',
    lessonGoal: args.lessonGoal || '',
  })
  const summary = formatTutorReview(review)
  let stored = null
  if (args.persist) {
    if (!args.sessionId) throw new Error('sessionId is required when persist is true')
    stored = await writeAgent2ReviewMemory({ sessionId: args.sessionId, review, summary })
  }
  return { review, summary, stored }
}

async function reviewAgent1Session(args) {
  const sessionId = String(args.sessionId || '').trim()
  if (!sessionId) throw new Error('sessionId is required')
  const packet = await getAgentMemoryPacket(sessionId, {
    userId: args.userId || 'local-user',
    recentLimit: Number(args.recentLimit || 200),
    sessionOnly: true,
  })
  const transcript = transcriptFromEvents(packet.recentEvents || [])
  if (!transcript.trim()) throw new Error(`No completed Agent 1 transcript found for session ${sessionId}`)
  const review = scoreTutorTranscript({
    transcript,
    boardState: args.boardState || JSON.stringify({ session: packet.session, summary: packet.summary }),
    lessonGoal: args.lessonGoal || packet.session?.currentGoal || '',
  })
  const summary = formatTutorReview(review)
  const stored = await writeAgent2ReviewMemory({ sessionId, review, summary })
  return { sessionId, userId: packet.user?.id, transcript, review, summary, stored }
}

function transcriptFromEvents(events) {
  const messages = events
    .map((event) => {
      if (event.type === 'user_message_received') return { role: 'user', text: event.payload?.text || '' }
      if (event.type === 'assistant_response_completed') return { role: 'assistant', text: event.payload?.text || '' }
      return null
    })
    .filter((message) => message && message.text)
  return messagesToTranscript(messages)
}

async function arizeEvaluatorForAgent1Session(args) {
  const mode = args.mode || 'plan'
  const sessionId = String(args.sessionId || '').trim()
  if (!sessionId) throw new Error('sessionId is required')
  const guidance = {
    note: 'FerbAI emits Arize/OpenInference traces when ARIZE_SPACE_ID and ARIZE_API_KEY are configured. This tool can trigger an existing Arize task when Agent 1 session traces are in the configured Arize project and the task filters/map columns for attributes.session.id.',
    recommendedEvaluator: {
      granularity: 'session',
      templateVariables: ['conversation'],
      targetFilter: `attributes.session.id = '${sessionId}'`,
      labels: { effective: 1, needs_improvement: 0 },
    },
  }
  if (mode === 'plan') {
    return {
      mode,
      sessionId,
      guidance,
      triggerCommandTemplate: 'ax tasks trigger-run TASK_ID --data-start-time "YYYY-MM-DDTHH:MM:SS" --data-end-time "YYYY-MM-DDTHH:MM:SS" --max-spans 100 --wait',
    }
  }
  if (!args.taskId) throw new Error('taskId is required for trigger mode')
  if (!args.dataStartTime || !args.dataEndTime) throw new Error('dataStartTime and dataEndTime are required for trigger mode')
  const axArgs = [
    'tasks', 'trigger-run', String(args.taskId),
    '--data-start-time', String(args.dataStartTime),
    '--data-end-time', String(args.dataEndTime),
  ]
  if (args.maxSpans) axArgs.push('--max-spans', String(args.maxSpans))
  if (args.wait !== false) axArgs.push('--wait')
  const run = await runAx(axArgs)
  return { mode, sessionId, guidance, command: ['ax', ...axArgs].join(' '), run }
}

function runAx(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ax', args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      const result = { code, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) }
      if (code === 0) resolve(result)
      else reject(new Error(`ax exited ${code}: ${(stderr || stdout).slice(-1200)}`))
    })
  })
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function send(payload) {
  const body = JSON.stringify(payload)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}
