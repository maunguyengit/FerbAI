import { useEffect, useState } from 'react'
import { PROVIDERS } from '../lib/providers'
import { getApiKey, getBaseUrl, setApiKey, setBaseUrl } from '../lib/storage'
import './SettingsModal.css'

interface Props {
  open: boolean
  onClose: () => void
}

interface Draft {
  key: string
  url: string
  reveal: boolean
}

export default function SettingsModal({ open, onClose }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    const next: Record<string, Draft> = {}
    for (const p of PROVIDERS) {
      next[p.id] = { key: getApiKey(p.id), url: getBaseUrl(p.id), reveal: false }
    }
    setDrafts(next)
    setSaved(false)
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const update = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }))

  const save = () => {
    for (const p of PROVIDERS) {
      const d = drafts[p.id]
      if (!d) continue
      setApiKey(p.id, d.key)
      setBaseUrl(p.id, d.url)
    }
    setSaved(true)
    setTimeout(onClose, 550)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="API settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">SETTINGS // KEYS</h2>
          <button className="modal__x btn" onClick={onClose} aria-label="Close settings">✕</button>
        </header>

        <p className="modal__note">
          Best practice: put keys in the backend <b>.env</b> file (see <code>.env.example</code>) — they
          never reach the browser. Anything you paste <b>here</b> is stored in this browser only and
          forwarded to FerbAI's local proxy per request, overriding the <code>.env</code> key. Leave a
          field blank to use the server's key.
        </p>

        <div className="modal__body">
          {PROVIDERS.map((p) => {
            const d = drafts[p.id] ?? { key: '', url: '', reveal: false }
            return (
              <fieldset className="provider" key={p.id}>
                <legend className="provider__legend">
                  {p.label}
                  <span className="provider__type">{p.type === 'anthropic' ? 'anthropic api' : 'openai-compatible'}</span>
                </legend>

                <label className="field">
                  <span className="field__label">API key</span>
                  <div className="field__row">
                    <input
                      className="field__input"
                      type={d.reveal ? 'text' : 'password'}
                      value={d.key}
                      placeholder={p.keyHint}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => update(p.id, { key: e.target.value })}
                    />
                    <button
                      className="btn field__reveal"
                      type="button"
                      onClick={() => update(p.id, { reveal: !d.reveal })}
                      title={d.reveal ? 'Hide' : 'Show'}
                    >
                      {d.reveal ? '🙈' : '👁'}
                    </button>
                  </div>
                </label>

                <label className="field">
                  <span className="field__label">Base URL</span>
                  <input
                    className="field__input"
                    type="text"
                    value={d.url}
                    placeholder={p.defaultBaseUrl}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => update(p.id, { url: e.target.value })}
                  />
                </label>
                <p className="provider__models">
                  Models: {p.models.map((m) => m.label).join(' · ')}
                </p>
              </fieldset>
            )
          })}
        </div>

        <footer className="modal__foot">
          <span className={`modal__saved ${saved ? 'is-on' : ''}`}>✓ saved</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--accent" onClick={save}>Save keys</button>
        </footer>
      </div>
    </div>
  )
}
