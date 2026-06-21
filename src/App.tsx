import { useEffect, useRef, useState } from 'react'
import Whiteboard from './components/Whiteboard'
import Toolbar from './components/Toolbar'
import GraphView from './components/GraphView'
import VisualizationView from './components/viz/VisualizationView'
import ReplayView from './components/replay/ReplayView'
import RecordControl from './components/RecordControl'
import ChatPanel from './components/ChatPanel'
import ModelSelector from './components/ModelSelector'
import SettingsModal from './components/SettingsModal'
import { fetchProviderStatus } from './lib/ai'
import { DEFAULT_SELECTION } from './lib/providers'
import { catalogForPrompt } from './lib/viz/registry'
import { useRecorder } from './lib/recording/useRecorder'
import { getSelection, setSelection as persistSelection } from './lib/storage'
import type { AIAction, AIGraphEquation, ChatContext, GraphHandle, Tool, View, VizHandle, VizSpec, WhiteboardHandle } from './lib/types'
import './App.css'

export default function App() {
  const wbRef = useRef<WhiteboardHandle>(null)
  const graphRef = useRef<GraphHandle>(null)
  const vizRef = useRef<VizHandle>(null)

  const [view, setView] = useState<View>('board')

  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('oklch(27% 0.008 70)')
  const [width, setWidth] = useState(3)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const [selection, setSelection] = useState(() => getSelection(DEFAULT_SELECTION))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keysVersion, setKeysVersion] = useState(0)
  const [ready, setReady] = useState(false)

  const recorder = useRecorder()

  const startRecording = () => {
    setView('board')
    recorder.start({ title: `Lesson ${recorder.recordings.length + 1}`, getElements: () => wbRef.current?.getElements() ?? [] })
  }

  useEffect(() => { persistSelection(selection) }, [selection])

  useEffect(() => {
    const ctrl = new AbortController()
    fetchProviderStatus(ctrl.signal).then((s) => setReady(Object.keys(s).length > 0))
    return () => ctrl.abort()
  }, [keysVersion])

  const download = () => {
    const url = wbRef.current?.getImageDataURL()
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = 'chalkai-board.png'
    a.click()
  }

  const closeSettings = () => {
    setSettingsOpen(false)
    setKeysVersion((v) => v + 1)
  }

  // ---- what the chat sees / acts on, based on the active view ----
  const getActiveImage = async (): Promise<string | null> => {
    if (view === 'board') return wbRef.current?.getImageDataURL() ?? null
    if (view === 'graph') return (await graphRef.current?.getImageDataURL()) ?? null
    return null // viz view: text context only
  }

  const activeEmpty = (): boolean => {
    if (view === 'board') return wbRef.current?.isEmpty() ?? true
    if (view === 'graph') return graphRef.current?.isEmpty() ?? true
    return vizRef.current?.isEmpty() ?? true
  }

  const getContext = (): ChatContext => {
    if (view === 'graph') return { mode: 'graph', graph: { dim: graphRef.current?.getDimension() ?? '2d', equations: graphRef.current?.getEquations() ?? [] } }
    if (view === 'viz') return { mode: 'viz', viz: { current: vizRef.current?.getCurrent() ?? null, catalog: catalogForPrompt() } }
    return { mode: 'board', boardMeta: wbRef.current?.getBoardMeta() ?? null }
  }

  const applyDraw = (actions: AIAction[]): number => { setView('board'); return wbRef.current?.applyAIActions(actions) ?? 0 }
  const applyGraph = (eqs: AIGraphEquation[]): number => { setView('graph'); return graphRef.current?.addEquations(eqs) ?? 0 }
  const applyViz = (spec: VizSpec): string | null => { setView('viz'); vizRef.current?.render(spec); return spec.title || spec.widget }

  const TABS: { id: View; label: string }[] = [
    { id: 'board', label: '✎ Board' },
    { id: 'graph', label: '∿ Graph' },
    { id: 'viz', label: '◆ Learn' },
    { id: 'replay', label: '▶ Replay' },
  ]

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="brand__logo" aria-hidden>
            <svg viewBox="0 0 100 100" width="34" height="34">
              <rect x="4" y="4" width="92" height="92" rx="24" fill="var(--color-ink)" />
              <path d="M24 68 L44 34 L57 60 L76 30" fill="none" stroke="var(--color-accent)"
                strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="brand__word">Chalk<span className="brand__word-ai">AI</span></span>
          <div className="viewtoggle" role="tablist" aria-label="Left panel view">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`viewtoggle__btn ${view === t.id ? 'is-on' : ''}`}
                onClick={() => setView(t.id)}
                role="tab" aria-selected={view === t.id}
              >{t.label}</button>
            ))}
          </div>
        </div>

        <div className="topbar__center">
          <ModelSelector value={selection} onChange={setSelection} />
        </div>

        <div className="topbar__right">
          <RecordControl
            status={recorder.status}
            elapsedMs={recorder.elapsedMs}
            hasAudio={recorder.hasAudio}
            onStart={startRecording}
            onStop={() => { recorder.stop().then(() => setView('replay')) }}
          />
          <span className={`ready ${ready ? 'ready--on' : 'ready--off'}`}>
            <span className="ready__dot" /> {ready ? 'ready' : 'offline'}
          </span>
          <button className="btn topbar__settings" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="API settings">⚙</button>
        </div>
      </header>

      <div className="app__work">
        <section className="app__left">
          <div className={`app__board ${view === 'board' ? '' : 'is-hidden'}`}>
            <Toolbar
              tool={tool} setTool={setTool}
              color={color} setColor={setColor}
              width={width} setWidth={setWidth}
              canUndo={canUndo} canRedo={canRedo}
              onUndo={() => wbRef.current?.undo()}
              onRedo={() => wbRef.current?.redo()}
              onClear={() => wbRef.current?.clear()}
              onDownload={download}
            />
            <div className="app__canvas-wrap">
              <Whiteboard
                ref={wbRef}
                tool={tool} color={color} width={width}
                onHistoryChange={(u, r) => { setCanUndo(u); setCanRedo(r) }}
                onBoardEvent={recorder.recordEvent}
              />
            </div>
          </div>

          <div className={`app__graph ${view === 'graph' ? '' : 'is-hidden'}`}>
            <GraphView ref={graphRef} />
          </div>

          <div className={`app__viz ${view === 'viz' ? '' : 'is-hidden'}`}>
            <VisualizationView ref={vizRef} />
          </div>

          <div className={`app__replay ${view === 'replay' ? '' : 'is-hidden'}`}>
            <ReplayView recordings={recorder.recordings} onDelete={recorder.remove} />
          </div>
        </section>

        <ChatPanel
          selection={selection}
          view={view}
          getActiveImage={getActiveImage}
          activeEmpty={activeEmpty}
          getContext={getContext}
          applyDraw={applyDraw}
          applyGraph={applyGraph}
          applyViz={applyViz}
          keysVersion={keysVersion}
        />
      </div>

      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </div>
  )
}
