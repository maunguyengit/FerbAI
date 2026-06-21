// Bundled demo / test recording. Auto-loaded into the Recordings list on every
// app open so there's always something to replay (useful for testing the
// playback engine and as a product demo). Silent (no audio) — playback uses the
// virtual clock. Hand-authored event log + snapshots; ids are stable.

import type { Element } from '../types'
import type { Recording, TranscriptWord } from './types'

// build word-level transcript timings from [startMs, phrase] lines
function words(lines: [number, string][]): TranscriptWord[] {
  const out: TranscriptWord[] = []
  const per = 250
  for (const [start, text] of lines) {
    text.split(/\s+/).forEach((w, i) => out.push({ w, start: start + i * per, end: start + i * per + per - 40 }))
  }
  return out
}

const INK = 'oklch(27% 0.008 70)'
const CLAY = 'oklch(61% 0.115 42)'
const SAGE = 'oklch(66% 0.05 150)'

// A short "solve x² = 9" lesson: the student writes the equation, then the tutor
// works down to the answer and circles it — exercises text, AI-handwriting text,
// arrows, and an ellipse during playback.
const els: Record<string, Element> = {
  eq:    { id: 'demo_eq',    type: 'text',    color: INK,  width: 3, x: 80,  y: 80,  text: 'x² = 9',     size: 34 },
  arr1:  { id: 'demo_arr1',  type: 'arrow',   color: CLAY, width: 3, x1: 112, y1: 98, x2: 112, y2: 150 },
  root:  { id: 'demo_root',  type: 'text',    color: INK,  width: 3, x: 64,  y: 188, text: '√(x²) = √9', size: 28 },
  arr2:  { id: 'demo_arr2',  type: 'arrow',   color: CLAY, width: 3, x1: 112, y1: 206, x2: 112, y2: 258 },
  ans:   { id: 'demo_ans',   type: 'text',    color: SAGE, width: 3, x: 84,  y: 296, text: 'x = ±3',     size: 32, author: 'ai' },
  circ:  { id: 'demo_circ',  type: 'ellipse', color: SAGE, width: 3, x: 64,  y: 266, w: 132, h: 46 },
}

const ALL = Object.values(els)

export const DEMO_RECORDING: Recording = {
  id: 'demo-solve-x2-9',
  title: 'Demo · Solving x² = 9',
  createdAt: 0,
  durationMs: 6800,
  demo: true,
  events: [
    { t: 500, type: 'add', element: els.eq },
    { t: 1800, type: 'add', element: els.arr1 },
    { t: 2700, type: 'add', element: els.root },
    { t: 4000, type: 'add', element: els.arr2 },
    { t: 5000, type: 'add', element: els.ans },
    { t: 5900, type: 'add', element: els.circ },
  ],
  snapshots: [
    { t: 0, elements: [] },
    { t: 6800, elements: ALL },
  ],
  transcript: words([
    [200, "Let's solve x squared equals nine."],
    [2700, 'First, take the square root of both sides.'],
    [4600, 'Remember plus or minus.'],
    [5400, 'So x equals plus or minus three.'],
  ]),
  chapters: [
    { t: 0, title: 'Set up the equation' },
    { t: 2700, title: 'Square-root both sides' },
    { t: 5400, title: 'Plus-minus answer' },
  ],
}
