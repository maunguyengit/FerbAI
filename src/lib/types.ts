// ---------- Whiteboard ----------
export type Tool = 'pen' | 'eraser' | 'lasso' | 'text' | 'rect' | 'ellipse' | 'pan'

export type Author = 'user' | 'ai'

export interface Point {
  x: number
  y: number
}

interface ElBase {
  id: string
  color: string
  width: number
  /** who created it — AI elements render in accent blue and fade in */
  author?: Author
}

export interface PathEl extends ElBase {
  type: 'path'
  points: Point[]
}

export interface ShapeEl extends ElBase {
  type: 'rect' | 'ellipse' | 'highlight'
  x: number
  y: number
  w: number
  h: number
}

export interface LineEl extends ElBase {
  type: 'line' | 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface TextEl extends ElBase {
  type: 'text'
  x: number
  y: number
  text: string
  size: number
}

export type Element = PathEl | ShapeEl | LineEl | TextEl

/** Bounding box of everything drawn, plus board size — sent to the AI so it
 *  knows where the empty space is and can place its work accurately. */
export interface BoardMeta {
  width: number
  height: number
  content: { x: number; y: number; w: number; h: number } | null
}

/** A drawing instruction the AI emits (in a `ferbai-draw` JSON block). */
export type AIAction =
  | { kind: 'text'; x: number; y: number; text: string; size?: number; color?: string }
  | { kind: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; color?: string }
  | { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; color?: string }
  | { kind: 'highlight'; x: number; y: number; w: number; h: number }

export interface WhiteboardHandle {
  /** Returns the current board as a PNG data URL with a white background. */
  getImageDataURL: () => string | null
  /** True when there is anything drawn. */
  isEmpty: () => boolean
  /** current committed elements (for recording snapshots) */
  getElements: () => Element[]
  /** Board size + content bounds, for accurate AI placement. */
  getBoardMeta: () => BoardMeta
  /** Render AI drawing instructions onto the board. Returns count applied. */
  applyAIActions: (actions: AIAction[]) => number
  undo: () => void
  redo: () => void
  clear: () => void
}

// ---------- Graph ----------
export type GraphDim = '2d' | '3d'

/** One equation/relation on the graph. */
export interface GraphEquation {
  id: string
  raw: string
  color: string
  visible: boolean
  author?: Author
  error?: string | null
}

/** A graph instruction the AI emits (in a `ferbai-graph` block). */
export interface AIGraphEquation {
  eq: string
  color?: string
  label?: string
}

export interface GraphHandle {
  /** PNG snapshot of the current plot (async — Plotly renders to image). */
  getImageDataURL: () => Promise<string | null>
  isEmpty: () => boolean
  /** raw equation strings currently plotted, for the AI's context */
  getEquations: () => string[]
  /** '2d' unless any equation references z */
  getDimension: () => GraphDim
  /** add AI-authored equations to the plot; returns count added */
  addEquations: (eqs: AIGraphEquation[]) => number
}

// ---------- Visualization ----------
/** Declarative spec the AI emits (in a `ferbai-viz` block). The widget owns all
 *  interaction; the AI supplies only the data + narration. */
export interface VizSpec {
  widget: string
  title?: string
  intro?: string
  data?: Record<string, unknown>
  config?: Record<string, unknown>
  narration?: string[]
  html?: string
}

export interface VizHandle {
  render: (spec: VizSpec) => void
  isEmpty: () => boolean
  /** short summary of what's currently shown, for the AI's context */
  getCurrent: () => { widget: string; title: string } | null
}

// ---------- Left-panel view ----------
export type View = 'board' | 'graph' | 'viz' | 'replay'

/** What the chat sends to the AI about the active left-panel view. */
export interface ChatContext {
  mode: View
  boardMeta?: BoardMeta | null
  graph?: { dim: GraphDim; equations: string[] }
  viz?: { current: { widget: string; title: string } | null; catalog: string }
}

// ---------- Chat ----------
export type Role = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: Role
  text: string
  /** PNG data URL attached to a user turn (the board snapshot), if any. */
  image?: string
  /** number of elements the AI drew on the board for this turn */
  drew?: number
  /** number of equations the AI plotted on the graph for this turn */
  graphed?: number
  /** title of the interactive the AI built this turn, if any */
  built?: string
  pending?: boolean
  error?: boolean
}
