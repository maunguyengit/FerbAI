import PlaybackCanvas from './PlaybackCanvas'
import PlaybackGraph from './PlaybackGraph'
import PlaybackViz from './PlaybackViz'
import type { Scene } from '../../lib/recording/types'

// Renders whichever content window was active at this moment in the recording.
// The chatbot is never part of a recording — only the content.
export default function PlaybackStage({
  scene,
  boardBounds,
}: {
  scene: Scene
  boardBounds: { x: number; y: number; w: number; h: number } | null
}) {
  if (scene.view === 'graph') return <PlaybackGraph equations={scene.equations} />
  if (scene.view === 'viz') return <PlaybackViz spec={scene.viz} />
  return <PlaybackCanvas elements={scene.elements} bounds={boardBounds} />
}
