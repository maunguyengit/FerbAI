import { useEffect, useRef, useState } from 'react'
import { AIError, fetchProviderStatus, streamChat, type ProviderStatus } from '../lib/ai'
import { decodeSelection, getModel, getProvider } from '../lib/providers'
import { getApiKey } from '../lib/storage'
import { parseReply } from '../lib/drawblock'
import { deepgramConfigured } from '../lib/deepgram/live'
import { useVoiceDictation } from '../lib/deepgram/useVoiceDictation'
import type { AIAction, AIGraphEquation, ChatContext, ChatMessage, View, VizSpec } from '../lib/types'
import './ChatPanel.css'

interface Props {
  open: boolean
  selection: string
  view: View
  getActiveImage: () => Promise<string | null>
  activeEmpty: () => boolean
  getContext: () => ChatContext
  applyDraw: (actions: AIAction[]) => number
  applyGraph: (eqs: AIGraphEquation[]) => number
  applyViz: (spec: VizSpec) => string | null
  keysVersion: number
}

let msgSeq = 0
const mid = () => `m_${Date.now().toString(36)}_${msgSeq++}`

export default function ChatPanel({
  open, selection, view, getActiveImage, activeEmpty, getContext, applyDraw, applyGraph, applyViz, keysVersion,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [includeBoard, setIncludeBoard] = useState(true)
  const [aiActs, setAiActs] = useState(true)
  const [voiceOn, setVoiceOn] = useState(false)

  // voice dictation: holds the text typed before the mic was pressed, and
  // appends the live transcript to it.
  const dictatePrefixRef = useRef('')
  const voice = useVoiceDictation((text) => {
    const prefix = dictatePrefixRef.current
    setInput(prefix ? `${prefix} ${text}` : text)
  })
  useEffect(() => { deepgramConfigured().then(setVoiceOn) }, [])
  const toggleVoice = () => {
    if (!voice.listening) dictatePrefixRef.current = input.trim()
    voice.toggle()
  }
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ProviderStatus>({})
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { providerId, modelId } = decodeSelection(selection)
  const provider = getProvider(providerId)
  const model = getModel(providerId, modelId)
  const hasKey = !!status[providerId]?.configured || !!getApiKey(providerId)
  const visionOn = !!model?.vision
  const onGraph = view === 'graph'
  const onViz = view === 'viz'

  useEffect(() => {
    const ctrl = new AbortController()
    fetchProviderStatus(ctrl.signal).then(setStatus)
    return () => ctrl.abort()
  }, [keysVersion])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setMessages((m) => m.map((x) => (x.pending ? { ...x, pending: false } : x)))
  }

  const clearChat = () => {
    if (busy) return
    setMessages([])
  }

  const send = async () => {
    if (busy) return
    const text = input.trim()
    const attach = includeBoard && visionOn && !activeEmpty()
    if (!text && !attach) return

    if (!hasKey) {
      setMessages((m) => [
        ...m,
        { id: mid(), role: 'assistant', error: true, text: `No API key for ${provider?.label}. Open Settings (⚙ top-right) and add your key.` },
      ])
      return
    }

    const image = attach ? await getActiveImage() : null
    const context = getContext()
    const userMsg: ChatMessage = {
      id: mid(),
      role: 'user',
      text: text || (onViz ? '(build me something interactive to learn this)' : onGraph ? '(look at my graph — what next?)' : '(reading my board — what next?)'),
      image: image ?? undefined,
    }
    const assistantMsg: ChatMessage = { id: mid(), role: 'assistant', text: '', pending: true }

    const history = [...messages, userMsg]
    setMessages([...history, assistantMsg])
    setInput('')
    setBusy(true)

    const controller = new AbortController()
    abortRef.current = controller

    let full = ''
    try {
      await streamChat({
        providerId,
        modelId,
        history,
        imageDataURL: image,
        context,
        wantAct: aiActs,
        signal: controller.signal,
        onToken: (delta) => {
          full += delta
          const { clean } = parseReply(full)
          setMessages((m) => m.map((x) => (x.id === assistantMsg.id ? { ...x, text: clean } : x)))
        },
      })
      const { clean, actions, graph, viz } = parseReply(full)
      let drew = 0
      let graphed = 0
      let built: string | undefined
      if (actions && actions.length) drew = applyDraw(actions)
      if (graph && graph.length) graphed = applyGraph(graph)
      if (viz) built = applyViz(viz) ?? undefined
      const fallback = drew ? '✎ Added that to your board.' : graphed ? '∿ Plotted that on the graph.' : built ? `◆ Built an interactive: ${built}.` : ''
      setMessages((m) =>
        m.map((x) => (x.id === assistantMsg.id ? { ...x, text: clean || fallback, drew, graphed, built, pending: false } : x)),
      )
    } catch (err) {
      const message = err instanceof AIError ? err.message
        : err instanceof DOMException && err.name === 'AbortError' ? '⏹ stopped.'
        : err instanceof Error ? err.message : 'Something went wrong.'
      setMessages((m) =>
        m.map((x) =>
          x.id === assistantMsg.id
            ? { ...x, pending: false, error: message !== '⏹ stopped.', text: x.text || message }
            : x,
        ),
      )
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <aside className={`chat ${open ? '' : 'is-hidden'}`}>
      <header className="chat__head">
        <div className="chat__head-title">
          <span className="chat__spark" aria-hidden>✦</span>
          <h2 className="chat__title">Tutor</h2>
        </div>
        <span className="chat__model caption" title={`${provider?.label} · ${model?.label}`}>
          {provider?.label} · {model?.label}
        </span>
        <button className="chat__clear" onClick={clearChat} disabled={busy || messages.length === 0}>
          Clear AI
        </button>
      </header>

      {!hasKey && (
        <div className="chat__warn caption">○ no key for {provider?.label} — add it in Settings (⚙)</div>
      )}

      <div className="chat__log" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat__intro">
            <p className="chat__intro-big">Draw it. Graph it. <b>Play</b> with it.</p>
            <ul className="chat__intro-list">
              <li><b>Board:</b> sketch a problem — I write the next step on it.</li>
              <li><b>Graph:</b> "plot the derivative of x³+3x²" or "graph x²+y²+z²=9".</li>
              <li><b>Learn:</b> "teach me binary search trees" — I build an interactive you step through and edit.</li>
            </ul>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role} ${m.error ? 'msg--error' : ''}`}>
            {m.role === 'assistant' && <span className="msg__avatar" aria-hidden>✦</span>}
            <div className="msg__col">
              {m.image && (
                <figure className="msg__snap"><img src={m.image} alt="snapshot" /></figure>
              )}
              {(m.text || m.pending) && (
                <div className="msg__bubble">
                  {m.text && <p className="msg__text">{m.text}</p>}
                  {m.pending && !m.text && <span className="msg__dots"><i /><i /><i /></span>}
                  {m.pending && m.text && <span className="msg__caret" />}
                </div>
              )}
              {!m.pending && !!m.drew && (
                <span className="msg__act">✎ drew {m.drew} thing{m.drew > 1 ? 's' : ''} on the board</span>
              )}
              {!m.pending && !!m.graphed && (
                <span className="msg__act">∿ plotted {m.graphed} function{m.graphed > 1 ? 's' : ''}</span>
              )}
              {!m.pending && !!m.built && (
                <span className="msg__act">◆ built interactive · {m.built}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="chat__compose">
        <div className="chat__toggles">
          {!onViz && (
            <label className={`toggle ${!visionOn ? 'toggle--off' : ''}`}>
              <input type="checkbox" checked={includeBoard} onChange={(e) => setIncludeBoard(e.target.checked)} disabled={!visionOn} />
              <span>{visionOn ? `${onGraph ? 'graph' : 'board'} snapshot attached` : 'model has no vision'}</span>
            </label>
          )}
          <label className="toggle">
            <input type="checkbox" checked={aiActs} onChange={(e) => setAiActs(e.target.checked)} />
            <span>{onViz ? '◆ AI builds interactives' : onGraph ? '∿ AI plots on graph' : '✎ AI draws on board'}</span>
          </label>
        </div>
        <div className="chat__inputrow">
          {voiceOn && (
            <button
              className={`btn chat__mic ${voice.listening ? 'chat__mic--on' : ''}`}
              onClick={toggleVoice}
              title={voice.listening ? 'Stop dictation' : 'Talk to the AI'}
              aria-label="voice input"
            >{voice.listening ? '◉' : '🎙'}</button>
          )}
          <textarea
            className="chat__input"
            value={input}
            placeholder={voice.listening ? 'Listening… speak now' : onViz ? 'Ask me to teach you a concept…' : onGraph ? 'Ask me to graph something…' : "Ask about what's on the board…"}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button className="btn btn--danger chat__send" onClick={stop} title="Stop">⏹</button>
          ) : (
            <button className="btn btn--accent chat__send" onClick={send} title="Send (Enter)">➤ Send</button>
          )}
        </div>
        {voice.error && <p className="chat__voiceerr caption">{voice.error}</p>}
      </div>
    </aside>
  )
}
