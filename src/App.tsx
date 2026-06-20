import { useEffect, useRef, useState } from 'react'
import Whiteboard from './components/Whiteboard'
import Toolbar from './components/Toolbar'
import ChatPanel from './components/ChatPanel'
import ModelSelector from './components/ModelSelector'
import SettingsModal from './components/SettingsModal'
import { fetchProviderStatus } from './lib/ai'
import { DEFAULT_SELECTION } from './lib/providers'
import { getSelection, setSelection as persistSelection } from './lib/storage'
import type { Tool, WhiteboardHandle } from './lib/types'
import './App.css'

export default function App() {
  const wbRef = useRef<WhiteboardHandle>(null)

  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('oklch(27% 0.008 70)')
  const [width, setWidth] = useState(3)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const [selection, setSelection] = useState(() => getSelection(DEFAULT_SELECTION))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keysVersion, setKeysVersion] = useState(0)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    persistSelection(selection)
  }, [selection])

  // backend reachability → the "ready" pill in the top bar
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
          <span className="brand__tag caption">draw · learn</span>
        </div>

        <div className="topbar__center">
          <ModelSelector value={selection} onChange={setSelection} />
        </div>

        <div className="topbar__right">
          <span className={`ready ${ready ? 'ready--on' : 'ready--off'}`}>
            <span className="ready__dot" /> {ready ? 'ready' : 'offline'}
          </span>
          <button className="btn topbar__settings" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="API settings">
            ⚙
          </button>
        </div>
      </header>

      <div className="app__work">
        <section className="app__board">
          <Toolbar
            tool={tool}
            setTool={setTool}
            color={color}
            setColor={setColor}
            width={width}
            setWidth={setWidth}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={() => wbRef.current?.undo()}
            onRedo={() => wbRef.current?.redo()}
            onClear={() => wbRef.current?.clear()}
            onDownload={download}
          />
          <div className="app__canvas-wrap">
            <Whiteboard
              ref={wbRef}
              tool={tool}
              color={color}
              width={width}
              onHistoryChange={(u, r) => { setCanUndo(u); setCanRedo(r) }}
            />
          </div>
        </section>

        <ChatPanel
          selection={selection}
          getBoardImage={() => wbRef.current?.getImageDataURL() ?? null}
          boardEmpty={() => wbRef.current?.isEmpty() ?? true}
          getBoardMeta={() => wbRef.current?.getBoardMeta() ?? null}
          drawOnBoard={(actions) => wbRef.current?.applyAIActions(actions) ?? 0}
          keysVersion={keysVersion}
        />
      </div>

      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </div>
  )
}
