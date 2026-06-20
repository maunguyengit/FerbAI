import { PROVIDERS, encodeSelection, decodeSelection, getProvider, getModel } from '../lib/providers'
import './ModelSelector.css'

interface Props {
  value: string // "providerId::modelId"
  onChange: (value: string) => void
}

export default function ModelSelector({ value, onChange }: Props) {
  const { providerId, modelId } = decodeSelection(value)
  const provider = getProvider(providerId)
  const model = getModel(providerId, modelId)

  return (
    <div className="modelpill">
      <span className="modelpill__spark" aria-hidden>✦</span>
      <span className="modelpill__provider">{provider?.label ?? 'Model'}</span>
      <span className="modelpill__slash" aria-hidden>/</span>
      <span className="modelpill__model">{model?.label ?? '—'}</span>
      {model?.vision && <span className="modelpill__vision">VISION</span>}
      <span className="modelpill__caret" aria-hidden>▾</span>
      <select
        className="modelpill__select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Choose AI model"
      >
        {PROVIDERS.map((p) => (
          <optgroup key={p.id} label={p.label}>
            {p.models.map((m) => (
              <option key={m.id} value={encodeSelection(p.id, m.id)}>
                {p.label} · {m.label}{m.vision ? '  (vision)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}
