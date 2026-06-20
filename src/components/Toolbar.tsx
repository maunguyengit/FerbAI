import type { Tool } from '../lib/types'
import './Toolbar.css'

interface Props {
  tool: Tool
  setTool: (t: Tool) => void
  color: string
  setColor: (c: string) => void
  width: number
  setWidth: (w: number) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
  onDownload: () => void
}

const TOOLS: { id: Tool; label: string; glyph: string; key: string }[] = [
  { id: 'pen', label: 'Pen', glyph: '✎', key: 'P' },
  { id: 'eraser', label: 'Eraser', glyph: '⌫', key: 'E' },
  { id: 'lasso', label: 'Lasso', glyph: '◌', key: 'L' },
  { id: 'text', label: 'Text', glyph: 'T', key: 'T' },
  { id: 'rect', label: 'Box', glyph: '▭', key: 'R' },
  { id: 'ellipse', label: 'Oval', glyph: '◯', key: 'O' },
  { id: 'pan', label: 'Pan', glyph: '✋', key: 'H' },
]

const SWATCHES = [
  'oklch(27% 0.008 70)',  // ink
  'oklch(61% 0.115 42)',  // terracotta
  'oklch(66% 0.05 150)',  // sage
  'oklch(80% 0.11 90)',   // yellow
  'oklch(54% 0.07 55)',   // brown
  'oklch(42% 0.06 260)',  // navy
]

export default function Toolbar({
  tool, setTool, color, setColor, width, setWidth,
  canUndo, canRedo, onUndo, onRedo, onClear, onDownload,
}: Props) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Whiteboard tools">
      <div className="toolbar__group">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool ${tool === t.id ? 'tool--on' : ''}`}
            onClick={() => setTool(t.id)}
            aria-pressed={tool === t.id}
            title={`${t.label} (${t.key})`}
          >
            <span className="tool__glyph" aria-hidden>{t.glyph}</span>
          </button>
        ))}
      </div>

      <div className="toolbar__rule" aria-hidden />

      <div className="swatches" aria-label="Color">
        {SWATCHES.map((c) => (
          <button
            key={c}
            className={`swatch ${color === c ? 'swatch--on' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
            aria-pressed={color === c}
            aria-label={`color ${c}`}
            title="Color"
          />
        ))}
      </div>

      <div className="width">
        <input
          className="width__slider"
          type="range"
          min={1}
          max={16}
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
          aria-label="Stroke width"
          title={`${width}px`}
        />
        <span className="width__label caption">{width}px</span>
      </div>

      <div className="toolbar__rule" aria-hidden />

      <div className="toolbar__group">
        <button className="tool" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <span className="tool__glyph" aria-hidden>↶</span>
        </button>
        <button className="tool" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          <span className="tool__glyph" aria-hidden>↷</span>
        </button>
        <button className="tool" onClick={onDownload} title="Download PNG">
          <span className="tool__glyph" aria-hidden>⤓</span>
        </button>
        <button className="tool tool--danger" onClick={onClear} title="Clear board">
          <span className="tool__glyph" aria-hidden>🗑</span>
        </button>
      </div>
    </div>
  )
}
