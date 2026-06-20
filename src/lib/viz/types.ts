// Visualization framework types.
//
// The architecture that fights AI generation error: the AI does NOT generate
// interactive code. It emits a tiny declarative `VizSpec` that selects a
// pre-built, tested widget and supplies only the data + narration. The widget
// owns all interaction (stepping, animation, editing, drag). Only when no
// widget fits does the AI fall back to `widget: "custom"` + self-contained HTML
// in a sandboxed iframe.

import type { FC } from 'react'
import type { VizSpec } from '../types'

export type { VizSpec }

export interface VizWidgetProps {
  spec: VizSpec
}

export interface VizWidgetDef {
  key: string
  label: string
  /** when to use it (goes into the AI prompt) */
  when: string
  /** the data/config shape, documented for the AI (goes into the prompt) */
  schema: string
  Component: FC<VizWidgetProps>
}
