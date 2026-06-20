import { useEffect, useRef, useState } from 'react'
import { AIError, fetchProviderStatus, streamChat, type ProviderStatus } from '../lib/ai'
import { decodeSelection, getModel, getProvider } from '../lib/providers'
import { getApiKey } from '../lib/storage'
import { parseReply } from '../lib/drawblock'
import type { AIAction, BoardMeta, ChatMessage } from '../lib/types'
import './ChatPanel.css'

interface Props {
  selection: string
  getBoardImage: () => string | null
  boardEmpty: () => boolean
  getBoardMeta: () => BoardMeta | null
  drawOnBoard: (actions: AIAction[]) => number
  /** bump to re-read backend key status after settings close */
  keysVersion: number
}

let msgSeq = 0
const mid = () => `m_${Date.now().toString(36)}_${msgSeq++}`

export default function ChatPanel({
  selection, getBoardImage, boardEmpty, getBoardMeta, drawOnBoard, keysVersion,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [includeBoard, setIncludeBoard] = useState(true)
  const [aiDraws, setAiDraws] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ProviderStatus>({})
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { providerId, modelId } = decodeSelection(selection)
  const provider = getProvider(providerId)
  const model = getModel(providerId, modelId)
  const hasKey = !!status[providerId]?.configured || !!getApiKey(providerId)
  const visionOn = !!model?.vision

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
    const attach = includeBoard && visionOn && !boardEmpty()
    if (!text && !attach) return

    if (!hasKey) {
      setMessages((m) => [
        ...m,
        { id: mid(), role: 'assistant', error: true, text: `No API key for ${provider?.label}. Open Settings (⚙ top-right) and add your key.` },
      ])
      return
    }

    const image = attach ? getBoardImage() : null
    const boardMeta = getBoardMeta()
    const userMsg: ChatMessage = {
      id: mid(),
      role: 'user',
      text: text || '(reading my board — what next?)',
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
        boardMeta,
        wantDraw: aiDraws && !boardEmpty(),
        signal: controller.signal,
        onToken: (delta) => {
          full += delta
          const { clean } = parseReply(full)
          setMessages((m) => m.map((x) => (x.id === assistantMsg.id ? { ...x, text: clean } : x)))
        },
      })
      const { clean, actions } = parseReply(full)
      let drew = 0
      if (actions && actions.length) drew = drawOnBoard(actions)
      const finalText = clean || (drew ? '✎ Added that to your board.' : '')
      setMessages((m) =>
        m.map((x) => (x.id === assistantMsg.id ? { ...x, text: finalText, drew, pending: false } : x)),
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
    <aside className="chat">
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
            <p className="chat__intro-big">Draw a problem.<br />I read the board.<br />I write the next step <b>on it</b>.</p>
            <ul className="chat__intro-list">
              <li>Sketch your math, diagram, or plan on the left.</li>
              <li>Pick a <b>vision</b> model up top so I can see the board.</li>
              <li>Hit <b>Send</b> — I'll guide you <i>and</i> draw the next step in the empty space.</li>
            </ul>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role} ${m.error ? 'msg--error' : ''}`}>
            {m.role === 'assistant' && <span className="msg__avatar" aria-hidden>✦</span>}
            <div className="msg__col">
              {m.image && (
                <figure className="msg__snap">
                  <img src={m.image} alt="board snapshot" />
                </figure>
              )}
              {(m.text || m.pending) && (
                <div className="msg__bubble">
                  {m.text && <p className="msg__text">{m.text}</p>}
                  {m.pending && !m.text && <span className="msg__dots"><i /><i /><i /></span>}
                  {m.pending && m.text && <span className="msg__caret" />}
                </div>
              )}
              {!m.pending && !!m.drew && (
                <span className="msg__drew">✎ drew {m.drew} thing{m.drew > 1 ? 's' : ''} on the board</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="chat__compose">
        <div className="chat__toggles">
          <label className={`toggle ${!visionOn ? 'toggle--off' : ''}`}>
            <input type="checkbox" checked={includeBoard} onChange={(e) => setIncludeBoard(e.target.checked)} disabled={!visionOn} />
            <span>{visionOn ? 'board snapshot attached' : 'model has no vision'}</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={aiDraws} onChange={(e) => setAiDraws(e.target.checked)} />
            <span>✎ AI draws on board</span>
          </label>
        </div>
        <div className="chat__inputrow">
          <textarea
            className="chat__input"
            value={input}
            placeholder="Ask about what's on the board…"
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
      </div>
    </aside>
  )
}
