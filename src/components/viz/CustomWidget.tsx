import { useMemo } from 'react'
import type { VizWidgetProps } from '../../lib/viz/types'

// Escape hatch: render AI-authored self-contained HTML in a sandboxed iframe.
// sandbox allows scripts but NOT same-origin, so it cannot touch the app,
// cookies, or storage. Used only when no built-in widget fits.

const BASE = `<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    color: #2c2823; background: #f1eee7;
  }
  button {
    font: inherit; font-weight: 600; cursor: pointer;
    background: #c4694a; color: #fff; border: 2px solid #2c2823;
    border-radius: 8px; padding: 6px 12px;
  }
  button.secondary { background: #f4f1ea; color: #2c2823; }
  input, select { font: inherit; padding: 4px 8px; border: 2px solid #2c2823; border-radius: 6px; background: #fff; }
  svg { max-width: 100%; }
</style>`

export default function CustomWidget({ spec }: VizWidgetProps) {
  const srcDoc = useMemo(() => {
    const html = spec.html || '<p>No content provided.</p>'
    // if the model already supplied a full document, leave it; else wrap it
    if (/<html[\s>]/i.test(html)) return html
    return `<!doctype html><html><head><meta charset="utf-8">${BASE}</head><body>${html}</body></html>`
  }, [spec.html])

  return (
    <div className="viz">
      <div className="viz-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>⚡ AI-generated interactive · sandboxed</span>
      </div>
      <iframe
        title={spec.title || 'AI visualization'}
        sandbox="allow-scripts allow-pointer-lock"
        srcDoc={srcDoc}
        style={{
          flex: 1, minHeight: 0, width: '100%', border: '2px solid var(--color-ink)',
          borderRadius: 'var(--radius)', background: 'var(--color-paper-2)',
        }}
      />
    </div>
  )
}
