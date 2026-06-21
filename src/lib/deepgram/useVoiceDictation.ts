import { useEffect, useRef, useState } from 'react'
import { startLive, type LiveSession } from './live'

// Push-to-talk dictation for the chat box: streams the mic to Deepgram and
// reports the running transcript (finalized text + the current interim guess).

export function useVoiceDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<LiveSession | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const finalsRef = useRef('')
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cleanup = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    sessionRef.current = null
    setListening(false)
  }

  const stop = () => {
    try { sessionRef.current?.stop() } catch { /* */ }
    cleanup()
  }

  const start = async () => {
    setError(null)
    finalsRef.current = ''
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const session = await startLive(stream, {
        onPartial: (t) => onTextRef.current((finalsRef.current + ' ' + t).trim()),
        onFinal: (t) => { finalsRef.current = (finalsRef.current + ' ' + t).trim(); onTextRef.current(finalsRef.current) },
        onError: () => setError('Voice transcription error.'),
      })
      sessionRef.current = session
      setListening(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Microphone unavailable.')
      cleanup()
    }
  }

  const toggle = () => { if (listening) stop(); else start() }

  useEffect(() => () => {
    try { sessionRef.current?.stop() } catch { /* */ }
    streamRef.current?.getTracks().forEach((t) => t.stop())
  }, [])

  return { listening, error, toggle, stop }
}
