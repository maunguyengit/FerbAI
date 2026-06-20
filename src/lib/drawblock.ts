// Parses the AI's reply into spoken text + board actions.
//
// The model is instructed to emit drawing instructions inside a fenced block:
//
//   ```ferbai-draw
//   { "actions": [ {"kind":"text", ...}, ... ] }
//   ```
//
// We strip that block from what the user reads, and hand the actions to the
// whiteboard. During streaming the block may still be open (no closing fence) —
// we hide everything from the opening fence onward so raw JSON never flashes.

import type { AIAction } from './types'

const CLOSED = /```\s*ferbai-draw\s*([\s\S]*?)```/i
const OPEN = /```\s*ferbai-draw/i

export interface ParsedReply {
  /** text to show in the chat bubble (block removed) */
  clean: string
  /** actions to render, or null if none / not yet complete */
  actions: AIAction[] | null
}

export function parseReply(raw: string): ParsedReply {
  let actions: AIAction[] | null = null
  let clean = raw

  const closed = raw.match(CLOSED)
  if (closed) {
    actions = safeActions(closed[1])
    clean = raw.replace(CLOSED, '').trim()
  }

  // hide any still-open (streaming) block
  const open = clean.match(OPEN)
  if (open && open.index !== undefined) {
    clean = clean.slice(0, open.index).trim()
  }

  return { clean: clean.trim(), actions }
}

function safeActions(jsonish: string): AIAction[] | null {
  const text = jsonish.trim()
  try {
    const parsed = JSON.parse(text)
    const arr = Array.isArray(parsed) ? parsed : parsed?.actions
    if (Array.isArray(arr)) return arr as AIAction[]
  } catch {
    // try to salvage the first {...} object in case of trailing prose
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1))
        const arr = Array.isArray(parsed) ? parsed : parsed?.actions
        if (Array.isArray(arr)) return arr as AIAction[]
      } catch {
        /* give up */
      }
    }
  }
  return null
}
