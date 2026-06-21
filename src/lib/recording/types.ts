// Recording / playback data model.
//
// A recording captures the whole *content scene* over time, not just the board:
// which window is active (board / graph / learn) plus each window's content
// (board elements, graph equations, visualization spec). Incremental EVENTS give
// smooth playback; periodic SNAPSHOTS (full scene) give instant seeking. Audio is
// optional. The chatbot is never recorded — only the content windows.

import type { Element, View, VizSpec } from '../types'

/** A graph equation, light enough to re-plot on playback. */
export interface GraphEqSnap {
  raw: string
  color: string
}

/** The full reconstructable state of the content area at a moment in time. */
export interface Scene {
  view: View
  elements: Element[]          // board
  equations: GraphEqSnap[]     // graph
  viz: VizSpec | null          // learn/visualization
}

export const EMPTY_SCENE: Scene = { view: 'board', elements: [], equations: [], viz: null }

// ---- events (without a timestamp; the recorder stamps them) ----
export type RawBoardEvent =
  | { type: 'add'; element: Element }
  | { type: 'addMany'; elements: Element[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'clear' }
  | { type: 'set'; elements: Element[] }

export type RawSceneEvent =
  | RawBoardEvent
  | { type: 'view'; view: View }
  | { type: 'graph'; equations: GraphEqSnap[] }
  | { type: 'viz'; spec: VizSpec | null }

export type SceneEvent = RawSceneEvent & { t: number }

export interface Snapshot {
  t: number
  // a snapshot is a full scene; older recordings only stored `elements` (board) —
  // the optional fields default sensibly so they still replay.
  elements: Element[]
  view?: View
  equations?: GraphEqSnap[]
  viz?: VizSpec | null
}

export interface Recording {
  id: string
  title: string
  createdAt: number
  durationMs: number
  events: SceneEvent[]
  snapshots: Snapshot[]
  audioUrl?: string
  audioMime?: string
  demo?: boolean
  remote?: boolean
  shared?: boolean
  mine?: boolean
  audioPath?: string
  audioBlob?: Blob
}

export type RecorderStatus = 'idle' | 'recording'

/** Apply one event to a working scene. */
export function applyEvent(scene: Scene, ev: SceneEvent): Scene {
  switch (ev.type) {
    case 'add': return { ...scene, elements: [...scene.elements, ev.element] }
    case 'addMany': return { ...scene, elements: [...scene.elements, ...ev.elements] }
    case 'remove': { const ids = new Set(ev.ids); return { ...scene, elements: scene.elements.filter((e) => !ids.has(e.id)) } }
    case 'clear': return { ...scene, elements: [] }
    case 'set': return { ...scene, elements: ev.elements }
    case 'view': return { ...scene, view: ev.view }
    case 'graph': return { ...scene, equations: ev.equations }
    case 'viz': return { ...scene, viz: ev.spec }
    default: return scene
  }
}

function sceneFromSnapshot(s: Snapshot): Scene {
  return {
    view: s.view ?? 'board',
    elements: s.elements ?? [],
    equations: s.equations ?? [],
    viz: s.viz ?? null,
  }
}

/** Reconstruct the full scene at time T using snapshots + events. */
export function sceneAt(rec: Recording, t: number): Scene {
  let base: Scene = EMPTY_SCENE
  let baseT = -1
  for (const s of rec.snapshots) {
    if (s.t <= t) { base = sceneFromSnapshot(s); baseT = s.t } else break
  }
  let scene: Scene = { ...base, elements: [...base.elements], equations: [...base.equations] }
  for (const ev of rec.events) {
    if (ev.t > t) break
    if (ev.t > baseT) scene = applyEvent(scene, ev) // snapshot already includes events <= baseT
  }
  return scene
}
