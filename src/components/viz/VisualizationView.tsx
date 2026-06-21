import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { getWidget } from '../../lib/viz/registry'
import type { VizHandle, VizSpec } from '../../lib/types'
import './VisualizationView.css'
import './widgets.css'

// Local starter specs so the user can explore instantly without asking the AI.
const STARTERS: { label: string; spec: VizSpec }[] = [
  { label: 'Binary search trees', spec: { widget: 'binary-search-tree', title: 'Binary Search Trees', intro: 'Insert, search, remove, and traverse. Step through each comparison.', data: { values: [8, 3, 10, 1, 6, 14, 4, 7, 13] } } },
  { label: 'Bubble sort', spec: { widget: 'sorting', title: 'Bubble Sort', intro: 'Watch adjacent pairs swap until the array is ordered.', data: { array: [5, 2, 8, 1, 9, 3, 7, 4, 6] }, config: { algorithm: 'bubble' } } },
  { label: 'Selection sort', spec: { widget: 'sorting', title: 'Selection Sort', intro: 'Pick the smallest remaining item and place it.', data: { array: [7, 3, 9, 2, 8, 4, 6, 1, 5] }, config: { algorithm: 'selection' } } },
]

interface VizViewProps {
  /** report spec changes so a recording can capture the learn window */
  onSpecChange?: (spec: VizSpec | null) => void
}

const VisualizationView = forwardRef<VizHandle, VizViewProps>(function VisualizationView({ onSpecChange }, ref) {
  const [spec, setSpec] = useState<VizSpec | null>(null)
  const specRef = useRef<VizSpec | null>(null)
  specRef.current = spec
  const onSpecChangeRef = useRef(onSpecChange)
  onSpecChangeRef.current = onSpecChange

  useEffect(() => { onSpecChangeRef.current?.(spec) }, [spec])

  useImperativeHandle(ref, (): VizHandle => ({
    render: (s) => setSpec(s),
    isEmpty: () => specRef.current === null,
    getCurrent: () => specRef.current ? { widget: specRef.current.widget, title: specRef.current.title || specRef.current.widget } : null,
  }))

  const def = spec ? getWidget(spec.widget) : undefined
  const Widget = def?.Component

  return (
    <div className="vizview">
      <header className="vizview__head">
        <div className="vizview__title-wrap">
          <span className="vizview__spark" aria-hidden>◆</span>
          <h3 className="vizview__title">{spec?.title || 'Visualization'}</h3>
        </div>
        {spec && <button className="vizview__clear" onClick={() => setSpec(null)}>Clear</button>}
      </header>

      {spec?.intro && <p className="vizview__intro">{spec.intro}</p>}

      <div className="vizview__body">
        {spec && Widget ? (
          <Widget spec={spec} />
        ) : spec && !Widget ? (
          <div className="viz-empty">
            <p className="viz-empty__big">Unknown widget “{spec.widget}”.</p>
            <p>The AI asked for a visualization this build doesn't have.</p>
          </div>
        ) : (
          <div className="viz-empty">
            <p className="viz-empty__big">Learn by doing, not watching.</p>
            <p>Ask the tutor to <b>teach you a concept</b> — it builds an interactive you can step through, edit, and explore. Or start one now:</p>
            <div className="viz-empty__chips">
              {STARTERS.map((s) => (
                <button key={s.label} className="viz-empty__chip" onClick={() => setSpec(s.spec)}>{s.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

export default VisualizationView
