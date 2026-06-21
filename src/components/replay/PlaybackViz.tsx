import { getWidget } from '../../lib/viz/registry'
import type { VizSpec } from '../../lib/types'
import '../viz/widgets.css'

// Render the visualization that was on the Learn window at this moment. It's the
// real interactive widget — a viewer can even play with it.
export default function PlaybackViz({ spec }: { spec: VizSpec | null }) {
  if (!spec) return <div className="pbviz-empty">No visualization at this point.</div>
  const def = getWidget(spec.widget)
  if (!def) return <div className="pbviz-empty">Unknown widget “{spec.widget}”.</div>
  const Widget = def.Component
  return (
    <div className="pbviz">
      {spec.title && <h3 className="pbviz__title">{spec.title}</h3>}
      <div className="pbviz__body"><Widget spec={spec} /></div>
    </div>
  )
}
