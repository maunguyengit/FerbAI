import type { RecorderStatus } from '../lib/recording/types'

interface Props {
  status: RecorderStatus
  elapsedMs: number
  hasAudio: boolean
  onStart: () => void
  onStop: () => void
}

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function RecordControl({ status, elapsedMs, hasAudio, onStart, onStop }: Props) {
  if (status === 'recording') {
    return (
      <button className="reccontrol reccontrol--rec" onClick={onStop} title="Stop recording">
        <span className="reccontrol__dot" />
        <span className="reccontrol__time">{fmt(elapsedMs)}</span>
        <span className="reccontrol__label">{hasAudio ? 'Stop' : 'Stop · silent'}</span>
      </button>
    )
  }
  return (
    <button className="reccontrol" onClick={onStart} title="Record a lesson">
      <span className="reccontrol__bullet" />
      <span className="reccontrol__label">Record</span>
    </button>
  )
}
