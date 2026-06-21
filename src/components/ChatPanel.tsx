import { useEffect, useRef, useState } from 'react'
import {
  AIError,
  appendMemoryEvent,
  fetchProviderStatus,
  finalizeMemorySession,
  reviewTutorSession,
  streamChat,
  type ProviderStatus,
} from '../lib/ai'
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
const SESSION_KEY = 'ferbai.sessionId'
const USER_KEY = 'ferbai.userId'
const newSessionId = () => `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const newUserId = () => `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const TRIVIAL_QUESTION_RE = /\b(hi|hello|hey|yo|sup|what'?s up|how are you|who are you|are you there)\b/i
const LEARNING_QUESTION_RE =
  /\b(how|why|what|when|where|which|can|could|would|should|help|explain|teach|show|solve|factor|graph|plot|derive|differentiate|integrate|prove|find|calculate|simplify|balance|compare|walk me through)\b/i

function hasLegitimateQuestion(messages: ChatMessage[]) {
  return messages.some((message) => {
    if (message.role !== 'user' || message.pending || message.error) return false
    const text = String(message.text || '').replace(/\([^)]*\)/g, ' ').trim()
    if (!text) return false
    const words = text.match(/[A-Za-z0-9]+/g) || []
    if (words.length < 3) return false
    if (TRIVIAL_QUESTION_RE.test(text) && words.length <= 5) return false
    return text.includes('?') || LEARNING_QUESTION_RE.test(text)
  })
}
const getSessionId = () => {
  const existing = localStorage.getItem(SESSION_KEY)
  if (existing) return existing
  const created = newSessionId()
  localStorage.setItem(SESSION_KEY, created)
  return created
}
const getUserId = () => {
  const existing = localStorage.getItem(USER_KEY)
  if (existing) return existing
  const created = newUserId()
  localStorage.setItem(USER_KEY, created)
  return created
}

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
  const [sessionId, setSessionId] = useState(getSessionId)
  const [userId] = useState(getUserId)
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

  const endSession = async () => {
    if (busy || messages.length === 0) return
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    const summaryMsg: ChatMessage = { id: mid(), role: 'assistant', text: '', pending: true }
    const sessionMessages = messages.filter((m) => !m.pending)
    const shouldReview = hasLegitimateQuestion(sessionMessages)
    setMessages((m) => [...m, summaryMsg])
    try {
      let reviewSummary = ''
      let reviewError = ''
      if (shouldReview) {
        try {
          const review = await reviewTutorSession({
            sessionId,
            userId,
            history: sessionMessages,
            context: getContext(),
            signal: controller.signal,
          })
          reviewSummary = review.summary
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err
          reviewError = err instanceof Error ? err.message : 'Agent 2 review failed.'
        }
      }
      const { summary } = await finalizeMemorySession({
        sessionId,
        userId,
        context: getContext(),
        signal: controller.signal,
      })
      const nextSessionId = newSessionId()
      localStorage.setItem(SESSION_KEY, nextSessionId)
      setSessionId(nextSessionId)
      setMessages((m) =>
        m.map((x) =>
          x.id === summaryMsg.id
            ? {
                ...x,
                pending: false,
                text:
                  `${shouldReview ? 'Agent 2 review saved.\n\n' : 'Agent 2 review skipped: no substantive student question found.\n\n'}` +
                  (reviewSummary ? `${reviewSummary}\n\n` : reviewError ? `Agent 2 review could not be saved: ${reviewError}\n\n` : '') +
                  `Session memory saved.\n\n${summary.rolling}` +
                  (summary.nextRecommendedStep ? `\n\nNext: ${summary.nextRecommendedStep}` : ''),
              }
            : x,
        ),
      )
    } catch (err) {
      const message = err instanceof AIError ? err.message
        : err instanceof DOMException && err.name === 'AbortError' ? 'stopped.'
        : err instanceof Error ? err.message : 'Could not end this session.'
      setMessages((m) => m.map((x) => (x.id === summaryMsg.id ? { ...x, pending: false, error: true, text: message } : x)))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const reviewTutor = async () => {
    if (busy || messages.length === 0) return
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    const reviewMsg: ChatMessage = { id: mid(), role: 'assistant', text: '', pending: true }
    setMessages((m) => [...m, reviewMsg])
    try {
      const { summary } = await reviewTutorSession({
        sessionId,
        userId,
        history: messages,
        context: getContext(),
        signal: controller.signal,
      })
      setMessages((m) => m.map((x) => (x.id === reviewMsg.id ? { ...x, text: summary, pending: false } : x)))
    } catch (err) {
      const message = err instanceof AIError ? err.message
        : err instanceof DOMException && err.name === 'AbortError' ? 'stopped.'
        : err instanceof Error ? err.message : 'Could not review this session.'
      setMessages((m) =>
        m.map((x) => (x.id === reviewMsg.id ? { ...x, pending: false, error: message !== 'stopped.', text: message } : x)),
      )
    } finally {
      setBusy(false)
      abortRef.current = null
    }
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
        sessionId,
        userId,
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
      if (drew || graphed || built) {
        appendMemoryEvent({
          sessionId,
          type: 'tool_result',
          payload: { drew, graphed, built, view },
        })
      }
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
        <button className="chat__review" onClick={reviewTutor} disabled={busy || messages.length === 0}>
          Review
        </button>
        <button className="chat__review" onClick={endSession} disabled={busy || messages.length === 0}>
          End Session
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
