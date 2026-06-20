// Parses the AI's reply into spoken text + board actions + graph equations.
//
// The model emits machine instructions inside fenced blocks:
//
//   ```ferbai-draw      → whiteboard           { "actions": [ ... ] }
//   ```ferbai-graph     → graph window         { "equations": [ {"eq":"y=x^2"}, ... ] }
//
// We strip those blocks from what the user reads, and hand the payloads to the
// board / graph. During streaming a block may still be open (no closing fence) —
// everything from the opening fence onward is hidden so raw JSON never flashes.

import type { AIAction, AIGraphEquation } from './types'

const DRAW_CLOSED = /```\s*ferbai-draw\s*([\s\S]*?)```/i
const GRAPH_CLOSED = /```\s*ferbai-graph\s*([\s\S]*?)```/i
const ANY_OPEN = /```\s*ferbai-(draw|graph)/i

export interface ParsedReply {
  clean: string
  actions: AIAction[] | null
  graph: AIGraphEquation[] | null
}

export function parseReply(raw: string): ParsedReply {
  let clean = raw
  let actions: AIAction[] | null = null
  let graph: AIGraphEquation[] | null = null

  const draw = raw.match(DRAW_CLOSED)
  if (draw) {
    actions = pick<AIAction>(draw[1], 'actions')
    clean = clean.replace(DRAW_CLOSED, '').trim()
  }
  const g = raw.match(GRAPH_CLOSED)
  if (g) {
    graph = pick<AIGraphEquation>(g[1], 'equations')
    clean = clean.replace(GRAPH_CLOSED, '').trim()
  }

  // hide any still-open (streaming) block
  const open = clean.match(ANY_OPEN)
  if (open && open.index !== undefined) clean = clean.slice(0, open.index).trim()

  return { clean: clean.trim(), actions, graph }
}

function pick<T>(jsonish: string, key: string): T[] | null {
  const text = jsonish.trim()
  const tryParse = (s: string): T[] | null => {
    try {
      const parsed = JSON.parse(s)
      const arr = Array.isArray(parsed) ? parsed : parsed?.[key]
      return Array.isArray(arr) ? (arr as T[]) : null
    } catch {
      return null
    }
  }
  const direct = tryParse(text)
  if (direct) return direct
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return tryParse(text.slice(start, end + 1))
  return null
}
