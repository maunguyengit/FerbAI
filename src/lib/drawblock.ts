// Parses the AI's reply into spoken text + board actions + graph equations + a
// visualization spec.
//
//   ```ferbai-draw      → whiteboard      { "actions": [ ... ] }
//   ```ferbai-graph     → graph window    { "equations": [ ... ] }
//   ```ferbai-viz       → visualization   { "widget": "...", "data": {...}, ... }
//
// Blocks are stripped from what the user reads; the payloads drive the surfaces.
// During streaming a block may be open — everything from the opening fence on is
// hidden so raw JSON / HTML never flashes.

import type { AIAction, AIGraphEquation, VizSpec } from './types'

const DRAW_CLOSED = /```\s*ferbai-draw\s*([\s\S]*?)```/i
const GRAPH_CLOSED = /```\s*ferbai-graph\s*([\s\S]*?)```/i
const VIZ_CLOSED = /```\s*ferbai-viz\s*([\s\S]*?)```/i
// raw HTML for custom widgets lives in its OWN fence — no JSON escaping, so a
// stray quote/newline in the model's HTML can't corrupt the spec.
const HTML_CLOSED = /```\s*ferbai-html\s*([\s\S]*?)```/i
const ANY_OPEN = /```\s*ferbai-(draw|graph|viz|html)/i

export interface ParsedReply {
  clean: string
  actions: AIAction[] | null
  graph: AIGraphEquation[] | null
  viz: VizSpec | null
}

export function parseReply(raw: string): ParsedReply {
  let clean = raw
  let actions: AIAction[] | null = null
  let graph: AIGraphEquation[] | null = null
  let viz: VizSpec | null = null

  const draw = raw.match(DRAW_CLOSED)
  if (draw) { actions = pickArray<AIAction>(draw[1], 'actions'); clean = clean.replace(DRAW_CLOSED, '').trim() }

  const g = raw.match(GRAPH_CLOSED)
  if (g) { graph = pickArray<AIGraphEquation>(g[1], 'equations'); clean = clean.replace(GRAPH_CLOSED, '').trim() }

  const v = raw.match(VIZ_CLOSED)
  if (v) { viz = pickViz(v[1]); clean = clean.replace(VIZ_CLOSED, '').trim() }

  // a separate raw-HTML block feeds custom widgets without JSON escaping
  const htmlBlock = raw.match(HTML_CLOSED)
  if (htmlBlock) {
    clean = clean.replace(HTML_CLOSED, '').trim()
    const html = htmlBlock[1].trim()
    if (html) {
      if (viz) { if (!viz.html) viz.html = html }
      else viz = { widget: 'custom', html } // html block alone implies a custom viz
    }
  }

  const open = clean.match(ANY_OPEN)
  if (open && open.index !== undefined) clean = clean.slice(0, open.index).trim()

  return { clean: clean.trim(), actions, graph, viz }
}

function parseLoose(text: string): unknown {
  const t = text.trim()
  try { return JSON.parse(t) } catch { /* try to salvage */ }
  const start = t.indexOf('{'), end = t.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)) } catch { /* */ } }
  return null
}

function pickArray<T>(jsonish: string, key: string): T[] | null {
  const parsed = parseLoose(jsonish) as Record<string, unknown> | unknown[] | null
  if (Array.isArray(parsed)) return parsed as T[]
  const arr = parsed && (parsed as Record<string, unknown>)[key]
  return Array.isArray(arr) ? (arr as T[]) : null
}

function pickViz(jsonish: string): VizSpec | null {
  const parsed = parseLoose(jsonish) as Record<string, unknown> | null
  if (parsed && typeof parsed.widget === 'string') return parsed as unknown as VizSpec
  return null
}
