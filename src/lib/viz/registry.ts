// Widget registry — the single source of truth for what the AI can reuse.
// `catalogForPrompt()` feeds the AI an exact menu of vetted widgets + their data
// shapes, so it generates a tiny spec instead of fragile interactive code.

import BstWidget from '../../components/viz/BstWidget'
import SortWidget from '../../components/viz/SortWidget'
import CustomWidget from '../../components/viz/CustomWidget'
import type { VizWidgetDef } from './types'

export const WIDGETS: VizWidgetDef[] = [
  {
    key: 'binary-search-tree',
    label: 'Binary Search Tree',
    when: 'trees, BSTs, tree traversals (in/pre/post-order), insert/search/delete, ordered data',
    schema: 'data: { "values": number[] }  // initial insert order, e.g. [8,3,10,1,6,14]',
    Component: BstWidget,
  },
  {
    key: 'sorting',
    label: 'Sorting',
    when: 'sorting algorithms, comparisons/swaps, algorithm complexity intuition',
    schema: 'data: { "array": number[] }  config: { "algorithm": "bubble" | "selection" | "insertion" }',
    Component: SortWidget,
  },
  {
    key: 'custom',
    label: 'Custom interactive',
    when: 'ANY concept with no built-in widget above — physics, geometry, state machines, biology, economics, etc.',
    schema: 'html: string  // ONE self-contained HTML document: inline <style> + <script>, no external/CDN resources, no network. Must be genuinely interactive (buttons, sliders, drag, step-through). Keep it focused.',
    Component: CustomWidget,
  },
]

export function getWidget(key: string): VizWidgetDef | undefined {
  return WIDGETS.find((w) => w.key === key)
}

/** Human-readable menu injected into the AI's context so it reuses widgets. */
export function catalogForPrompt(): string {
  const lines = WIDGETS.map((w) => `- "${w.key}" — ${w.label}. Use for: ${w.when}.\n    ${w.schema}`)
  return lines.join('\n')
}
