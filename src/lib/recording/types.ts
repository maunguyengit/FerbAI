// Recording / playback data model.
//
// A recording is an incremental EVENT log (for smooth playback) + periodic
// SNAPSHOTS (full board state, for instant seeking). Each event carries a
// timestamp in ms relative to recording start. Audio is optional — playback
// falls back to a virtual clock when there's no microphone.

import type { Element } from '../types'

/** A board mutation, without a timestamp (the recorder stamps it). */
export type RawBoardEvent =
  | { type: 'add'; element: Element }
  | { type: 'addMany'; elements: Element[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'clear' }
  | { type: 'set'; elements: Element[] } // undo/redo/move → full state

export type BoardEvent = RawBoardEvent & { t: number }

export interface Snapshot {
  t: number
  elements: Element[]
}

export interface Recording {
  id: string
  title: string
  createdAt: number
  durationMs: number
  events: BoardEvent[]
  snapshots: Snapshot[]
  /** object URL for the recorded audio blob, if a mic was available */
  audioUrl?: string
  /** mime of the audio blob */
  audioMime?: string
  /** true for the bundled demo/test fixture */
  demo?: boolean
}

export type RecorderStatus = 'idle' | 'recording'

/** Apply one event to a working element list (used by the playback engine). */
export function applyEvent(els: Element[], ev: BoardEvent): Element[] {
  switch (ev.type) {
    case 'add': return [...els, ev.element]
    case 'addMany': return [...els, ...ev.elements]
    case 'remove': { const ids = new Set(ev.ids); return els.filter((e) => !ids.has(e.id)) }
    case 'clear': return []
    case 'set': return ev.elements
    default: return els
  }
}

/** Reconstruct full board state at time T using snapshots + events. */
export function stateAt(rec: Recording, t: number): Element[] {
  // nearest snapshot at or before T (snapshots are sorted ascending)
  let base: Element[] = []
  let baseT = -1
  for (const s of rec.snapshots) {
    if (s.t <= t) { base = s.elements; baseT = s.t } else break
  }
  let els = [...base]
  for (const ev of rec.events) {
    if (ev.t > t) break
    if (ev.t > baseT) els = applyEvent(els, ev) // snapshot already includes events <= baseT
  }
  return els
}
