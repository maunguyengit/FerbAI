import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'
import { buildPlot, PLOT_CONFIG } from '../../lib/graph'
import type { GraphEqSnap } from '../../lib/recording/types'
import type { GraphEquation } from '../../lib/types'

// Read-only graph for playback — re-plots the equations that were on the graph
// window at this moment in the recording.
export default function PlaybackGraph({ equations }: { equations: GraphEqSnap[] }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const eqs: GraphEquation[] = equations.map((e, i) => ({
      id: `pb_${i}`, raw: e.raw, color: e.color, visible: true, error: null,
    }))
    const { data, layout } = buildPlot(eqs)
    Plotly.react(el, data, layout, PLOT_CONFIG)
  }, [equations])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => Plotly.Plots.resize(el))
    ro.observe(el)
    return () => { ro.disconnect(); Plotly.purge(el) }
  }, [])

  return <div className="pbgraph" ref={ref} style={{ width: '100%', height: '100%' }} />
}
